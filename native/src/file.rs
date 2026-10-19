//! Native file-operation capabilities. All paths are host-resolved absolute paths;
//! this module never invokes a shell and never follows links.
use crate::contract::{Failure, Request, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use fs2::FileExt;
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt as WindowsMetadataExt;

const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 128;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Ceiling for one worker response. The host collects worker stdout with
/// `maxBytes: 128 * 1024` and turns a lossy read into `OUTPUT_LIMIT` plus
/// `effectState: "unknown"`, so a response that overflows is reported to the model
/// as an operation whose effect cannot be known — for a pure read, that is both
/// false and useless. Staying under the host cap is what keeps a read honest.
/// The budget is spent on the *serialized* items rather than the payload, because
/// escaping is the multiplier: one NUL byte costs six as `\u0000`, which is how a
/// 32 MiB file once produced 200 MB of stdout.
const MAX_OUTPUT_BYTES: usize = 96 * 1024;
/// Non-item fields of the envelope, counted against the same ceiling.
const ENVELOPE_OVERHEAD: usize = 512;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InspectArgs {
    path: String,
    #[serde(default = "one")]
    offset: usize,
    #[serde(default = "two_hundred")]
    limit: usize,
    #[serde(default = "utf8")]
    encoding: String,
    #[serde(default = "text")]
    view: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GlobArgs {
    path: String,
    pattern: Vec<String>,
    #[serde(default)]
    output_mode: String,
    #[serde(default)]
    sort: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "one_hundred")]
    limit: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GrepArgs {
    path: String,
    pattern: String,
    #[serde(default)]
    glob: Vec<String>,
    #[serde(default)]
    output_mode: String,
    #[serde(default)]
    case_insensitive: bool,
    #[serde(default = "yes")]
    line_numbers: bool,
    #[serde(default)]
    before_context: usize,
    #[serde(default)]
    after_context: usize,
    #[serde(default)]
    multiline: bool,
    #[serde(default)]
    offset: usize,
    #[serde(default = "one_hundred")]
    limit: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplaceArgs {
    path: String,
    pattern: String,
    replacement: String,
    #[serde(default)]
    glob: Vec<String>,
    #[serde(default = "one_hundred")]
    max_replacements: usize,
    #[serde(default)]
    dry_run: bool,
}
fn one() -> usize { 1 }
fn two_hundred() -> usize { 200 }
fn one_hundred() -> usize { 100 }
fn yes() -> bool { true }
fn utf8() -> String { "utf-8".into() }
fn text() -> String { "text".into() }

pub fn dispatch(request: &Request) -> Result<Value> {
    if let Some(raw) = request.args.get("path").and_then(Value::as_str) { request.authorize_path(Path::new(raw))?; }
    match request.tool.as_str() {
        "inspect_local_file" => inspect(request),
        "glob" => glob(request),
        "grep" => grep(request),
        "replace" => replace(request),
        "stat" | "diff" | "write_file" | "edit_file" | "copy" | "move" | "remove" => single::run(request),
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown file capability")),
    }.map_err(|mut error| { error.message = format!("{}: {}", request.tool, error.message); error })
}

fn target(raw: &str, _allow_missing: bool) -> Result<PathBuf> {
    Ok(crate::file_path::checked(raw)?.display)
}
fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}
fn hidden(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).ok().into_iter().flat_map(|p| p.components()).any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}
fn host_link_or_reparse(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else { return true };
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 { return true; }
    false
}
struct WalkResult {
    files: Vec<PathBuf>,
    truncated: bool,
}

fn walk(root: &Path, request: &Request) -> Result<WalkResult> {
    request.authorize_path(root)?;
    let target = crate::file_path::checked(root.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?)?;
    let directory = target.parent.open_dir_nofollow(&target.name)?;
    let mut files = Vec::new();
    let mut truncated = false;
    visit_dir(root, root, directory, 0, request, &mut files, &mut truncated)?;
    Ok(WalkResult { files, truncated })
}
fn visit_dir(root: &Path, display: &Path, directory: cap_std::fs::Dir, depth: usize, request: &Request, output: &mut Vec<PathBuf>, truncated: &mut bool) -> Result<()> {
    if depth > MAX_DEPTH || output.len() >= MAX_ENTRIES {
        *truncated = true;
        return Ok(());
    }
    let mut names = Vec::new();
    // A directory can change while it is being read. A broken child directory
    // is skipped, while failure to enumerate the requested root remains visible.
    let entries = match directory.entries() {
        Ok(entries) => entries,
        Err(error) if depth == 0 => return Err(error.into()),
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        names.push(name);
    }
    names.sort();
    for name in names {
        if crate::file_path::validate_name(&name).is_err() || name == ".git" { continue; }
        let metadata = match directory.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if crate::file_path::link(&metadata) { continue; }
        let child = display.join(&name);
        if host_link_or_reparse(&child) { continue; }
        // A denied root is skipped by identity, not by name: the host names the
        // credential locations and the worker stays out of them entirely, so a
        // traversal cannot even report a private key below one.
        if request.denies_path(&child) { continue; }
        if hidden(&child, root) || matches!(name.as_str(), ".git" | ".dsh-ops" | "node_modules" | "target" | ".venv") { continue; }
        if metadata.is_file() {
            if output.len() >= MAX_ENTRIES { *truncated = true; return Ok(()); }
            output.push(child);
            continue;
        }
        if metadata.is_dir() {
            let Ok(child_dir) = directory.open_dir_nofollow(&name) else { continue };
            visit_dir(root, &child, child_dir, depth + 1, request, output, truncated)?;
            if *truncated && output.len() >= MAX_ENTRIES { return Ok(()); }
        }
    }
    Ok(())
}
fn positive_patterns(patterns: &[String]) -> impl Iterator<Item = &String> { patterns.iter().filter(|p| !p.starts_with('!')) }
fn matches_any(root: &Path, file: &Path, patterns: &[String]) -> bool {
    let name = relative_display(root, file);
    let positives: Vec<_> = positive_patterns(patterns).collect();
    let included = positives.is_empty() || positives.iter().any(|p| glob_match(p, &name));
    let excluded = patterns.iter().filter_map(|p| p.strip_prefix('!')).any(|p| glob_match(p, &name));
    included && !excluded
}
fn files_for(path: &str, patterns: &[String], request: &Request) -> Result<WalkResult> {
    let root = target(path, false)?;
    request.authorize_path(&root)?;
    if root.is_file() {
        return Ok(WalkResult { files: vec![root.clone()], truncated: false });
    }
    let walked = walk(&root, request)?;
    Ok(WalkResult {
        files: walked.files.into_iter()
            .filter(|f| matches_any(&root, f, patterns))
            .collect(),
        truncated: walked.truncated,
    })
}
fn glob_match(pattern: &str, value: &str) -> bool {
    let p: Vec<_> = pattern.trim_start_matches("./").split('/').collect();
    let v: Vec<_> = value.split('/').collect();
    glob_segments(&p, &v)
}
fn glob_segments(p: &[&str], v: &[&str]) -> bool {
    if p.is_empty() { return v.is_empty(); }
    if p[0] == "**" { return glob_segments(&p[1..], v) || (!v.is_empty() && glob_segments(p, &v[1..])); }
    !v.is_empty() && segment_match(p[0], v[0]) && glob_segments(&p[1..], &v[1..])
}
fn segment_match(pattern: &str, value: &str) -> bool {
    let (mut pi, mut vi, mut star, mut mark) = (0usize, 0usize, None, 0usize);
    let p = pattern.as_bytes(); let v = value.as_bytes();
    while vi < v.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi].eq_ignore_ascii_case(&v[vi])) { pi += 1; vi += 1; }
        else if pi < p.len() && p[pi] == b'*' { star = Some(pi); pi += 1; mark = vi; }
        else if let Some(s) = star { pi = s + 1; mark += 1; vi = mark; }
        else { return false; }
    }
    while pi < p.len() && p[pi] == b'*' { pi += 1; }
    pi == p.len()
}
fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    let raw = path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let target = crate::file_path::checked(raw).map_err(|mut error| { error.message = format!("read path validation: {}", error.message); error })?;
    let mut file = crate::file_path::read_file(&target).map_err(|mut error| { error.message = format!("read open: {}", error.message); error })?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file).take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err(Failure::new("OUTPUT_LIMIT", "File exceeds the bounded read budget")); }
    Ok(bytes)
}
/// Modification time of `metadata` in whole milliseconds since the Unix epoch,
/// or `None` when the platform will not report one.
///
/// This is the file tools' one definition of a timestamp quantity: `ops_stat`'s
/// `modifiedMs` and `ops_glob`'s `modified` describe the same instant the same
/// way, so the two cannot drift into different units. Milliseconds since the
/// epoch carry no timezone, and they are what `stat -c %Y` reports as whole
/// seconds — the same instant, at the resolution a single-second field loses.
fn modified_ms(metadata: &fs::Metadata) -> Option<u128> {
    metadata.modified().ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_millis())
}
/// Last modification time of one path, in milliseconds since the Unix epoch.
///
/// `symlink_metadata`, not `metadata`: this module never follows links, and a
/// link, junction or reparse entry is refused before it can become a candidate
/// (`host_link_or_reparse`, `file_path::link`), so no `ops_glob` item is a link
/// and "the link or its target" cannot arise in a result. Probing the entry
/// itself keeps the timestamp probe consistent with every other path probe
/// here; a caller that needs the target of a link asks `ops_stat`, which opens
/// the file and reports the opened inode's time.
///
/// This used to return `symlink_metadata(..).len()` — the byte count — so
/// `details.modified` was a second copy of `details.bytes` and
/// `sort: "modified"` ordered by file size and never by time (#236, reproduced
/// in #204 P2). `None`, not `0`, is the honest answer for a time the
/// filesystem cannot report or one that predates the epoch; `ops_stat` reports
/// the same `null` there, so both tools answer "unknown" the same way.
fn modified(path: &Path) -> Option<u128> { fs::symlink_metadata(path).ok().as_ref().and_then(modified_ms) }
/// Order candidates for `sort: "modified"`: newest first, an unreadable time
/// last, equal times in the walk's path order.
///
/// `Reverse` keeps the direction the size-based key already produced
/// (descending), so this fix changes the key, not the ordering contract. The
/// sort is stable (`sort_by_key`), so equal timestamps — a coarse clock, a copy
/// that preserves a timestamp, two writes inside one second — keep the path
/// order the walk produced instead of reshuffling between identical calls.
/// `Reverse(None)` sorts last because `None` is below every `Some`.
fn sort_by_modified(files: &mut [PathBuf]) { files.sort_by_key(|file| std::cmp::Reverse(modified(file))); }
/// One `details` item: the path, its on-disk size, and its modification time as
/// an epoch-millisecond number (`null` when unreadable). The size is a size and
/// the time is a time; neither stands in for the other.
fn details(file: &Path) -> Value {
    json!({"path":file,"bytes":fs::symlink_metadata(file).map(|metadata| metadata.len()).unwrap_or(0),"modified":modified(file)})
}
/// What one character costs in serde_json's encoding.
fn encoded_cost(character: char) -> usize {
    match character {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}
/// The longest prefix of `text` whose encoding fits `budget` bytes, cut on a
/// character boundary so the result is still valid UTF-8.
fn truncate_to_encoded(text: &str, budget: usize) -> (String, bool) {
    let mut kept = String::new(); let mut used = 0usize;
    for character in text.chars() { let cost = encoded_cost(character); if used + cost > budget { return (kept, true); } used += cost; kept.push(character); }
    (kept, false)
}
/// `offset` is how many units were skipped, counted from zero the way `glob` and
/// `grep` count their own `offset`. `next_base` is the value a caller must pass
/// back to resume, which is its own paging base rather than the skipped count:
/// `inspect` declares a 1-based `offset` (like its hex rows), so deriving the
/// next page from the skipped count re-read the last returned line on every page.
fn result(items: Vec<Value>, total: usize, offset: usize, next_base: usize, matched: usize, truncated: bool) -> Value {
    // Spend the response budget on the serialized items. Returning more than the
    // host will collect is not a bigger answer, it is a failed read: the host
    // truncates stdout, reports OUTPUT_LIMIT and declares the effect unknown, so
    // the caller loses the content and is told something may have changed.
    let budget = MAX_OUTPUT_BYTES.saturating_sub(ENVELOPE_OVERHEAD);
    let mut kept: Vec<Value> = Vec::new(); let mut used = 0usize; let mut stopped = false;
    for item in items {
        let size = serde_json::to_string(&item).map_or(0, |encoded| encoded.len()) + 1;
        if used + size <= budget { used += size; kept.push(item); continue; }
        // This item does not fit whole. Keep a bounded prefix of its text rather
        // than returning nothing at all, so a file holding one long line still
        // answers with its beginning; every remaining item is omitted and counted
        // as such. Reading past the cut is the hex view's job, which pages by
        // 16-byte rows.
        let whole = item.get("text").and_then(Value::as_str);
        let room = budget.saturating_sub(used).saturating_sub(96);
        let prefix = whole.map(|text| truncate_to_encoded(text, room));
        if let Some((text, cut)) = prefix {
            if !text.is_empty() {
                let mut trimmed = item.clone();
                trimmed["text"] = Value::String(text);
                trimmed["bytesTotal"] = json!(whole.map_or(0, |text| text.len()));
                trimmed["truncatedInLine"] = json!(cut);
                kept.push(trimmed);
            }
        }
        stopped = true;
        break;
    }
    let returned = kept.len(); let cut = truncated || stopped;
    json!({"status":"completed","phase":"verify","changed":0,"matched":matched,"skipped":offset,"failed":0,"complete":!cut && offset + returned >= total,"truncated":cut,"omitted":total.saturating_sub(offset + returned),"items":kept,"total":total,"nextOffset":next_base + returned})
}

fn inspect(request: &Request) -> Result<Value> {
    let args: InspectArgs = serde_json::from_value(request.args.clone())?;
    if args.limit == 0 || args.limit > 10_000 || !args.encoding.eq_ignore_ascii_case("utf-8") { return Err(Failure::new("INVALID_ARGUMENT", "inspect supports UTF-8 and a bounded limit")); }
    let path = target(&args.path, false)?;
    if !path.is_file() { return Err(Failure::new("INVALID_ARGUMENT", "path is a directory; use ops_glob or ops_grep")); }
    let bytes = read_bytes(&path)?;
    let facts = content_facts(&bytes);
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err(Failure::new("OUTPUT_LIMIT", "file exceeds the inspect size budget")); }
    if args.view == "hex" {
        // `offset` means the same thing in both views: the 1-based unit to start
        // from — line N for text, 16-byte row N for hex. It used to count rows
        // from zero here while the text branch counted lines from one, so the
        // declared default of 1 skipped the first row, and the declared
        // `minimum: 1` left no way to ask for it back: any file of at most 16
        // bytes read back as an empty string. In this view `skipped` and the item
        // `offset` are byte counts, not row counts.
        let start = args.offset.saturating_sub(1).saturating_mul(16).min(bytes.len()); let end = (start + args.limit.min(1900) * 16).min(bytes.len());
        let text = bytes[start..end].iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ");
        return Ok(json!({"status":"completed","phase":"verify","changed":0,"matched":1,"skipped":start,"failed":0,"complete":end == bytes.len(),"truncated":end < bytes.len(),"nextOffset":end.div_ceil(16)+1,"omitted":bytes.len().saturating_sub(end),"bytesTotal":bytes.len(),"revision":facts["revision"],"bytes":facts["bytes"],"lineCount":facts["lineCount"],"items":[{"path":path,"view":"hex","offset":start,"text":text}]}));
    }
    if args.view != "text" { return Err(Failure::new("INVALID_ARGUMENT", "view must be text or hex")); }
    let text = String::from_utf8(bytes).map_err(|_| Failure::new("INVALID_ARGUMENT", "file is not valid UTF-8"))?;
    let lines: Vec<_> = text.lines().enumerate().skip(args.offset.saturating_sub(1)).take(args.limit).map(|(i, line)| json!({"path":path,"line":i+1,"text":line})).collect();
    let mut output = result(lines, text.lines().count(), args.offset.saturating_sub(1), args.offset, text.lines().count(), false);
    for key in ["revision", "bytes", "lineCount"] { output[key] = facts[key].clone(); }
    Ok(output)
}
fn glob(request: &Request) -> Result<Value> {
    let args: GlobArgs = serde_json::from_value(request.args.clone())?;
    if args.limit == 0 || args.limit > 10_000 { return Err(Failure::new("INVALID_ARGUMENT", "glob limit is 1-10000")); }
    if args.pattern.is_empty() || args.pattern.iter().all(|p| p.starts_with('!')) { return Err(Failure::new("INVALID_ARGUMENT", "pattern requires a positive glob")); }
    let root = target(&args.path, false)?; if !root.is_dir() { return Err(Failure::new("INVALID_ARGUMENT", "glob path must be a directory")); }
    let walked = walk(&root, request)?;
    let mut files: Vec<_> = walked.files.into_iter().filter(|f| matches_any(&root, f, &args.pattern)).collect();
    // `sort` is optional: empty keeps the walk's path order, which is what `path`
    // asks for explicitly. The whole candidate list is ordered before paging, so a
    // page boundary always falls in the same sequence a full listing would produce.
    if args.sort == "modified" { sort_by_modified(&mut files); } else if !args.sort.is_empty() && args.sort != "path" { return Err(Failure::new("INVALID_ARGUMENT", "sort must be path or modified")); }
    let output_mode = if args.output_mode.is_empty() { "paths" } else { args.output_mode.as_str() };
    if output_mode != "paths" && output_mode != "details" { return Err(Failure::new("INVALID_ARGUMENT", "outputMode must be paths or details")); }
    let total = files.len(); let selected: Vec<_> = files.into_iter().skip(args.offset).take(args.limit).map(|f| if output_mode == "paths" { json!(f) } else { details(&f) }).collect();
    Ok(result(selected, total, args.offset, args.offset, total, walked.truncated))
}
fn grep(request: &Request) -> Result<Value> {
    let args: GrepArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.limit == 0 || args.limit > 10_000 { return Err(Failure::new("INVALID_ARGUMENT", "pattern and bounded limit are required")); }
    if args.before_context > 32 || args.after_context > 32 { return Err(Failure::new("INVALID_ARGUMENT", "context is limited to 32 lines")); }
    let regex = RegexBuilder::new(&args.pattern).case_insensitive(args.case_insensitive).multi_line(args.multiline).build().map_err(|e| Failure::new("INVALID_ARGUMENT", e))?;
    if !matches!(args.output_mode.as_str(), "" | "content" | "files_with_matches" | "count" | "summary") { return Err(Failure::new("INVALID_ARGUMENT", "invalid grep outputMode")); }
    let walked = files_for(&args.path, &args.glob, request)?; let mut matches = Vec::new(); let mut file_count = 0; let mut match_count = 0;
    let mut failed = 0usize; let mut skipped_files = 0usize;
    // Which modes answer with an item per match (`content`) and which with an item per file. Declared
    // once here because both the per-file loop and the envelope's `total` have to agree on it.
    let content_mode = !matches!(args.output_mode.as_str(), "files_with_matches" | "count" | "summary");
    let page = args.offset.saturating_add(args.limit);
    for file in walked.files {
        let bytes = match read_bytes(&file) {
            Ok(bytes) => bytes,
            Err(error) if error.code == "OUTPUT_LIMIT" => { skipped_files += 1; continue; }
            Err(_) => { failed += 1; continue; }
        };
        let text = match String::from_utf8(bytes) { Ok(v) => v, Err(_) => { skipped_files += 1; continue; } }; let lines: Vec<_> = text.lines().collect();
        // Line by line by default. With `multiline` the pattern is matched against
        // the whole file, so a pattern containing `\n` can match across lines
        // instead of never matching at all — which is what the flag's name promises
        // and what it did not do. `^` and `$` still resolve per line, because the
        // builder keeps `multi_line` on in both modes.
        //
        // Each hit is reduced to the span of lines it covers, so one reporting path
        // serves both modes: a cross-line match is reported at the line where it
        // starts, with its context lines around it.
        // Matches are counted in one pass and materialized in a second, page-bounded one. Counting a
        // match costs no allocation, while joining its lines into a `text` item costs the lines
        // themselves — and the previous shape built one item per match in the file *before* `limit`
        // was consulted, so a 32 KiB line matched by `pattern: "a"` copied that line 32 768 times and
        // the worker died under a memory cap instead of returning its first item. Reported by
        // @Haoming9527 in review of #81.
        let mut hits = 0usize;
        let mut spans: Vec<(usize, usize)> = Vec::new();
        if args.multiline {
            let starts: Vec<usize> = text.match_indices('\n').map(|(at, _)| at + 1).collect();
            // Clamped, so a match can never be attributed to a line the file does
            // not have: the offset-to-line map is only meaningful for offsets inside
            // the text.
            let line_of = |offset: usize| starts.partition_point(|start| *start <= offset).min(lines.len().saturating_sub(1));
            for found in regex.find_iter(&text) {
                // Matching the whole file at once adds one zero-width match at the
                // position after a final newline — the one place `$` and `^` already
                // matched at the end of the last real line. Reporting it invented
                // line N+1 with empty text, so `$` answered six times for a
                // five-line file. A file with no trailing newline keeps its last
                // match, because there the end of the file is the end of a line.
                if found.start() >= text.len() && text.ends_with('\n') { continue; }
                hits += 1;
                // Only what the page can still hold is materialized, so the peak is the page and not
                // the file's match count. `hits` above stays exact: `matched` reports every match.
                let ordinal = match_count + hits - 1;
                if content_mode && ordinal >= args.offset && ordinal < page { spans.push((line_of(found.start()), line_of(found.end().saturating_sub(1).max(found.start())))); }
            }
        } else {
            for (index, line) in lines.iter().enumerate() {
                if !regex.is_match(line) { continue; }
                hits += 1;
                let ordinal = match_count + hits - 1;
                if content_mode && ordinal >= args.offset && ordinal < page { spans.push((index, index)); }
            }
        }
        if hits == 0 { continue; } file_count += 1; match_count += hits;
        let in_page = file_count > args.offset && file_count <= page;
        match args.output_mode.as_str() { "files_with_matches" if in_page => matches.push(json!({"path":file})), "count" if in_page => matches.push(json!({"path":file,"count":hits})), "files_with_matches" | "count" | "summary" => {} , _ => { for (first, last) in spans { let start=first.saturating_sub(args.before_context); let end=(last+args.after_context+1).min(lines.len()); matches.push(json!({"path":file,"line":if args.line_numbers {first+1} else {0},"text":lines[start..end].join("\n")})); } } }
        // Keep counting through every candidate; only materialize the requested
        // window. A page-full prefix must never masquerade as the global total.
    }
    let incomplete = walked.truncated || failed > 0;
    if args.output_mode == "summary" { return Ok(json!({"status":"completed","phase":"verify","changed":0,"matched":match_count,"skipped":0,"failed":failed,"skippedFiles":skipped_files,"complete":!incomplete,"truncated":incomplete,"omitted":0,"files":file_count,"matches":match_count})); }
    // `total` is the number of items a full materialization would have produced: one per match in the
    // content modes, one per file otherwise. It is the match count in the first case because the page
    // bound above only limits what was *built*, never what was counted.
    let total = if content_mode { match_count } else { file_count };
    let mut output = result(matches, total, args.offset, args.offset, match_count, incomplete);
    output["failed"] = json!(failed);
    output["skippedFiles"] = json!(skipped_files);
    Ok(output)
}
fn replace(request: &Request) -> Result<Value> {
    if request.read_only { return Err(Failure::policy("read-only", "replace is unavailable in read-only mode")); }
    let args: ReplaceArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.max_replacements == 0 || args.max_replacements > 100_000 { return Err(Failure::new("INVALID_ARGUMENT", "pattern and maxReplacements are required")); }
    let walked = files_for(&args.path, &args.glob, request)?; let mut plans = Vec::new(); let mut total = 0usize; let mut binary: Vec<PathBuf> = Vec::new();
    // A directory that holds one binary file (an icon, an archive) is a normal repository, not a
    // malformed request: the binary is reported as skipped and the text files around it are still
    // edited. Failing the whole call on the first non-UTF-8 byte made a routine directory edit
    // impossible, and the error named no file, so the caller could not even narrow the request.
    let mut update_guards = Vec::new();
    for file in walked.files {
        // Serialize observation as well as publication. On APFS an open racing
        // an unlink/rename can fail ENOENT on the superseded vnode even though
        // the directory name always has a complete version. Do not retry or
        // relabel ENOENT: avoid the race between cooperating writers instead.
        let (guard, bytes) = if args.dry_run { (None, read_bytes(&file)?) }
            else { let (guard, bytes) = lock_and_read_for_update(&file)?; (Some(guard), bytes) };
        match String::from_utf8(bytes.clone()) {
            Ok(text) => {
                let count = text.match_indices(&args.pattern).count();
                if count > 0 { total += count; plans.push((file, bytes, text, count)); update_guards.push(guard); }
            }
            Err(_) => binary.push(file),
        }
    }
    let skipped = binary.len();
    let skipped_paths: Vec<Value> = binary.iter().take(8).map(|file| json!(relative_display(&request.root_path(), file))).collect();
    if total > args.max_replacements { return Err(Failure::new("OUTPUT_LIMIT", format!("{total} matches exceed maxReplacements ({}); no file was changed. maxReplacements is a ceiling, not a truncation: raise it to {total} or more and retry.", args.max_replacements))); }
    let mut items=Vec::new(); for (file, original, text, count) in plans { let revision=format!("{:x}", Sha256::digest(&original)); let next=text.replace(&args.pattern,&args.replacement); items.push(json!({"path":file,"replacements":count,"revision":revision,"revisionAfter":format!("{:x}", Sha256::digest(next.as_bytes())),"bytesBefore":original.len(),"bytesAfter":next.len(),"lineCountBefore":text.lines().count(),"lineCount":next.lines().count()})); }
    if serde_json::to_vec(&items)?.len() > MAX_OUTPUT_BYTES / 2 { return Err(Failure::new("OUTPUT_LIMIT", "Replacement receipts exceed the bounded output budget; narrow path/glob. No files changed.")); }
    if args.dry_run { return Ok(json!({"status":"completed","phase":"observe","changed":0,"matched":total,"skipped":skipped,"failed":0,"complete":true,"omitted":0,"dryRun":true,"items":items,"skippedPaths":skipped_paths})); }
    for item in &items { publication::authorize_write(request, item["path"].as_str().unwrap_or(""))?; }
    let mut changed=0usize; for item in &mut items {
        let applied = (|| -> Result<()> { let file=PathBuf::from(item["path"].as_str().unwrap_or(""));
        publication::authorize_write(request, file.to_str().unwrap_or(""))?;
        // Observation guards above remain owned until every publication settles.
        let bytes = read_bytes(&file)?;
        // The revision is checked against the bytes the lock returned, so the check
        // and the write cannot be separated by another open — see the lock for why.
        let expected=item["revision"].as_str().unwrap_or(""); publication::check_revision(Some(&bytes), expected)?;
        let text=String::from_utf8(bytes).map_err(|_| Failure::new("INVALID_ARGUMENT", "replace only supports UTF-8 files"))?; let next=text.replace(&args.pattern,&args.replacement);
        // Report what the replacement kept. The fields are additive, so a caller
        // that ignores them sees exactly the envelope it saw before.
        if let Some((metadata,warnings))=atomic_write(&file,next.as_bytes())? { item["metadata"]=metadata; if !warnings.is_empty() { item["metadataWarnings"]=json!(warnings); } }
        Ok(()) })();
        if let Err(mut error) = applied {
            if changed > 0 { error.effect_state = "applied".into(); error.next_action = "Earlier files were already replaced. Inspect postconditions; do not repeat the batch blindly.".into(); }
            return Err(error);
        }
        changed += item["replacements"].as_u64().unwrap_or(0) as usize; }
    let count = items.len();
    let mut output = result(items, count, 0, 0, total, walked.truncated);
    output["changed"] = json!(changed); output["skipped"] = json!(skipped);
    // Do not let optional skipped path names defeat the serialized receipt budget.
    output["skippedPaths"] = if serde_json::to_vec(&output)?.len() < MAX_OUTPUT_BYTES / 2 { json!(skipped_paths) } else { json!([]) };
    Ok(output)
}
/// A POSIX ACL is exposed as this attribute, so preserving ACLs needs no libacl.
#[cfg(unix)]
const ACL_XATTR: &str = "system.posix_acl_access";

/// What the file being replaced carried, captured before its replacement exists.
///
/// `atomic_write` publishes a *new* inode, and a new inode arrives with none of
/// the old one's metadata: the mode, the owner, the POSIX ACL and every extended
/// attribute belong to the file that is about to be unlinked. So a `0600` `.env`
/// came back world-readable, a `0755` script lost its execute bit and an ACL was
/// dropped outright — the replacement was more permissive than what it replaced,
/// which is the one direction a file tool must never drift in silently.
///
/// Capture and restore are judged separately. A *capture* that cannot be completed
/// — the attribute list, the ACL, or any single value — aborts the call before
/// anything is published: a value that was never read cannot be put back, so the
/// tool would be guessing at what it is about to destroy. Only a *restore* failure
/// is downgraded to a warning, and only for the attributes listed as best-effort
/// below.
///
/// Policy, by severity:
///
/// - The mode is **not optional**. If it cannot be reapplied the call fails and
///   nothing is published; guessing at permissions widens access.
/// - A POSIX ACL is not optional either. A file that had one and comes back
///   without it has lost entries, and losing a *deny* entry is a widening change.
/// - On restore, the owner and the remaining extended attributes are best-effort
///   and are reported in `metadataWarnings`; they cannot be used as a substitute
///   for the two above, and a caller can act on a warning in a way it cannot act on
///   a silent change.
#[cfg(unix)]
struct PreservedMetadata { mode: u32, uid: u32, gid: u32, acl: Option<Vec<u8>>, xattrs: Vec<(String, Vec<u8>)> }

/// Read one extended attribute, or `None` when it is absent or unsupported.
#[cfg(unix)]
fn get_xattr(fd: &impl rustix::fd::AsFd, name: &str) -> Result<Option<Vec<u8>>> {
    let mut probe: [u8; 0] = [];
    match rustix::fs::fgetxattr(fd, name, &mut probe[..]) {
        Ok(size) => {
            let mut buffer = vec![0u8; size];
            let written = rustix::fs::fgetxattr(fd, name, &mut buffer[..]).map_err(|error| Failure::new("ACCESS_DENIED", format!("Read extended attribute {name}: {error}")))?;
            buffer.truncate(written);
            Ok(Some(buffer))
        }
        Err(error) if matches!(error, rustix::io::Errno::NODATA | rustix::io::Errno::NOTSUP)
            || (cfg!(target_os = "macos") && error == rustix::io::Errno::from_raw_os_error(93)) => Ok(None),
        Err(error) => Err(Failure::new("ACCESS_DENIED", format!("Read extended attribute {name}: {error}"))),
    }
}

/// Every attribute name on the file. An empty list is not an error: a filesystem
/// that carries none answers `ENOTSUP`.
#[cfg(unix)]
fn list_xattrs(fd: &impl rustix::fd::AsFd) -> Result<Vec<String>> {
    let mut probe: [u8; 0] = [];
    let size = match rustix::fs::flistxattr(fd, &mut probe[..]) {
        Ok(size) => size,
        Err(error) if error == rustix::io::Errno::NOTSUP => return Ok(Vec::new()),
        Err(error) => return Err(Failure::new("ACCESS_DENIED", format!("List extended attributes: {error}"))),
    };
    let mut buffer = vec![0u8; size];
    let written = rustix::fs::flistxattr(fd, &mut buffer[..]).map_err(|error| Failure::new("ACCESS_DENIED", format!("List extended attributes: {error}")))?;
    buffer.truncate(written);
    Ok(buffer.split(|byte| *byte == 0).filter(|name| !name.is_empty()).map(|name| String::from_utf8_lossy(name).into_owned()).collect())
}

#[cfg(unix)]
impl PreservedMetadata {
    fn of(target: &crate::file_path::Target) -> Result<Self> {
        let file = crate::file_path::read_file(target)?;
        let stat = rustix::fs::fstat(&file).map_err(|error| Failure::new("ACCESS_DENIED", format!("Stat {}: {error}", target.display.display())))?;
        let mut xattrs = Vec::new();
        for name in list_xattrs(&file)? { if name == ACL_XATTR { continue } if let Some(value) = get_xattr(&file, &name)? { xattrs.push((name, value)) } }
        Ok(Self { mode: stat.st_mode as u32, uid: stat.st_uid as u32, gid: stat.st_gid as u32, acl: get_xattr(&file, ACL_XATTR)?, xattrs })
    }
    /// Reapply onto the replacement. `Err` forbids publication; `Ok` may still
    /// carry warnings for whatever could not be restored.
    fn restore(&self, file: &cap_std::fs::File) -> Result<(Value, Vec<String>)> {
        let mut warnings = Vec::new();
        let current = rustix::fs::fstat(file).map_err(|error| Failure::new("ACCESS_DENIED", format!("Stat replacement: {error}")))?;
        let owner = if (self.uid, self.gid) == (current.st_uid as u32, current.st_gid as u32) {
            true
        } else {
            match rustix::fs::fchown(file, Some(rustix::process::Uid::from_raw(self.uid)), Some(rustix::process::Gid::from_raw(self.gid))) {
                Ok(()) => true,
                Err(error) => { warnings.push(format!("owner {}:{} was not restored ({error}); the replacement is owned by the current user", self.uid, self.gid)); false }
            }
        };
        // The mode goes on after the owner, because a successful `chown` clears
        // setuid and setgid. This one is fatal if it fails.
        rustix::fs::fchmod(file, rustix::fs::Mode::from_bits_truncate((self.mode & 0o7777) as _)).map_err(|error| Failure::new("ACCESS_DENIED", format!("Mode {:04o} could not be preserved ({error}); nothing was published", self.mode & 0o7777)))?;
        // The ACL goes on after the mode, because `chmod` rewrites an ACL's mask
        // entry; applying the captured attribute last reproduces the original pair.
        let acl = match &self.acl {
            Some(acl) => { rustix::fs::fsetxattr(file, ACL_XATTR, acl, rustix::fs::XattrFlags::empty()).map_err(|error| Failure::new("ACCESS_DENIED", format!("POSIX ACL could not be preserved ({error}); nothing was published")))?; true }
            None => {
                // A new inode can inherit a parent's default ACL even when the old
                // inode had no access ACL. Do not publish those inherited grants.
                #[cfg(target_os = "linux")]
                match rustix::fs::fremovexattr(file, ACL_XATTR) {
                    Ok(()) => (),
                    Err(error) if matches!(error, rustix::io::Errno::NODATA | rustix::io::Errno::NOTSUP) => (),
                    Err(error) => return Err(Failure::new("ACCESS_DENIED", format!("Inherited POSIX ACL could not be cleared ({error}); nothing was published"))),
                }
                false
            },
        };
        let mut restored = Vec::new();
        for (name, value) in &self.xattrs {
            match rustix::fs::fsetxattr(file, name.as_str(), value, rustix::fs::XattrFlags::empty()) { Ok(()) => restored.push(name.clone()), Err(error) => warnings.push(format!("extended attribute {name} was not restored ({error})")) }
        }
        let omitted = restored.len().saturating_sub(16); restored.truncate(16);
        let omitted_warnings = warnings.len().saturating_sub(16); warnings.truncate(16);
        if omitted_warnings > 0 { warnings.push(format!("{omitted_warnings} additional metadata warnings omitted")); }
        Ok((json!({"mode": format!("{:04o}", self.mode & 0o7777), "owner": owner, "acl": acl, "xattrs": restored, "xattrsOmitted": omitted}), warnings))
    }
}

/// Lock the stable per-path sidecar before reading the current target.
///
/// Target-inode locks are insufficient across atomic rename: a waiter can retain
/// the old inode while the path already names a new one. Cooperating writers all
/// use this persistent lock inode, held until publication and directory sync.
/// Non-cooperating writers remain outside this advisory serialization contract.
///
/// The sidecar is created *before* the target is read, so an operation refused
/// after the lock was taken leaves it behind. That is the declared behavior
/// (#240 P5), not an accident, and it cannot be removed: unlinking the sidecar
/// on release would let a waiter that already opened the old inode hold a lock
/// on an inode the path no longer names, while the next writer locks a fresh
/// file under the same name — two writers on one target. A zero-byte artifact
/// that can be named, counted and documented is strictly better than that hole.
///
/// Which refusals have already taken the lock (and so leave the sidecar): a
/// stale `expectedRevision` on write/edit/copy/move/remove, an ambiguous or
/// overlapping `edit_file` edit, and a copy/move refused because the
/// destination exists. `replace` is the broad one: it locks every file its
/// `glob` selects before it knows whether a file holds a match, so a refusal
/// there — the `maxReplacements` ceiling, a `write_roots` fence, a revision
/// conflict while publishing — leaves a sidecar beside every candidate, matching
/// or not, and only a narrower `glob` bounds that. Refusals decided before the
/// lock — read-only mode, the credential fence, path validation — leave nothing.
///
/// Declared lifecycle:
///
/// - One file per distinct target *name* (lowercased), beside the target:
///   `.dsh-ops-update-<sha256(name)>.lock`, created mode 0600. Later operations
///   on the same name reuse that inode, so sidecars do not accumulate; one write
///   may leave at most one per file it locked.
/// - Nothing removes it automatically, and nothing should while a `dsh-ops`
///   writer may be active: deleting it is what re-opens the race above. An
///   operator may delete sidecars in a directory no writer is using; the next
///   write recreates whatever it needs.
/// - It stays invisible to every selection tool. The name starts with `.`, and
///   the walker drops any path with a hidden component (`hidden`) before a glob
///   can match it, so `ops_glob`, `ops_grep` and a directory-wide `ops_replace`
///   never return, count or rewrite one; `ops_batch` resolves its operations
///   from the request, never from a walk.
fn lock_and_read_for_update(file: &Path) -> Result<(std::fs::File, Vec<u8>)> {
    let raw = file.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let checked = crate::file_path::checked_leaf(raw, true)?;
    // The lock inode must survive replacement of the target inode. Keep a
    // persistent, hidden sidecar per path; unlinking it after unlock would let
    // another process lock a different inode under the same lock name.
    let key = format!("{:x}", Sha256::digest(checked.name.to_lowercase().as_bytes()));
    let lock_name = format!(".dsh-ops-update-{key}.lock");
    let lock = publication::open_update_lock(&checked.parent, &lock_name)?;
    FileExt::try_lock_exclusive(&lock).map_err(|_| Failure::new("REVISION_CONFLICT", "another writer is updating this path; nothing was changed, retry"))?;
    let bytes = read_bytes(file)?;
    Ok((lock, bytes))
}
/// Remove `.<name>.dsh-ops-<uuid>` leftovers from earlier writers that were killed
/// before they could publish.
///
/// A `SIGKILL` cannot run a cleanup path, so the debris cannot be prevented at the
/// point it is created. The next writer of the same file is the only place it can
/// be bounded, and it is a safe place: the caller holds the update lock, so no live
/// writer is using any of *this* file's names. Best-effort — a leftover that cannot
/// be removed must not fail the write that is about to happen.
///
/// A leftover is identified by the whole shape this writer creates, not by its
/// prefix: the tail must parse as the v4 UUID `atomic_write` generates. The prefix
/// rule deleted files that merely began the same way — an operator's
/// `.notes.txt.dsh-ops-personal-backup`, and, for a target named `foo`, the live
/// temporary file of a *different* target (`foo.dsh-ops-bar`), whose writer holds a
/// lock on that other file and not on this one. Reported by @Haoming9527 in review
/// of #81.
fn sweep_debris(parent: &cap_std::fs::Dir, name: &str) {
    let prefix = format!(".{name}.dsh-ops-");
    if let Ok(entries) = parent.entries() {
        for entry in entries.flatten() {
            if let Ok(leftover) = entry.file_name().into_string() {
                let own = leftover.strip_prefix(&prefix).and_then(|tail| uuid::Uuid::parse_str(tail).ok()).is_some_and(|parsed| parsed.get_version_num() == 4);
                if own { let _ = parent.remove_file(&leftover); }
            }
        }
    }
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<Option<(Value, Vec<String>)>> {
    let raw = path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let checked = crate::file_path::checked(raw)?;
    // Capture what the file carries before creating its replacement: publication is
    // a rename, so the new inode arrives with none of it.
    #[cfg(unix)]
    let preserved = PreservedMetadata::of(&checked)?;
    #[cfg(windows)]
    let preserved = publication::Preserved::capture(&checked, true)?;
    #[cfg(target_os = "macos")]
    dsh_ops_darwin_metadata::require_no_extended_acl(&crate::file_path::read_file(&checked)?.into_std())
        .map_err(|error| Failure::new("METADATA_UNSUPPORTED", error))?;
    let parent = &checked.parent;
    let name = &checked.name;
    sweep_debris(parent, name);
    let temporary = format!(".{name}.dsh-ops-{}", uuid::Uuid::new_v4());
    let mut file = publication::create_sibling(parent, &temporary, Some(&checked))?;
    // Keep content private until final metadata is restored. Creation mode also
    // masks inherited ACL grants; never write sensitive bytes to a default 0666 inode.
    let prepared = (|| -> Result<Option<(Value, Vec<String>)>> {
        file.write_all(bytes)?;
        #[cfg(any(unix, windows))]
        let report = Some(preserved.restore(&file)?);
        // Both bytes and restored mode/owner/ACL/xattrs must be durable before rename.
        file.sync_all()?;
        Ok(report)
    })();
    let report = match prepared {
        Ok(report) => report,
        Err(failure) => { publication::discard_sibling(parent, &temporary, file)?; return Err(failure); }
    };
    if let Err(failure) = parent.symlink_metadata(name).map_err(Failure::from).and_then(|metadata| crate::file_path::regular(&metadata, false)) {
        publication::discard_sibling(parent, &temporary, file)?;
        return Err(failure);
    }
    // Publication stays handle-relative and does not traverse links.
    let publish = parent.rename(&temporary, parent, name);
    if let Err(error) = publish {
        publication::discard_sibling(parent, &temporary, file)?;
        return Err(Failure::new("ACCESS_DENIED", format!("Atomic replacement publish: {error}")));
    }
    drop(file);
    #[cfg(windows)]
    preserved.verify(parent, name)?;
    #[cfg(unix)]
    if let Err(error) = crate::sync_directory(parent) {
        // The rename already happened, so the file *is* replaced. Reporting the
        // default `effect_state: "none"` here would tell the caller that nothing
        // changed, which is the one answer a caller must never get wrong: it would
        // invite a repeat of a write that has already been applied.
        let mut failure = Failure::new("SYNC_FAILED", format!("Atomic replacement published, but the directory entry could not be synced: {}", error.message));
        failure.phase = "publish".into();
        failure.effect_state = "applied".into();
        failure.next_action = "The replacement is already published; do not repeat it. Verify the file if durability matters.".into();
        return Err(failure);
    }
    Ok(report)
}

#[path = "file_publication.rs"]
mod publication;

#[path = "file_single.rs"]
mod single;
use single::content_facts;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    /// One private fixture directory under the canonical ambient temp root.
    ///
    /// The no-follow traversal refuses linked ancestry, and `TMPDIR` sits behind
    /// one on Darwin, so the ambient root is resolved before anything is created —
    /// the reason `single::tests::copy_changed_source_is_not_published` does the
    /// same.
    struct Fixture { root: PathBuf }
    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("dsh-ops-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self { root }
        }
        /// Write one fixture file and stamp it with `modified_ms` since the epoch.
        fn file(&self, name: &str, bytes: &[u8], modified_ms: u64) -> PathBuf {
            let path = self.root.join(name);
            std::fs::write(&path, bytes).unwrap();
            let stamp = UNIX_EPOCH + Duration::from_millis(modified_ms);
            std::fs::OpenOptions::new().write(true).open(&path).unwrap()
                .set_times(fs::FileTimes::new().set_accessed(stamp).set_modified(stamp)).unwrap();
            path
        }
        /// The sidecar `lock_and_read_for_update` creates for `name`.
        fn sidecar(&self, name: &str) -> PathBuf {
            self.root.join(format!(".dsh-ops-update-{:x}.lock", Sha256::digest(name.to_lowercase().as_bytes())))
        }
        fn names(files: &[PathBuf]) -> Vec<String> {
            files.iter().map(|file| file.file_name().unwrap().to_string_lossy().into_owned()).collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    /// #236: `modified` was `metadata.len()`, so every `details` item reported
    /// `modified == bytes` and `sort: "modified"` ordered by size. The fixtures
    /// are inverted on purpose — the larger file is the older one — so a
    /// size-based key reverses them.
    #[test]
    fn modified_is_epoch_milliseconds_and_ordering_ignores_size() {
        let fixture = Fixture::new("glob-modified");
        let old_big = fixture.file("a-old-big.txt", &[b'x'; 8192], 1_600_000_000_000);
        let new_small = fixture.file("z-new-small.txt", b"tiny", 1_600_000_120_000);
        let (old, new) = (modified(&old_big).expect("mtime"), modified(&new_small).expect("mtime"));
        assert!(old > 1_000_000_000_000, "modified must be epoch milliseconds, got {old}");
        assert_ne!(old, 8192, "modified must not be the byte count");
        // A filesystem may keep coarser than a millisecond; one second of slack
        // covers that without accepting a different quantity or unit.
        for (path, expected) in [(&old_big, 1_600_000_000_000_i128), (&new_small, 1_600_000_120_000_i128)] {
            let actual = modified(path).unwrap() as i128;
            assert!((actual - expected).abs() <= 1_000, "{}: expected {expected} ms ±1s, got {actual}", path.display());
        }
        assert!(new > old, "the newer file must carry the larger timestamp");
        assert_eq!(modified(&fixture.root.join("absent.txt")), None, "an unreadable time is null, not zero");
        assert_eq!(details(&old_big)["bytes"], json!(8192));

        let mut files = vec![new_small, old_big];
        sort_by_modified(&mut files);
        assert_eq!(Fixture::names(&files), ["z-new-small.txt", "a-old-big.txt"], "newest first, independent of size");
    }

    /// Equal timestamps must not reshuffle, so two identical calls page the same
    /// way: the sort is stable and the walk's path order decides the tie.
    #[test]
    fn equal_timestamps_keep_the_candidate_order() {
        let fixture = Fixture::new("glob-modified-tie");
        let first = fixture.file("a.txt", b"a", 1_600_000_000_000);
        let second = fixture.file("b.txt", b"bb", 1_600_000_000_000);
        let third = fixture.file("c.txt", b"ccc", 1_600_000_000_000);
        assert_eq!(modified(&first), modified(&second), "the fixture must produce equal timestamps");
        let mut files = vec![second, first, third];
        sort_by_modified(&mut files);
        assert_eq!(Fixture::names(&files), ["b.txt", "a.txt", "c.txt"], "ties keep their relative order");
    }

    /// #240 P5, declared behavior: the update lock creates the persistent hidden
    /// sidecar before the target is read, so a refusal after the lock already
    /// left it behind; it is one empty file per target name and is reused, never
    /// accumulated, and a later successful write keeps using the same inode.
    #[test]
    fn the_update_lock_sidecar_is_created_once_and_reused() {
        let fixture = Fixture::new("update-lock");
        let target = fixture.file("notes.txt", b"one", 1_600_000_000_000);
        let sidecar = fixture.sidecar("notes.txt");
        assert!(!sidecar.exists(), "no sidecar before the first update attempt");
        drop(lock_and_read_for_update(&target).unwrap());
        assert!(sidecar.is_file(), "the lock is a persistent sibling, not the target");
        assert_eq!(fs::metadata(&sidecar).unwrap().len(), 0, "the sidecar carries no payload");
        drop(lock_and_read_for_update(&target).unwrap());
        // A refused read is the shape #240 reports: the sidecar is already there
        // when the target itself cannot be read; a stale-revision write refuses the
        // same way, after the same lock.
        let missing = fixture.root.join("missing.txt");
        assert_eq!(lock_and_read_for_update(&missing).unwrap_err().code, "NOT_FOUND");
        assert!(fixture.sidecar("missing.txt").is_file(), "a refused operation still leaves the declared sidecar");
        assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 3, "one target and two sidecars, never more");
    }
}

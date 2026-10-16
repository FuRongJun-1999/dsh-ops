# Windows x64 verification checklist

This branch adds Linux x64 support and fixes the release-scope gate. Everything
below was established on **Debian 13 / x86_64 / Node v24.21.0 / Rust 1.98.1**.
The **Windows x64 lane was not re-run** while writing it: GitHub Actions is
disabled repo-wide, and no Windows host was available. So this file is the list
of things that a Windows run must still answer.

Each item states what to run, what "pass" looks like, and what would be a real
finding. Four of the findings this branch documents (L1, L2, L4, and the new L14)
are **cross-platform**, so they need a Windows confirmation too.

Please run these on Windows x64 and paste the raw command output. Report items
that fail, skip, or behave differently from the stated expectation — a
difference is the deliverable, not a nuisance.

---

## W1 — `ops_replace` and file security on Windows (L1 / L9, Windows half)

> **Measured 2026-10-15 on a real Windows x64 host** (Windows 11 Pro, NTFS,
> Node v24.18.0, worker built from this tree). Automated as
> `test/windows-security.test.mjs` — 8 checks, all green; the suite runs on
> every `npm run verify` Windows lane, so this half no longer needs a human.
> The measurements, with raw `icacls` before/after in the suite output:
>
> - **W1a — finding confirmed, and it is worse than "lost"**: the explicit
>   read-only grant (`user:(R)`, inheritance removed) comes back as
>   `user:(F)` — full control. The replacement **widened** access.
> - **W1b — finding confirmed**: a deny ACE for another principal
>   (`Guest:(DENY)(W)`) does not survive a successful replacement; the
>   restriction is widened away. (A deny that blocks the caller's own write
>   refuses earlier — see the W1b-failclosed note in the suite history; the
>   observable mechanism is covered by W1d's structured refusal.)
> - **W1c — same-user owner unchanged** (the two-user case still needs a
>   second account).
> - **W1d — confirmed**: a READONLY target refuses with a **structured**
>   error (`error.code` present, phase carried), nothing rewritten, no debris.
> - **W1e — confirmed**: a no-share open target refuses with a **structured**
>   error, nothing rewritten, no debris. Measured detail: `deny(W)`/`deny(D)`
>   on the target also blocks Node's own `readFileSync` (libuv opens for
>   more than read), so the fixture asserts after releasing the holder.
> - **W1g — confirmed**: an uncontended replace succeeds under the sidecar
>   lock; a racing loser reports structured `REVISION_CONFLICT` (never a raw
>   platform error).
> - **W1h — confirmed**: reads of the target/directory never fail while
>   replaces are in flight (8 replaces × continuous reader, 0 denials).
>
> One harness finding from the same run: the gate's own cleanup used to crash
> on Windows transient `EPERM` (`rmSync` without retries); it now retries
> (`maxRetries: 8`), which any CI Windows lane needs.

The POSIX half of this defect is **fixed**. `atomic_write` now captures the target's
mode, owner, POSIX ACL and extended attributes and reapplies them before publishing,
and `test/file-metadata.test.mjs` locks that in: `0600` and `0400` stay `0600`/`0400`,
`0755` stays executable, a POSIX ACL returns entry for entry, and user xattrs keep
their values. Verified live on Linux before the fix: `0600` → `0664`
(world-readable), `0755` → `0664` (a script stops being executable).

Windows takes a **different** path and is **not** fixed, because it needs
measurements this machine cannot produce. Windows has no POSIX mode bits: what a
replacement loses there is the *security descriptor*.

Mechanism to check: `atomic_write()` publishes with an ordinary rename, which
`cap-std` maps on Windows to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`. That
substitutes the directory entry and therefore the **new** file's security
descriptor. `ReplaceFileW` is the Windows API that preserves the replaced file's
ACL and attributes, and is the natural fix if this reproduces.

Everything below is a question, not a measurement.

### W1a — explicit DACL survives a replace?

An **explicit** (non-inherited) ACE is the Windows analogue of "the file had its
own mode/ACL". Expect it to be lost; confirm and capture the before/after.

```powershell
$f = "$env:TEMP\w1a.txt"
"secret = OLD" | Set-Content -NoNewline $f
# Remove inheritance and grant only the current user: an explicit DACL.
icacls $f /inheritance:r
icacls $f
# Ask DSH to replace OLD with NEW through ops_replace, then compare:
icacls $f
Get-Acl $f | Format-List Owner,AccessToString
```

Pass (fixed): the explicit ACE set is still there. Finding (current expected):
the DACL is gone or replaced by the directory's inherited ACEs, and the file's
effective access changed without any report to the caller.

### W1b — a non-inherited *deny* ACE is dropped

This is the security-critical direction: a deny ACE restricts access the
directory's inheritance would otherwise grant. Losing it **widens** access.

```powershell
$f = "$env:TEMP\w1b.txt"; "x" | Set-Content -NoNewline $f
icacls $f /inheritance:r /grant:r "$env:USERNAME:(R)"
icacls $f   # record; then ops_replace and compare
```

### W1c — owner change

```powershell
$f = "$env:TEMP\w1c.txt"; "x" | Set-Content -NoNewline $f
(Get-Acl $f).Owner
# then ops_replace and compare
```

On Linux the analogous case is a file owned by another user but writable through
the directory: the replacement ends up owned by the editing process. Expect the
same on Windows via inheritance.

### W1d — `FILE_ATTRIBUTE_READONLY` (expected to differ from Linux)

On Linux, renaming over a `0444` file **succeeds** — write permission on the file
is advisory for rename, and `test/linux-attributes.test.mjs` asserts that. On
Windows a READONLY target makes `MoveFileEx(REPLACE_EXISTING)` fail with
ACCESS_DENIED. So this case **must not be assumed to carry over**.

```powershell
$f = "$env:TEMP\w1d.txt"; "x" | Set-Content -NoNewline $f
Set-ItemProperty $f -Name IsReadOnly -Value $true
# then ops_replace: does it fail, and with what error code?
```

### W1e — target opened by another process

```powershell
$f = "$env:TEMP\w1e.txt"; "x" | Set-Content -NoNewline $f
$h = [IO.File]::Open($f,'Open','Read','None')   # no sharing
# then ops_replace, then $h.Close()
```

Windows will not rename over an open file without `FILE_SHARE_DELETE`; Linux
will. Check the reported error is a structured `ACCESS_DENIED`, not a raw
platform string, and that no `.w1e.txt.dsh-ops-<uuid>` debris is left behind.

### W1g — an uncontended replace must succeed *while the lock is held*

Reported by @Haoming9527 in review of #81: `LockFileEx` denies access to a locked
range through any other handle, including one the same process opens, and the
revision check used to re-read the target after taking the lock. On Linux this is
invisible (`flock` is per open file description), so only a Windows host can
answer it. The worker now reads the current bytes **through the lock handle**, so
nothing reopens the target between the check and the publish.

```powershell
$f = "$env:TEMP\w1g.txt"; "one two" | Set-Content -NoNewline $f
# then ops_replace { path: $f, pattern: "two", replacement: "three" } — a plain,
# uncontended replace, with no other process holding the file.
```

Check: the call reports `completed` with `changed: 1` (a lock violation here would
mean the target is being reopened while locked), the file reads `one three`, no
`.w1g.txt.dsh-ops-<uuid>` debris remains, and a *second* writer run against the
same file while the first is mid-call still receives `REVISION_CONFLICT` rather
than reporting a change that did not survive.

### W1f — alternate data streams and mark-of-the-web

A rename does not carry ADS along. Add one and see whether it survives:

```powershell
$f = "$env:TEMP\w1f.txt"; "x" | Set-Content -NoNewline $f
Set-Content -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3" $f
Get-Item -Stream * $f
# then ops_replace and re-check
```

---

## W2 — the release gate must actually *run* on Windows, not skip

`bin/check-release.mjs` now derives its scope from `package.json` `os` x `cpu`,
asserts that scope equals `lib/ptc/runtime.js` `PLATFORMS`, and closes the
Windows Bash IPC payload **only when `win32-x64` is staged**. On Linux only the
*skip* branch could be exercised, so the Windows branch is unverified.

| Command | Expected on a Windows host with `runtime/win32-x64` staged |
| --- | --- |
| `npm run verify:release` | EXIT=0; 58 manifest checks; **the IPC closure RUNS** (no "skipped" note); `Release closure OK: dsh-ops@0.3.1, win32-x64 worker (...)` |
| `node bin/native-runtime.mjs check` | Validates the **declared** targets. On this branch `package.json` declares `win32` + `linux`, so a Windows-only checkout will refuse unless `runtime/linux-x64` is also staged. See the diagnostic note below. |
| `node bin/native-runtime.mjs check --staged` | Validates only what is under `runtime/`; on a Windows-only staging that is `win32-x64`, EXIT=0 |
| `DSH_OPS_REQUIRE_ALL_TARGETS=1 node bin/check-release.mjs` | Refuses on a Windows-only staging, naming `linux-x64` |
| `npm run check:ptc-runtime` | Now asks for `check --staged`; must pass on Windows |
| `node bin/native-runtime.mjs stage --platform win32-x64 --staged` | Refused: `--staged only applies to check; stage always names its targets` |
| `node bin/native-runtime.mjs check --platform bogus-x64` | Refused: `Unsupported target` |

Also confirm the **PE path** by hand, because only a synthetic fixture was
exercised on Linux: read the first 64 bytes of `runtime/win32-x64/dsh-ops-worker`,
check `MZ`, that `e_lfanew` at offset `0x3c` points at a `PE\0\0` signature, and
that the COFF machine field is `0x8664`.

```powershell
node -e "const b=require('fs').readFileSync('runtime/win32-x64/dsh-ops-worker');console.log(b.slice(0,2).toString(),b.readUInt32LE(0x3c).toString(16),b.slice(b.readUInt32LE(0x3c),b.readUInt32LE(0x3c)+4).toString(),b.readUInt16LE(b.readUInt32LE(0x3c)+4).toString(16))"
```

### Diagnostic gap — fixed

A bare `check` on a package missing a declared platform used to die on a raw
unhandled error instead of a designed message:

```
Error: ENOENT: no such file or directory, open '.../runtime/linux-x64/provenance.json'
```

It now names the missing receipt and both ways forward:

```
Runtime for linux-x64 is not staged: .../runtime/linux-x64/provenance.json is missing.
Run npm run build:ptc -- stage on linux-x64, or use check --staged to validate only
the targets this package carries.
```

The same class of leak is closed in three more places: `runtime/<target>/` holding a
worker but no receipt is refused as a **half-staged** runtime instead of being
skipped as absent; a worker that exists without its execute bit is refused by name
and mode rather than failing later as a bare `EACCES` from `spawn` (L12); and a
`--root` without a `package.json` says which file it could not read.

Windows is the place this still needs a look: the execute-bit check is POSIX-only,
and what Windows reports for a worker it cannot execute is exactly what this file
exists to find out.

---

## W3 — the eleven new boundary suites on Windows x64

`test/run.mjs` auto-discovers `test/*.test.mjs`. Eleven new suites were added
(`test/lib/boundary.mjs` is a shared helper, not a suite). They were written so
that a Windows run never reports a Linux-only check as passed and never fails for
a Linux-only reason — but that reasoning is untested on a real Windows host.

```powershell
npm run verify            # expect: the platform suite set to pass (Linux: 30 with a runtime, 28 + 2 skips without one)

npm run validate:manifest # expect: all 58 checks passed
```

| Suite | Expected on win32 |
| --- | --- |
| `inspect-hex.test.mjs` | Runs fully (byte slicing, platform-neutral) |
| `output-budget.test.mjs` | Runs fully (byte accounting, platform-neutral) |
| `grep-multiline.test.mjs` | Runs fully (pattern matching, platform-neutral) |
| `replace-concurrency.test.mjs` | Must pass, but the outcome depends on Windows lock semantics — see the update-lock note below |
| `file-metadata.test.mjs` | **Skips as a whole** (`skipSuite`, exit 77) because mode bits, POSIX ACLs and `user.*` xattrs are POSIX concepts. Windows carries a DACL; that is W1's question, not this suite's |
| `linux-args.test.mjs` | Runs fully (platform-neutral) |
| `linux-protocol.test.mjs` | Runs fully (platform-neutral) |
| `linux-scope.test.mjs` | Runs fully (platform-neutral; the staged-worker digest case returns early when `runtime/` carries only the other platform) |
| `linux-paths.test.mjs` | 5 cases run; **3 POSIX-only cases guarded in place**: 255-byte basename, a `0xff` non-UTF-8 name, and a NUL path |
| `linux-sandbox.test.mjs` | Containment cases run; symlink refusal, `/dev/null`, `/dev/zero`, `/proc/self/status`, FIFO, unix socket and the `0555` directory are guarded |
| `linux-attributes.test.mjs` | **Skips as a whole** (`skipSuite`, exit 77) because `nlink`/`blocks`/mode/rename-over-inode are POSIX-only |

Two suites skip as a whole (`file-metadata` and `linux-attributes`), so a Windows
run must report **2 skipped** — never a pass, never a failure.

Verify the skip path is honest, and that `DSH_OPS_REQUIRE_RUNTIME=1` turns it
into a failure rather than a green run:

```powershell
$env:DSH_OPS_REQUIRE_RUNTIME='1'; npm run verify; Remove-Item Env:\DSH_OPS_REQUIRE_RUNTIME
```

Expected: a failure naming the skipped suite, not a pass. On Linux this was
proven by moving the worker aside: every boundary suite exited 77, the runner
printed `0 suite(s) passed, 1 skipped`, and with the variable set it printed
`--- linux-paths.test.mjs skipped while DSH_OPS_REQUIRE_RUNTIME=1` /
`1 of 1 suite(s) failed`.

If any suite fails on Windows, that is a real finding: the guard is wrong.

---

## W4 — the cross-platform defects, confirmed on Windows

These were declared cross-platform on the strength of code reading, so they need
a Windows data point. Rows marked **fixed** now have a suite on this branch and
must show the *fixed* behaviour; the remaining one (L8) is **open** and is covered
by the fix plan.

| Item | Repro | Expected (current behaviour) |
| --- | --- | --- |
| **L2** hex view drops the first 16 bytes — **fixed** | 8-byte file + `ops_inspect_local_file {view:"hex"}` with no offset | `items[0].text == "deadbeef00112233"`, `bytesTotal: 8`, `complete: true`, and `skipped: 0` |
| **L3** default `maxReplacements` is a reject threshold — **fixed (message only)** | 101 matches, no explicit `maxReplacements` | still refused with `OUTPUT_LIMIT` and **no file changed**, but the message now names the 101 matches, the 100 ceiling and how to proceed. The ceiling is deliberate; only the message blamed the pattern |
| **L4** `limit` bounds lines, not bytes — **fixed** | a file whose single line is 200 KB | the read completes with `truncated: true`, `items[0].truncatedInLine: true` and `bytesTotal`, still under the host's `stdout: { maxBytes: 128 * 1024 }`; the worker's own ceiling is 96 KiB |
| **L5** `replace` pattern is a literal substring — **fixed (description only)** | `pattern:"a.c"` against text `abc` | still no match: that is the design. The `pattern` field now states that it is a literal in `replace` and a regex in `grep`, which is what the two tools disagreed about |
| **L6** `multiline` cannot cross lines — **fixed** | `pattern:"alpha\nbeta"` with `multiline:true` | 1 match at line 1 with text `alpha\nbeta`; without the flag the same pattern still finds nothing, and `^`/`$` keep their per-line meaning. `$` reports one match per line — no phantom line after a trailing newline |
| **L7** hard kill leaves hidden debris — **bounded** | SIGKILL `ops_replace` during publication | one `.<name>.dsh-ops-<uuid>` file may remain until the next write of that same file, which reclaims it. A `SIGKILL` runs no cleanup path, so that is the tightest bound available without a journal |
| **L8** sparse files are materialised | 16 MiB sparse hole | 16 MiB of real allocation |
| **L12** exec bit is not validated — **fixed** | a 0644 worker binary | refused at resolve time by path and mode, `not executable (mode 0644)`. POSIX-only: Windows has no execute bit, so a Windows run cannot show this row |
| **L14** concurrent replaces lose an update — **fixed** | 6 simultaneous `ops_replace` on one file | exactly one call reports a change and its replacement is the one in the file; the others refuse with `REVISION_CONFLICT` or report `changed: 0` |

### The update lock on Windows — a new data point, please

The L14 fix takes an exclusive advisory lock on the target before re-checking the
revision and publishing. On Linux that is `flock`, which is advisory: a process
that never locks is unaffected. On Windows `fs2` reaches for `LockFileEx`, and
byte-range locks there are **mandatory** — a concurrent read of the locked range
by another process can fail with `ERROR_LOCK_VIOLATION` instead of waiting.

Two questions, both answered by `npm run verify`:

1. Does `replace-concurrency` pass — does exactly one writer win, with every other
   call refusing or reporting `changed: 0`?
2. While one process holds the lock, does a plain `ops_inspect_local_file` on the
   same file still succeed? If reads are refused, the lock needs narrowing (a
   dedicated lock file, or a per-directory lock) before this ships on Windows.

The `replace` path itself is exercised by `linux-args.test.mjs` on every platform,
so a Windows failure here is specific to the lock.

---

## W5 — the locale fix (#56) on a localized host

`fix(bash): pin message catalogs` sets `LC_MESSAGES=C` so that sandbox-denial
signature matching survives a localized Windows host. It was verified on Linux
under `LANG=zh_CN.UTF-8`. Confirm the shell and permissions suites still pass on
a Chinese-locale Windows host, or with the catalog variables forced:

```powershell
$env:LANG='zh_CN.UTF-8'; npm run verify
```

---

## Method notes

- **GitHub Actions is disabled repo-wide**, so every result here is local
  evidence. Please attach raw command output to the pull request.
- **Do not check out the package under `/tmp` on Linux.** The sandbox provider
  invokes `bwrap` with `--tmpfs /tmp`, which hides the checkout, so the package
  can never exec its own worker (`bwrap: execvp ...: No such file or directory`)
  and sandbox-dependent suites fail as `SANDBOX_UNAVAILABLE`. This produced a
  wrong measurement once already during verification.
- **Running one suite**: `node test/run.mjs <name>` (without the `.test.mjs`
  suffix). A suite may exit 77 to mean "skipped", and `test/lib/harness.mjs`
  refuses to run unless `DSH_HOME` points inside a temp directory — use the
  runner, not the file directly.
- **Synthetic fixtures**: `test/release-scope.test.mjs` builds a valid-looking PE
  and ELF in memory. A minimal PE x64 is `MZ`, `e_lfanew = 0x40`, `PE\0\0` at
  `0x40`, machine `0x8664` at `0x44`, `0x48` bytes total; a minimal ELF x64 is
  `7f 45 4c 46`, class `2`, endian `1`, and `e_machine = 62` at offset 18.
- **Threshold for L4 must be measured in bytes, not KiB.** 130,000 bytes is
  127 KiB and passes; 133,120 bytes is 130 KiB and fails because the host cap is
  131,072.

---

## What to send back

For each item: the exact command, the raw output, and one of
**pass / fail / differs from expectation / not applicable**. For W1, the
`icacls` (or `Get-Acl`) before and after. For W3, the suite summary lines and the
skip count. Anything that fails is the useful part of this exercise.

# Component reference
What each of the six components publishes, with parameters and permission requirements.
---

## Components at a glance

| Row `name` | Description | Default | Published tools |
| --- | --- | --- | --- |
| `dsh-ops/shell` | Prefer bash as the terminal, with PowerShell 7 for operations bash cannot cover | On | `ops_bash`; host `pwsh` uses bundled PowerShell 7 |
| `dsh-ops/file` | Faster, higher-performance Rust file retrieval with more concise, token-efficient output | On | Four file tools |
| `dsh-ops/ptc` | Independent Rust safe batches and bounded result references, only in pure PTC sessions | Off | `ops_batch`, `ops_result` |
| `dsh-ops/panel` | Data capture, off at the switch: new conversations write `<cwd>/.dsh-ops/panel/<sessionId>.json` plus the viewer `panel.html` | Row on, `capture: false` | None; see the [configuration reference](configuration-reference.md) |
| `dsh-ops/tui` | Read-only current-session OPS sidebar | Off | None; see [sidebar guide](tui-panel.md) |
| `dsh-ops/hide-official` | Hides the reviewed shell/file/ptc official tools; every other official tool stays visible with a warning | Off | None |

The former `dsh-ops/background` component (FastCtx background jobs: `ops_run`, `ops_run_background`, `ops_job_output`, `ops_job_list`, `ops_job_kill`) has been removed. A profile row that still names it loads as a no-op: it accepts any config, publishes nothing, and logs one warning that the row can be deleted.

---

## Tool summary

| Tool | Purpose | Full-access requirement |
| --- | --- | --- |
| `ops_inspect_local_file` | Bounded UTF-8 text lines and hex | No command permission gate¹ |
| `ops_grep` | Rust regex search, multiple file filters, counts/summaries | No command permission gate¹ |
| `ops_glob` | Multiple path patterns with exclusions | No command permission gate¹ |
| `ops_replace` | Mechanical cross-file literal replacement; use host edit for precise changes | No command permission gate¹ |
| `ops_bash` | Preferred general bash command executor; `command` for short commands, `script_path` for long scripts | Confined in restricted modes; matched Windows x64 private IPC runtime |
| `ops_batch` | Preflight and execute copy / move / remove with audit and recovery | See the PTC notes |
| `ops_result` | Bounded result references: put, page, release | See the PTC notes |
| Host `pwsh` | Windows-native operations using bundled PowerShell 7 | Host policy |

¹ **Fixed file operations use a trusted-operation policy fence, matching DSH fs-sandbox, not arbitrary-code isolation.** OS-readable paths are readable in all modes; read-only rejects replacement, including its dry run; workspace-write permits writes under the workspace and this session's private temporary directory, and full access adds no write fence. The fixed Rust worker uses host subprocess governance plus no-follow traversal, budgets and CAS. Bash/run_code still require OS confinement; no unconfined fallback exists. On Windows, owned workspaces automatically receive directory-only WRITE_OWNER for the host grant prerequisite, with DACL backups; no recursive ACL edits or ownership changes. That preparation runs the package's own script as the current user before sandbox confinement applies, only in workspace-write, with `-ExecutionPolicy Bypass` (Group Policy still wins).

---

## `dsh-ops/file` — file tools

All file tools resolve relative paths against the DSH session cwd, accept a single `path`, and expose no `root`, `workspace`, `cwd` or `file_path` alias. All are UTF-8 first with bounded output; glob and grep do not traverse symlinks, junctions, reparse points, hidden files or `.git`.

When the host provides its `fs` service, `ops_inspect_local_file` reads and real `ops_replace` writes are recorded in the host's read-before-edit table (`fs/observed`) exactly like host `read`/`edit`: a file read with ops can be edited with host `edit` directly, and an ops write does not make the host's earlier read look like an external change. `ops_grep`, `ops_glob` and `dryRun` record nothing.

### `ops_inspect_local_file`

Read bounded UTF-8 text lines, or a hex view of one path. Directories are rejected — use `ops_glob` or `ops_grep` instead.

The model rendering shares a homogeneous page's `path` once at the top level; raw execution/PTC results retain per-item paths. All other fields, including revision, paging and in-line truncation markers, are preserved. Worker byte limits and long-single-line continuation are unchanged; rendered bytes are not measured tokens.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | Resolved against the DSH session cwd |
| `offset` | integer ≥ 0 | 1-based line/hex row, default 1; legacy 0 also reads the first unit |
| `limit` | integer 1–10000 | Maximum lines returned |
| `encoding` | `utf-8` | Encoding |
| `view` | `text` \| `hex` | View mode |

### `ops_glob`

Find regular files below `path`. `pattern` is an **array** of globs matched segment by segment against paths relative to `path` (ASCII case-insensitive), e.g. `["**/*.md","!vendor/**"]`: `*.md` matches the top level only and `**/*.md` any depth; a `!` prefix excludes, and at least one positive entry is required. A bare string is rejected; there is no `include` field.

`outputMode: "details"` adds `bytes` (the on-disk size) and `modified`, a real modification time in **milliseconds since the Unix epoch** — the same quantity and unit `ops_stat` reports as `modifiedMs`, and `null` when the filesystem cannot report one. `sort: "modified"` orders newest first and is stable: equal timestamps keep the walk's path order. `sort: "path"` and an omitted `sort` both keep that walk order.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | Search root |
| `pattern` | string[] (required, ≥1) | Glob patterns |
| `outputMode` | `paths` \| `details` | Output shape |
| `sort` | `path` \| `modified` | Ordering |
| `offset` | integer | Paging start |
| `limit` | integer 1–10000 | Maximum entries |

### `ops_grep`

Search UTF-8 files below `path` with Rust regex, bounded output, paging and optional line context. `pattern` is **one** regex string; filter files with `glob`, an array in the same syntax as `ops_glob`. **There is no `include` field.** `glob` may contain only exclusions ("everything except"); when `path` is a single file, `glob` is ignored.

Use `summary` for aggregate file/match totals, `count` for per-file counts, `content` for matching text (default). Each item page defaults to 100 entries. Every call scans candidates to count global totals while materializing only the requested window, so later matches are not silently lost at the first page boundary. Follow `nextOffset` for remaining pages; `truncated`/`failed` scans are not exhaustive and must not be blindly retried. Non-UTF-8 and oversized files are excluded and counted in `skippedFiles`; read failures increment `failed` and prevent completion. Traversal/file-size bounds still apply, and repeated pages rescan rather than use a persistent cursor.

| Parameter | Type | Notes |
| --- | --- | --- |
| `pattern` | string (required) | Rust regex |
| `path` | string | Search root |
| `glob` | string[] | Restrict files |
| `outputMode` | `files_with_matches` \| `content` \| `count` \| `summary` | Output shape |
| `caseInsensitive` | boolean | Ignore case |
| `lineNumbers` | boolean | Show line numbers |
| `beforeContext` / `afterContext` | integer ≤ 32 | Context lines |
| `multiline` | boolean | Multi-line matching |
| `offset` / `limit` | integer ≥ 0 / integer 1–10000 | 0-based offset (default 0); limit default 100 |

### `ops_replace`

Perform a deterministic UTF-8 replacement under `path`. `pattern` is **literal text, not a regex**; `glob` works as in `ops_grep`. `dryRun` observes only; writes use revision checks and atomic replacement. Read-only sessions are rejected.

Cooperating writers serialise on a persistent, hidden update-lock sidecar beside each target (`.dsh-ops-update-<sha256 of the lowercased name>.lock`). It is created before the target is read, so a refused call can leave it behind; see [Update-lock sidecars](native-ptc.md#update-lock-sidecars) for why it is not removed and who may clean it up.

| Parameter | Type | Notes |
| --- | --- | --- |
| `pattern` | string (required) | Literal text |
| `replacement` | string (required) | Replacement text |
| `path` | string | Operation root |
| `glob` | string[] | Restrict files |
| `maxReplacements` | integer 1–100000 | Hard replacement limit |
| `dryRun` | boolean | Never writes |

### Results and errors

- **File tools, `ops_batch` and `ops_result` never throw.** Failures resolve as values with `status` `"error"` or `"rejected"` (authorization refusal) plus `error.code` / `error.message` / `error.nextAction`; success is `"completed"` (`ops_batch` also reports `planned` and related states). In PTC, a `try/catch` alone misses these failures — check `status`.
- **`ops_bash`** resolves command results as values: `status` (`completed` only for exit code 0 with no error, permission refusal, signal or timeout; otherwise `failed`), `exitCode`, `stdout` / `stderr`, `error`, `permission`. It throws (a `ToolCallError` in PTC) only for **invalid arguments** or an **unavailable executor**.
- Host tools (`read` / `write` / `edit` / `pwsh` …) throw `ToolCallError` on failure.

---

## `dsh-ops/ptc` — native batches and result references

Available by default, with tools published only in pure PTC sessions. Explicit profile disablement is preserved.

### `ops_batch`

Preflight and verify copy / move / remove.

| Parameter | Type | Notes |
| --- | --- | --- |
| `action` | `plan` \| `run` \| `resume` (required) | Action |
| `root` | string | Defaults to session cwd; when supplied it must be an absolute path (a relative root is rejected at preflight with `INVALID_ARGUMENT`) |
| `operations` | array, ≤512 items | Each item: `op` (`copy`/`move`/`remove`) + `path` + `to` |
| `operationsRef` | string | Reference a stored operation list |
| `protect` | string[], ≤128 items | Protected paths |
| `id` | string | The existing plan for `resume` |

> `action=plan` requires `operations` and creates a no-effect audit plan; execute that exact plan with `action=resume` plus `id` (**do not change it to `run`**). `action=run` requires `operations` and executes immediately. Operations use relative `/` paths, with no overwrite or link traversal. Page a plan's `detailsRef` with `ops_result`, passing the same `root` when it differs from the session workspace root (otherwise the page returns `NOT_FOUND`).

### `ops_result`

Bounded session-owned result references: put object rows, page with top-level `equals`/`fields` and quantity/byte budgets, release results. 24h expiry. Job audits are read-only. References are observations, never authority.

| Parameter | Type | Notes |
| --- | --- | --- |
| `action` | `put` \| `page` \| `release` (required) | Action |
| `items` | object array, ≤10000 items | Rows for `put` |
| `root` / `id` | string | Operation root and result id |
| `offset` | integer ≥ 0 | Paging start |
| `limit` | integer 1–512 | Rows per page |
| `maxBytes` | integer 512–65536 | Byte budget per page |
| `fields` | string[], ≤32 items | Projected fields |
| `equals` | object | Top-level filter |

---

## `dsh-ops/shell` — terminal and shells

Routing: **toolkit → bash → PowerShell 7**.

- `ops_bash`: the preferred general command executor. Use `command` for short commands and `script_path` for long scripts.
  Relative `workdir` paths (including `.`) resolve against the calling session's workspace, not the host process directory. Omitting `workdir` or passing a blank string uses that workspace; absolute paths remain absolute. Missing or non-directory targets are rejected before execution, with the resolved path in the error.
  On Windows, `\child` uses the session's drive; a drive-relative path such as `C:child` on a different drive must be written as an absolute path.
- Host `pwsh`: Windows-native operations, using bundled PowerShell 7.

"Prefer bash as the terminal" means prompting the model to use `ops_bash` first; it **does not change the system default terminal, PATH or existing host shell tool names**. When the shell component is on, the official configuration lifecycle temporarily sets the PowerShell 7 path for `pwsh-sandbox`; when off, it restores the executor's latest original configuration without writing profile configuration. Switching executor configuration does not cancel already-running host commands.

The routing table the model sees is rendered by the plugin from what it actually published:

```
# Shell routing: bash → PowerShell 7

| Task | Tool |
| --- | --- |
| Bounded UTF-8 text / hex | ops_inspect_local_file |
| Images | read_image (host) |
| Search contents | ops_grep |
| Find paths | ops_glob |
| Batch replacement; use host edit for precise edits | ops_replace |
| General commands / builds / git / pipelines / scripts — preferred command executor | ops_bash |
| Windows-native cmdlets / registry / services only | pwsh (bundled PowerShell 7 via host) |
```

---

## `dsh-ops/hide-official` — takeover scope

Opt-in and **disabled by default**. `strict` means "inside the faces dsh-ops takes
over, hide only what has a reviewed replacement" — it is not "no official tool may
survive". The takeover is exactly three faces: **shell / file / ptc**.

`Face` is `shell`, `file` or `ptc` (inside the takeover) or `outside` (a pinned
official tool this component deliberately does not take over); `prefix` marks a
dynamic official prefix. `—` in the equivalent column means no reviewed OPS
equivalent is claimed. The table is generated from `TAKEOVER_MANIFEST` in
`lib/official-tool-hiding.js`, and a test fails if the two drift apart.

<!-- hide-official-scope:start -->
| Official tool | Face | OPS equivalent | Why |
| --- | --- | --- | --- |
| `bash` | `shell` | — | Host command runner; `ops_bash` is the OPS executor |
| `pwsh` | `shell` | — | Platform-retained host shell; never hidden |
| `bash_persistent` | `shell` | — | Persistent host shell; `ops_bash` is stateless |
| `pwsh_persistent` | `shell` | — | Persistent host shell; `ops_bash` is stateless |
| `read` | `file` | `ops_inspect_local_file` | Reviewed OPS equivalent is registered |
| `glob` | `file` | `ops_glob` | Reviewed OPS equivalent is registered |
| `grep` | `file` | `ops_grep` | Reviewed OPS equivalent is registered |
| `write` | `file` | — | No reviewed OPS equivalent claims the same semantics |
| `edit` | `file` | — | No reviewed OPS equivalent claims the same semantics |
| `str_replace_editor` | `file` | — | No reviewed OPS equivalent claims the same semantics |
| `run_code` | `ptc` | — | PTC transport; never replaced |
| `list_subagent_models` | `outside` | — | Host delegation, teams and messaging |
| `subagent` | `outside` | — | Host delegation, teams and messaging |
| `subagent_fork` | `outside` | — | Host delegation, teams and messaging |
| `interrupt_agent` | `outside` | — | Host delegation, teams and messaging |
| `list_agents` | `outside` | — | Host delegation, teams and messaging |
| `send_message` | `outside` | — | Host delegation, teams and messaging |
| `spawn_teammate` | `outside` | — | Host delegation, teams and messaging |
| `wait_agent` | `outside` | — | Host delegation, teams and messaging |
| `team_task_create` | `outside` | — | Host delegation, teams and messaging |
| `team_task_get` | `outside` | — | Host delegation, teams and messaging |
| `team_task_list` | `outside` | — | Host delegation, teams and messaging |
| `team_task_update` | `outside` | — | Host delegation, teams and messaging |
| `job_kill` | `outside` | — | Host background jobs; OPS never controls host job state |
| `job_list` | `outside` | — | Host background jobs; OPS never controls host job state |
| `job_output` | `outside` | — | Host background jobs; OPS never controls host job state |
| `session_search` | `outside` | — | Host session history; observation only |
| `session_trace` | `outside` | — | Host session history; observation only |
| `session_event_read` | `outside` | — | Host session history; observation only |
| `session_event_search` | `outside` | — | Host session history; observation only |
| `session_event_trace` | `outside` | — | Host session history; observation only |
| `list_mcp_resources` | `outside` | — | Host MCP resource layer |
| `list_mcp_resource_templates` | `outside` | — | Host MCP resource layer |
| `read_mcp_resource` | `outside` | — | Host MCP resource layer |
| `terminal_open` | `outside` | — | Host terminal sessions; use `ops_bash` for commands |
| `terminal_close` | `outside` | — | Host terminal sessions; use `ops_bash` for commands |
| `terminal_list` | `outside` | — | Host terminal sessions; use `ops_bash` for commands |
| `terminal_read` | `outside` | — | Host terminal sessions; use `ops_bash` for commands |
| `terminal_send` | `outside` | — | Host terminal sessions; use `ops_bash` for commands |
| `terminal_signal` | `outside` | — | Host terminal sessions; use `ops_bash` for commands |
| `plan` | `outside` | — | Interactive host planning/approval surface |
| `exit_plan_mode` | `outside` | — | Interactive host planning/approval surface |
| `ask_user_question` | `outside` | — | Interactive host planning/approval surface |
| `todo_write` | `outside` | — | Interactive host planning/approval surface |
| `schedule_create` | `outside` | — | Host scheduling and goal bookkeeping |
| `schedule_delete` | `outside` | — | Host scheduling and goal bookkeeping |
| `schedule_list` | `outside` | — | Host scheduling and goal bookkeeping |
| `schedule_update` | `outside` | — | Host scheduling and goal bookkeeping |
| `create_goal` | `outside` | — | Host scheduling and goal bookkeeping |
| `get_goal` | `outside` | — | Host scheduling and goal bookkeeping |
| `update_goal` | `outside` | — | Host scheduling and goal bookkeeping |
| `present` | `outside` | — | Host media read/present surface |
| `read_image` | `outside` | — | Host media read/present surface |
| `web_search` | `outside` | — | Host web access |
| `web_fetch` | `outside` | — | Host web access |
| `skill` | `outside` | — | Host skills, workflows and autonomous loops |
| `workflow` | `outside` | — | Host skills, workflows and autonomous loops |
| `ralph` | `outside` | — | Host skills, workflows and autonomous loops |
| `plugin_manager` | `outside` | — | Host/plugin introspection and workspace dependencies |
| `cordis_inspect_list` | `outside` | — | Host/plugin introspection and workspace dependencies |
| `cordis_inspect_query` | `outside` | — | Host/plugin introspection and workspace dependencies |
| `lsp` | `outside` | — | Host/plugin introspection and workspace dependencies |
| `load_workspace_dependencies` | `outside` | — | Host/plugin introspection and workspace dependencies |
| `stagehand_*` | `prefix` | — | Dynamic third-party/driver prefix |
| `cua_driver_native__*` | `prefix` | — | Dynamic third-party/driver prefix |
<!-- hide-official-scope:end -->

What the table means in practice:

- **Only rows with a reviewed equivalent are hidden at all**: `read` → `ops_inspect_local_file`, `glob` → `ops_glob`, `grep` → `ops_grep`.
- **The platform-retained host shell is never hidden**: `pwsh` on Windows, `bash` elsewhere, even though it sits inside the shell face.
- **Inside the taken-over faces but kept visible**: `write`, `edit`, `str_replace_editor`, `run_code` and the shell names other than the retained one. They are named in the warning and dispatch still works — hiding them without a replacement would create a mixed official/OPS surface.
- **Outside the takeover**: every `outside` row and both dynamic prefixes. They stay visible and are listed in the same warning, which says they are outside `shell/file/ptc`. This is why a stock desktop profile can enable the row without a `READINESS_BLOCKED` failure (#207/#238).
- **The one fail-closed case**: `additionalOfficialTools` names an in-scope tool that has no equivalent. `READINESS_BLOCKED (HIDING_REQUEST_UNSATISFIABLE)` names the tool and both ways out (remove the name, or disable the row).

`scope` selects how wide the takeover is; the default `takeover` is the table above
and keeps an existing row's behaviour unchanged:

| `scope` | Hidden | `additionalOfficialTools` naming an `outside` tool | Warning |
| --- | --- | --- | --- |
| `takeover` (default) | rows with a reviewed equivalent | warned about and ignored | one aggregated warning |
| `extended` | same | promoted into the takeover scope; with no equivalent the scope fails closed with the way out | one aggregated warning for the rest |
| `off` | nothing | ignored silently | none, and no readiness gate either |

Copy-paste rows for each mode are in the
[configuration reference](configuration-reference.md#strict-official-tool-hiding-dsh-opshide-official).

---

## See also

- [Configuration reference](configuration-reference.md) — keys and owning components
- [Usage](usage.md) — install, update, remove, CLI
- [Troubleshooting](troubleshooting.md) — errors and diagnosis
- [Native PTC](native-ptc.md) — the PTC design and build

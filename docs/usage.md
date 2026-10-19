# Usage

The complete install, update and remove flow, plus every option of the command-line interface.

---

## Prerequisites

| Item | Requirement |
| --- | --- |
| OS | Windows x64 or Linux x64 (shell tools: Windows only) |
| Node.js | `^22.19 \|\| >=24` (the `engines` field in `package.json`) |
| Host | DSH `0.2.0-rc.2` |
| Target application | Initialized |

### macOS arm64

macOS carries no bundled shell payload, and the native worker is not part of the
repository on any platform, so two extra steps apply.

Build and stage the worker once from the checkout (Rust >= 1.88):

```console
cargo build --release --manifest-path native/Cargo.toml
node bin/native-runtime.mjs stage --platform darwin-arm64
```

Then point the shell row at a bash the machine already has:

```yaml
- id: dsh-ops-shell
  name: dsh-ops/shell
  config:
    bashPath: /opt/homebrew/bin/bash
```

The desktop application's bundled CLI lives inside its own installation, at
`.../Contents/Resources/runtime/cli/bin/dsh` on macOS, rather than at the
`%LOCALAPPDATA%` path used on Windows. The host exposes no pwsh row on macOS, so
PowerShell 7 is unavailable there. See [macOS arm64](macos-arm64.md) for the
capability matrix and the known limitations.

---

## Install

### Official plugin marketplace

In the target DSH application's plugin marketplace, enter the npm package name **`dsh-ops`**, install, then enable. Installation belongs to the currently running profile, which is `desktop` for the desktop app. The published package depends on complete bash and PowerShell 7 payloads; it does not download them through install scripts or change the system PATH.

### One-command npm installation

```console
npx --yes dsh-ops@latest install --profile desktop
npx --yes dsh-ops@latest install --profile web
npx --yes dsh-ops@latest install --profile tui
```

An explicit target profile is required. `tui` maps to the **dsh-TUI product's `dsh-tui` profile**, not the old `tui` directory. Initialize the target application first. This entry point delegates installation to the official DSH CLI rather than implementing separate profile locking and rollback logic.

Desktop must use the CLI bundled with the desktop application; the default auto-detected path is `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`. For another installation location, add `--dsh-cli "<installation>\resources\runtime\cli\bin\dsh.cmd"`. Web/TUI require an available DSH CLI, which can also be specified explicitly.

### Using the official commands directly

```console
dsh plugin --profile web add dsh-ops
dsh plugin --profile dsh-tui add dsh-ops
"<desktop installation>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-ops
```

The ordinary DSH CLI cannot manage the reserved `desktop` profile; do not confuse it with the desktop app's bundled entry point.

---

## Update

Repeat the same `npx --yes dsh-ops@latest install --profile ...` command, or use the official CLI's `add dsh-ops@latest`. Reload as requested by the application; restart it when replacing already-loaded code.

---

## Remove and check status

```console
npx --yes dsh-ops@latest status --profile desktop
npx --yes dsh-ops@latest uninstall --profile desktop
```

Replace `desktop` with `web` or `tui` as appropriate. You can also uninstall in the marketplace or run the official `dsh plugin --profile ... remove dsh-ops`. Binaries are managed as profile plugin dependencies; uninstalling removes dependency references without deleting system shells, copies in other profiles or shared package-manager caches.

Legacy explicitly provisioned `<DSH_HOME>/dsh-ops/` files (provisioned shells, and the FastCtx runtime earlier versions could provision) must be cleaned separately with `npx --yes dsh-ops@latest uninstall --yes`. The `~/.fastctx/` state left by the removed background component is kept by default; add `--purge-fastctx` explicitly to remove it as well.

---

## Command-line interface

```console
dsh-ops install --profile <desktop|web|tui> [--dsh-cli <path>]
dsh-ops uninstall --profile <desktop|web|tui> [--dsh-cli <path>]
dsh-ops status --profile <desktop|web|tui>
                                Report target-profile installation (tui maps to dsh-tui)
dsh-ops build-ptc              Build the independent native Rust worker (all platforms)
dsh-ops uninstall [--yes] [--purge-fastctx]
dsh-ops ladder [--json] [--config <file>]
                                prompt ladder actually renders; nothing is spawned
dsh-ops provision-shells [--bash] [--pwsh] [--force] [--dry-run] [--pin <file>]
                                their digests, and install them under <DSH_HOME>/dsh-ops/shells
```

With `--profile`, install/uninstall delegate to the official DSH profile manager.
Without `--profile`, uninstall only cleans legacy provisioned runtime/shell files.
`resolve`, `status` (without `--profile`), `build` and `provision` were removed with the FastCtx background component; each now exits with a message naming its replacement.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `HTTPS_PROXY` | Proxy handed to curl explicitly by provision-shells |
| `DSH_OPS_REQUIRE_RUNTIME` | Make `npm run verify` require an available runtime |
| `DSH_OPS_WORKER_BIN` | Select a worker build (otherwise `runtime/<platform>-<arch>/` then `native/target/release`) |
| `DSH_OPS_VCVARS64` | Supplies the MSVC environment when building Bash IPC proxies |

---

## Script files: `command` versus `script_path`

Use `ops_bash`'s `command` for short commands and pipelines. For scripts longer than about 1 KB, or containing heredocs, quotes, backslashes or non-ASCII text, write the script with the host file tools first, then execute it with `script_path`; do not put the entire heredoc in `command`. This substantially reduces multi-layer escaping in tool-call JSON and lowers the chance that a turn is discarded as `MALFORMED_RESPONSE`.

`script_path` accepts only the script path, so the script body is not repeated in the `ops_bash` arguments. `command` and `script_path` are mutually exclusive and exactly one is required. This interface cannot repair JSON that the model or host failed to parse; an unparseable tool call still requires a host/model retry.

`ops_bash` arguments are **strict**: a key the schema does not declare is refused before execution, and the error names both the unknown keys and the accepted ones instead of ignoring them. **This tool has no `run_in_background` and returns no job id**; every command runs in the foreground. The host `bash` and `pwsh` tools do accept `run_in_background`, so a model may reasonably try it here; such a call is rejected rather than silently run in the foreground. For a server, listener or watcher, use the host `pwsh` tool's `run_in_background`, or detach the process from inside the command (for example `nohup ... & disown`). Otherwise the call occupies the whole `timeoutMs` (up to `MAX_BASH_TIMEOUT_MS`, about 24.9 days).

---

## Process reclamation

This version starts no long-lived server process: the native file worker is owned by the file component and stops with it. Earlier versions with the background component started `fastctx serve` clients and could leave a shared FastCtx `runtime-host`; that process exits on its own after about ten minutes without clients. This release does not sweep processes left by older versions; do not kill them by process-name sweeps.

---

## Update configuration modification area

`lib/config-updates.js` centralizes one-time config migrations. On first startup with 0.2.5, each owning component row runs a self-check:

- With no `configUpdateVersion` (or `0`), change legacy `allowSystemShellFallback: true` to `false` before resolving executors or publishing tools.
- Submit the raw owning row through the official loader lifecycle with `configUpdateVersion: 1`. Preserve other fields; never change foreign plugins, PATH or global config. Disabled components migrate when first started.
- After completion, restarts/hot reload do not overwrite a later manual `true`. Do not remove the marker unless you intend to repeat the self-check.
- Without an owning loader row, apply the safe value for this activation and warn. Migration/loader logs report write failures; a marker not persisted to disk cannot guarantee once-only behavior across restarts.

---

## See also

- [Configuration reference](configuration-reference.md) — every configuration key
- [Component reference](component-reference.md) — components and tools
- [Troubleshooting](troubleshooting.md) — errors and diagnosis
- [Native PTC](native-ptc.md) — the PTC design and build

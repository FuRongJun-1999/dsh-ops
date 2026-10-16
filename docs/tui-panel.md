# Read-only OPS sidebar

[中文](tui-panel.zh.md)

## Enable

In the dsh-TUI profile, enable the existing `dsh-ops/tui` bundle row and restart dsh-TUI. It is disabled by default. This uses experimental `tuiPanels` API v1 and needs a TUI build that admits exported subcomponents using their own nearest package manifest. Older builds that inspect only the outer manifest cannot provide reliable component identity.

Edit the existing row rather than adding a duplicate:

```yaml
id: dsh-ops-tui
name: dsh-ops/tui
disabled: false
config:
  maxSessions: 32
  maxActive: 128
  recentLimit: 8
```

The OPS tab does not open itself or change focus. No TUI/React runtime dependency is added: the host provides React and UI primitives. Without `tuiPanels`, only this optional row remains pending. Declined API-v1 registration starts no observer. OPS operation permissions are unchanged; the UI subcomponent has its own manifest without tool requirements, grants, commands or decision subscriptions.

## What it shows

- Live native and PTC OPS calls for the selected session, since this component was enabled.
- Calls, in-flight count, transport returns/errors and recent observed durations.
- Tracking-limit warnings. A return is neutral, **not proof of business success**; a background launch returning does not mean the job finished.

This is not history replay or persistent accounting. Closing/reopening the tab preserves observation; unloading clears it. No command, argument, pattern, replacement, path, result body or error text is retained. Session changes select a different snapshot. No extra model/worker calls, job-output reads, polling, prompt sections or token-savings estimates are added. There are no destructive actions or send-to-chat controls.

## Limits

Only these keys belong on the TUI row:

| Key | Default | Range |
| --- | ---: | --- |
| `maxSessions` | 32 | 1–256 retained sessions, LRU |
| `maxActive` | 128 | 1–1024 active calls per session |
| `recentLimit` | 8 | 1–64 recent settled rows per session |

These bound observer memory, not tool execution. At active capacity, new calls are omitted and statistics are marked incomplete. Evicting a session never cancels its work. The full component panel is used: compact-only rendering and send-to-chat are not available in the current TUI API.

## Verification

```console
node test/run.mjs tui-activity tui-panel manifest
DSH_OPS_TUI_ROOT=/path/to/dsh-TUI DSH_OPS_REQUIRE_TUI=1 node test/run.mjs tui-host
```

The optional host suite resolves React/Cordis/rendering dependencies from the same TUI checkout or built package and isolates HOME/USERPROFILE/DSH_HOME before importing it. It tests real Loader admission, the exported OPS subpath, inline/fullscreen rendering at panel widths 28/38, session switching and unload. Tool events are synthetic: this is not native Windows, OS sandbox or manual PTY acceptance. Without the root variable the suite is counted as skipped, never passed; `DSH_OPS_REQUIRE_TUI=1` makes a missing root fail.

The sidebar does not change the package's declared targets: Windows x64, Linux x64 and macOS arm64. UI tests alone do not establish native execution or OS sandbox acceptance.

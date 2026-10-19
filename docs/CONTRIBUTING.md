# Contributing

Welcome to dsh-ops. This guide covers how work is claimed, how to build and verify locally, and the
conventions a pull request is reviewed against. 中文版：[贡献指南.md](贡献指南.md).

## Contents

- [What dsh-ops is (and is not)](#what-dsh-ops-is-and-is-not)
- [Workflow: issue first, then PR](#workflow-issue-first-then-pr)
- [Development environment](#development-environment)
- [Building the native worker](#building-the-native-worker)
- [The verification gate](#the-verification-gate)
- [Writing tests](#writing-tests)
- [Code and documentation conventions](#code-and-documentation-conventions)
- [Commits and pull requests](#commits-and-pull-requests)
- [Boundaries that must not be crossed](#boundaries-that-must-not-be-crossed)
- [License and attribution](#license-and-attribution)

## What dsh-ops is (and is not)

- **Minimal and low-intrusion.** dsh-ops only adds extra, easy-to-use tools to DSH — even bash is
  provided as its own `ops_bash`. Changes to DSH's original behaviour are limited to *optionally*
  hiding duplicated official tools, so the plugin stays compatible with other plugins.
- **Integration code lives apart from the core.** When dsh-ops cooperates with another DSH plugin,
  that integration layer gets its own area and stays fully decoupled from the core logic.
- **Small surface on purpose.** The team wants code and features to stay small. New features need an
  approved issue before any code is written.

## Workflow: issue first, then PR

1. **Every PR must link an issue**, and you must **claim the issue** (comment or get assigned)
   before starting. A claimed issue is how contributors see who is working on what and avoid
   duplicated work. A PR without a claimed issue will not be accepted.
2. **Issues are PR workspaces.** Open-ended bug discussions and feature ideas belong in
   [Discussions](https://github.com/T-Auto/dsh-ops/discussions); an issue should describe concrete
   work that a PR will close.
3. **Features need approval.** Write the issue first and wait for a maintainer to approve it.
4. **Large changes are split.** A big change (for example #151) is cut into issues that can be
   reviewed independently; each slice is developed on its own `work/<topic>` branch.

## Development environment

| Component | Requirement |
| --- | --- |
| Node.js | `^22.19` or `>=24` (`package.json#engines`; CI uses 24) |
| Rust | `1.97.1` (the toolchain CI pins); needed to build the native worker |
| Target host | DSH `0.2.0-rc.2` |
| Linux only | the `acl` package for the POSIX ACL checks |

```console
npm ci --ignore-scripts
npm run build:ptc         # build and stage the native worker (see below)
npm run verify
```

## Building the native worker

Most suites drive the real native worker. Without one they cannot answer, and they **skip**:

```console
cargo test --locked --manifest-path native/Cargo.toml   # worker unit tests
npm run build:ptc                                       # build + stage runtime/<platform>-<arch>/
npm run build:bash-ipc                                  # Windows only: Bash IPC proxies
```

What a skip means locally:

- `test/run.mjs` counts a skip apart from a pass. A machine with no worker reports
  `N suite(s) passed, M skipped` — that is **not** a green gate.
- `DSH_OPS_REQUIRE_RUNTIME=1` turns any runtime-absence skip into a failure. The gate sets it on
  Linux and macOS, so if you have not built the worker, expect those suites to **fail** there.
- `DSH_OPS_ALLOW_SKIPS=tui-host,tui-native` keeps suites that need an optional external checkout
  (`DSH_OPS_TUI_ROOT`, `DSH_OPS_TUI_WORKER`) as skips even under `DSH_OPS_REQUIRE_RUNTIME=1`.
- Platform skips are named and fixed in `scripts/verify-gate.mjs` (`ALLOWED_SKIPS`): on Windows
  `file-metadata`, `linux-attributes`, `linux-shell`; on POSIX only `mount`, and only when no worker
  can be resolved. Any other skip fails the gate.

## The verification gate

- `npm run verify` — `scripts/validate-manifest.mjs`, then `test/run.mjs` (every `test/*.test.mjs`
  in its own process with its own temporary `DSH_HOME`).
- `node scripts/verify-gate.mjs --skip-install` — **the release gate**, exactly what
  `.github/workflows/ci.yml` runs on Windows x64, Linux x64 and macOS arm64: worker unit tests, build
  and stage, manifest floor, every suite, the allowed-skip set, the suite inventory on disk, and the
  packed artifact.
- `node test/run.mjs <filter>` runs only the suites whose file names contain `<filter>`, e.g.
  `node test/run.mjs mount file-operations`.

How to read the gate and the expected numbers per host: [verify-locally.md](verify-locally.md).
CI runs on every pull request and every push to `main`; a PR must be green on all three platforms.

## Writing tests

- **New behaviour comes with an assertion** that fails when the implementation is reverted (red/green
  at the behaviour level, not just the code shape). Mount-related changes must be falsifiable in
  `test/mount.test.mjs`.
- **Prefer real calls over schema checks.** A tool is covered when a suite calls it through the real
  worker or host and asserts the result, including its failure paths (permission denial, CAS
  conflict, no-follow, unsupported metadata, `AUTHORITY_CHANGED`).
- **One suite = one `test/*.test.mjs` file = one process.** The gate asserts that every suite on
  disk was collected. Shared helpers live in `test/lib/` and must **not** end in `.test.mjs`.
- **No silent skips.** A whole suite skips only through `skipSuite()` in `test/lib/harness.mjs`
  and must be on the allowed list. A single check whose fixture cannot be built on a host prints a
  named `... fixture unavailable: <reason>` line instead of passing quietly.
- **No retries to hide flakes.** A concurrency assertion that fails intermittently is a bug in the
  implementation; fix the cause. Retries in the gate (#164) only ever cover suite timeouts.

## Code and documentation conventions

- **Language:** code, comments, CLI output and commit messages are English. User-facing docs are
  bilingual; maintainer-only notes may be Chinese.
- **Doc pairs:** each document in `docs/` exists in English and Chinese, e.g. `docs/usage.md` and
  `docs/使用指南.md`. Update both in the same PR.
- **File size:** keep new files under about 500 lines. If a file grows past that, split it into
  modules and group related modules in a folder, following the existing `lib/components/*` and
  `test/lib/` layout.
- **Tool names** always come from `publicToolName()` in `lib/policy.js`; never hand-write the `ops_`
  prefix.
- **Config validation** lives in `lib/config.js`; an unknown key is an error that names the key.
  Defaults in `cordis.patch.yml` must match the defaults in code.
- **Parsing and probing** happen synchronously in `apply`; `required: true` must refuse activation
  at load time.

## Commits and pull requests

- Small commits with conventional, imperative English messages, e.g.
  `fix: report undeclared background arguments as argument errors (#14)`.
- Use your real identity; no empty commits, no forged authorship, no rewriting pushed history.
- Fill in `.github/PULL_REQUEST_TEMPLATE.md`. The **Validation** section carries real command output
  (pass/skip/fail counts), not ticked boxes.
- Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) when behaviour or shipped
  documentation changes, or state in Validation why it is not needed.
- Do not add dependencies or change the version or `optionalDependencies` in `package.json` unless
  the issue asks for it.

## Boundaries that must not be crossed

- The host half **must not import `@deepseek-ai/*` values at load time**; use `ctx.inject([...])`
  / `ctx.get()` for host services.
- **Never rewrite the shared tool registry.** Publish `ops_*` tools only through this plugin's own
  `ctx.tools.register`.
- Prompt sections read tools through `ctx.get('tools')`, not `ctx.tools`.
- Do not remove tool contracts (argument semantics, defaults, path base, paging completeness,
  permission boundaries) to save schema or prompt bytes.

## License and attribution

Everything outside `licenses/fastctx/` is MIT; FastCtx is Apache-2.0. The upstream acknowledgement
reproduced in `NOTICE` and the READMEs **must stay verbatim** — do not "polish" it.

Native build and acceptance details: [native-ptc.md](native-ptc.md) and
[manual-validation.md](manual-validation.md).

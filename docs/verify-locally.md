# Running the whole gate on a host (and reading what it says)

`node scripts/verify-gate.mjs` runs the release gate the way
`.github/workflows/ci.yml` runs it, in the same order, and then **asserts the numbers
instead of printing them**: the manifest check count and the set of suites allowed to
skip on this platform. Two properties are the reason it exists:

- **A skip is never a pass.** `test/run.mjs` already counts skips apart from passes,
  but a host that silently skips a suite still exits 0. This script knows which suites
  may skip on this platform, names any other one, and fails on it.
- **The number in the docs matches the number on the host.** `61` manifest checks and
  the per-platform skip set are asserted here, so a stale document or a newly guarded
  suite is a failure rather than a quiet drift.

```bash
node scripts/verify-gate.mjs                 # this host, full gate
node scripts/verify-gate.mjs --skip-install  # node_modules is already current
node scripts/verify-gate.mjs --skip-fastctx  # no FastCtx backend; the mount suite skips
node scripts/verify-gate.mjs --json          # machine-readable summary
node scripts/verify-gate.mjs --keep-going    # run every step, report all failures
```

Exit codes are part of the contract: `0` every step passed, `1` a step failed, `2` the
host cannot answer this gate (a `--target` that is not the host, a missing toolchain).
There is no exit code for "green with a surprise in it" — that is `1`.

## What each step proves

| Step | Command | What it settles |
| --- | --- | --- |
| versions | `node --version`, `cargo --version` | The toolchain is the pinned one, before anything else can be blamed |
| install | `npm ci --ignore-scripts --registry=https://registry.npmjs.org` | Locked dependencies, and no install-time script runs (the Windows shell payloads are optional dependencies; `--ignore-scripts` is what keeps a Linux install from pretending to carry them) |
| worker unit tests | `cargo test --locked --manifest-path native/Cargo.toml` | The Rust worker in isolation |
| stage | `npm run build:ptc` | Builds the worker **and stages it with its provenance receipt** into `runtime/<platform>-<arch>/`. Skipping this is the most common way to get a misleading failure — see the traps below |
| platform payloads | `npm run build:bash-ipc` (Windows) / `cargo build --release --locked --manifest-path vendor/fastctx/Cargo.toml` (POSIX) | The Windows IPC proxies; the optional FastCtx backend the `mount` suite drives |
| manifest | `npm run validate:manifest` | The declaration layers agree; asserts `61` |
| suites | `DSH_HOME=<temp> DSH_OPS_REQUIRE_RUNTIME=1 npm run verify` | Every suite on this host. `DSH_OPS_REQUIRE_RUNTIME=1` turns a runtime-absence skip into a failure, and `DSH_HOME` must be a temporary directory or `test/lib/harness.mjs` refuses to run |
| closure | `node bin/native-runtime.mjs check --platform <target>` | The staged runtime is complete and its receipt matches the worker byte for byte |

## Expected numbers

| Host | Suites passed | Skipped, and why |
| --- | --- | --- |
| `linux-x64` | 30 | none — `mount` only if FastCtx was not built (`--skip-fastctx`) |
| `darwin-arm64` | 30 | none, same caveat |
| `win32-x64` | 27 | `file-metadata` and `linux-attributes` (mode bits, POSIX ACLs, user xattrs, inode identity, sparse allocation) and `linux-shell` (the POSIX bash rung, which is its own subject) |

Manifest checks are **61** on every platform. Those numbers are the ones the documents
claim; the script fails if a host disagrees, which is how `docs/windows-verification.md`
learned it had been promising "exactly 2" skips on Windows when the real answer is three.

## Traps that produce a wrong verdict

- **A stale staged runtime.** `test/permissions.test.mjs` and friends drive the worker
  the resolver picks, which is the **staged** copy under `runtime/`, not
  `native/target/release`. Rebuild after switching branches (`npm run build:ptc`) or the
  suites fail against an old binary — the giveaway is a worker-side
  `unknown field ...` from a request the current code sends.
- **Checking the package out under `/tmp` on Linux.** The sandbox provider runs `bwrap`
  with `--tmpfs /tmp`, which hides the checkout, so the package can never exec its own
  worker. Sandbox-dependent suites then fail as `SANDBOX_UNAVAILABLE`.
- **Running a suite file directly.** Always `node test/run.mjs <name>` (or the gate):
  the harness requires `DSH_HOME` to point inside a temporary directory and exits 77 for
  a skip, which only the runner interprets.
- **A non-ASCII `CARGO_HOME` or target directory on Windows.** mingw's `gcc` driver drops
  non-ASCII paths, so the build fails somewhere that looks unrelated.
- **Reading a skip as a pass.** If a suite's subject does not exist on this host, the
  suite has to say so. `DSH_OPS_REQUIRE_RUNTIME=1` is set by the gate precisely so that
  the two runtimes cannot go missing quietly.

## What this gate cannot answer

The security-descriptor half of `ops_replace` on Windows (W1a–W1e) and the two
concurrency windows (W1g/W1h) need a host where DACLs are measurable and where one
process can hold a lock while another is mid-call. A DSH agent sandbox cannot do either:
under `workspace-write` Node cannot spawn the worker at all (`spawn EPERM`), and under
`danger-full-access` the worker's own atomic create is refused. That half stays a manual
checklist — `docs/windows-verification.md` §W1 and §W3, tracked in the issue linked from
there — and a hosted `windows-latest` runner can run it without a human, because a
runner is not an agent sandbox (the repository already measures DACLs in hosted tests).

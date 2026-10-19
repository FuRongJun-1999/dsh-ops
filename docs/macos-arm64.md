# macOS Apple Silicon (`darwin-arm64`)

0.3.1 supports Apple Silicon, not Intel Mac. Exact native targets are `win32-x64`, `linux-x64` and `darwin-arm64`; the npm `os`/`cpu` projection is not a promise that every combination works.

## Native worker and source build

Published runtime-bearing packages use `runtime/darwin-arm64/dsh-ops-worker` with a version/target/executable/SHA256 receipt. A Git checkout does not contain generated workers.

```console
npm ci --ignore-scripts
cargo build --release --locked --manifest-path native/Cargo.toml
node bin/native-runtime.mjs stage --platform darwin-arm64 --input native/target/release
node bin/native-runtime.mjs check --platform darwin-arm64
npm run verify
```

Use a supported Rust toolchain (release validation pins 1.97.1). A custom `CARGO_TARGET_DIR` or `cargo --target` requires the matching explicit stage `--input`; never stage an old default-directory build by accident. The resolver refuses missing/corrupt receipts and Intel Mac targets.

## Shells

Bash and PowerShell npm binary payloads remain **Windows-only optional dependencies**. npm must not install them on a Mac; there is no postinstall downloader. macOS `ops_bash` selects explicit `bashPath`, then PATH and Homebrew/system locations. Example:

```yaml
- id: dsh-ops-shell
  name: dsh-ops/shell
  config:
    bashPath: /opt/homebrew/bin/bash
```

`/bin/bash` is usable when Homebrew Bash is not installed. Restricted calls still require DSH confinement; unavailable confinement is an executor failure, never permission to run unconfined. The host disables its pwsh tool on macOS, so provisioning a pwsh executable does not create that tool.

## PTC and filesystem boundaries

- file and opt-in PTC use the independent Rust worker.
- PTC tools publish only in pure PTC presentation. `batch.root` must be absolute when supplied; result paging of a batch audit must use the same root when it differs from the session root.
- macOS `/tmp` and `/var` are system aliases. The file bridge canonicalizes the **parent chain**, preserving the final entry for no-follow checks. Descendants of those aliases work; directly naming a symlink still fails closed. Canonical write-root checks remain in force.
- `replace` on macOS requires APFS clone support to preserve extended ACL metadata. Unsupported clone operations fail before publication rather than dropping a deny entry. Ordinary mode/owner/xattrs are restored before the final fsync and rename.
- Hidden `.dsh-ops-update-*.lock` sidecars are stable cooperative path locks, not temporary debris. Do not delete them while writers may be active.

## Verification evidence

The manually dispatched three-platform workflow builds and tests a native Apple Silicon worker on an actual arm64 macOS runner. Final run links and the shipped artifact digests are recorded in the GitHub v0.3.1 Release. Contributor PR #67's earlier real-session observations are useful history, not a substitute for final integrated-head validation. Desktop GUI sessions still require a normal app restart after replacing the package.

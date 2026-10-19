# Roadmap

> Directional, not a schedule or a commitment. Priorities can change with
> upstream DSH releases and community feedback. Shipped work is recorded in
> [CHANGELOG.md](CHANGELOG.md).

## Shipped

- **0.3.0** — native Rust file tools and confined PTC batching (Windows x64).
- **0.3.1** — cross-platform: Windows x64, Linux x64 and macOS Apple Silicon
  (`darwin-arm64`). See [linux-build.md](linux-build.md) and
  [macos-arm64.md](macos-arm64.md).

## Next

### Platform coverage

- Windows ARM64 and Linux ARM64 targets.
- Intel Mac (`darwin-x64`).

### Tool surface (progressive disclosure)

- Lightweight DOCX and PDF tools, shipped as opt-in Rust tools that do not
  occupy the system prompt when disabled.
- Web search and crawl4ai-style HTML-to-Markdown tools.
- More PTC tools and bounded result projections.

### Documentation

- Keep the English/Chinese doc pairs in sync; expand the troubleshooting and
  Windows verification notes.

### Ecosystem

- Track upstream DSH releases (currently `0.2.0-rc.2`) and adapt the plugin
  APIs promptly.

## How to influence it

Open an issue describing the use case. See
[贡献指南.md](贡献指南.md) for the contribution workflow.

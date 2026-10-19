# Platform package skeletons

The two directories here are the **skeletons** of the platform packages this
plugin publishes, one per package, named `<kind>-<platform>-<arch>`:

| Skeleton | Published as | What it carries |
| --- | --- | --- |
| `bash-win32-x64/` | the bash package for Windows x64 | Git for Windows PortableGit, the pinned upstream release, unchanged |
| `pwsh-win32-x64/` | the pwsh package for Windows x64 | PowerShell 7, the pinned upstream release, unchanged |

Each skeleton holds only what is committed by hand: the package metadata and
this documentation. **No binary is ever committed here.**

## What the build puts in each package

`scripts/build-platform-packages.mjs` writes every package to
`<dist>/stage/<kind>-<platform>-<arch>/`:

```text
bash-win32-x64/  (and pwsh-win32-x64/)
├── package.json                    name and version injected, the rest from the skeleton
├── provenance.json                 the pin: repository, tag, asset name, URL, sha256,
│                                   bytes, the measured unpacked size (files and bytes),
│                                   unpacked layout, entry point and its digest, licence,
│                                   and copyright
├── bin/…                           the upstream runtime tree, digest-verified against the pin
└── README.md
```

**The pin is data, not a copy of the digests in prose.** `provenance.json` is
generated from the pin record read from `lib/shells.js`. The archive is
verified against the pin before it is unpacked, and the entry point against its
own recorded digest after. `--verify-upstream` re-derives each asset digest from
the live upstream release and deletes the download again, so a stale pin is one
command away from being caught.

## Where the names come from

**The package name lives in exactly one module.** `lib/shells.js`
(`PLATFORM_PACKAGES`) owns the shell names and therefore the scope. The build
script imports them and never spells a name out, which is why the skeleton
`package.json` files carry neither `name` nor `version` — a re-scoped release
is one edit in `lib/`, not a search-and-replace here.

The version of a platform package is always the version of the main package
(`package.json`), injected at build time so the two can never disagree.

## Injection

The main package's published copy declares both platform packages as exact
`optionalDependencies`, injected by the build script into the publish directory
only. An install on a platform they do not cover skips them instead of failing.

#!/usr/bin/env node
/**
 * Build and verify the two platform packages this plugin publishes.
 *
 * Both packages carry ready-to-run Windows payloads: bash and pwsh are complete,
 * digest-verified upstream runtime trees with their licenses preserved. Both are
 * injected as exact optional deps. Downloads happen during release assembly,
 * never in an install lifecycle hook.
 *
 * `--verify-upstream` keeps the packages honest: it downloads the pinned assets,
 * checks each one against the sha256 recorded here, and deletes them again. It
 * never runs as part of `all`.
 *
 * NAMES AND PINS ARE NOT DEFINED HERE WHEN SOMETHING ELSE OWNS THEM. The scope
 * and the shell package names come from `lib/shells.js` (`PLATFORM_PACKAGES`).
 * The shell pins are read from `lib/shells.js` too
 * when that module exports a pin table or a pin function (see
 * {@link resolveShellPin} for the shapes accepted); a module that exports
 * neither is an error, never a silent second copy of the pins in this file.
 * Re-scoping the release is therefore one edit in one module, and the pins have
 * exactly one definition per shell.
 *
 * PIPELINE. Each step is re-runnable on its own:
 *
 *   assemble      the two package directories, from the committed skeletons
 *                 in `packages/<kind>-<platform>-<arch>/` plus the verified
 *                 upstream tree and a per-package `provenance.json`
 *   pack          `npm pack` each directory, then write `SHA256SUMS` and the
 *                 release-wide `provenance.json`
 *   publish-dir   copy the main package into a temporary publish directory,
 *                 inject both platform payload packages and pack it
 *   check         verify every artifact without downloading or building
 *   fetch         download the pinned upstream assets and keep them
 *   verify-upstream  download them, verify the digests, delete them again
 *
 * Everything lands under `--dist` (default: `../dist`, a sibling of this
 * checkout so a build never writes into the source tree).
 *
 * Usage:
 *   node scripts/build-platform-packages.mjs [command] [flags]
 *
 * Commands (default: `all`):
 *   all | assemble | pack | publish-dir | check | fetch | verify-upstream
 *
 * Flags:
 *   --platform <p>     target platform (default: win32 — the only one published)
 *   --arch <a>         target architecture (default: x64)
 *   --dist <path>      artifact directory (default: ../dist)
 *   --proxy <url>      HTTP proxy for downloads (default: $HTTPS_PROXY/$HTTP_PROXY)
 *   --no-proxy         ignore the proxy environment
 *   --verify-upstream  alias for the `verify-upstream` command
 *   --force            re-download assets and rebuild stages
 *   --check            alias for the `check` command
 *
 * @module dsh-ops/build-platform-packages
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describePackages, stepAssemble } from './lib/build/assemble.js'
import { stepCheck } from './lib/build/check.js'
import { downloadPins, resolveProxy } from './lib/build/download.js'
import { printArtifactTable, stepPack } from './lib/build/pack.js'
import { stepPublishDir } from './lib/build/publish-dir.js'
import { REPO_ROOT, log } from './lib/build/util.js'

/** The two packages one release publishes, in publish order. */
const KINDS = Object.freeze(['bash', 'pwsh'])

// ---------------------------------------------------------------------------
// Step: fetch and verify-upstream
// ---------------------------------------------------------------------------

/**
 * Prove every pin still matches the upstream release it names.
 * @param {object} context - the run context.
 * @returns {Promise<void>} nothing.
 */
async function stepVerifyUpstream(context) {
  log('verify-upstream', 'downloading every pinned asset, verifying its digest, and deleting it again')
  const verdicts = await downloadPins(context, { keep: false })
  console.log(`\nupstream pins verified (${verdicts.length}):`)
  for (const verdict of verdicts) {
    console.log(`  ${verdict.package.padEnd(30)} ${verdict.pin.releaseTag.padEnd(18)} ${verdict.pin.assetName}`)
    console.log(`  ${''.padEnd(30)} sha256 ${verdict.pin.assetSha256}  ${verdict.pin.assetBytes} bytes  OK`)
  }
  console.log()
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * Parse the command line.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {object} the parsed options.
 */
function parseArgs(argv) {
  const commands = new Set(['all', 'assemble', 'pack', 'publish-dir', 'check', 'fetch', 'verify-upstream'])
  const options = {
    command: 'all',
    platform: 'win32',
    arch: 'x64',
    dist: path.resolve(REPO_ROOT, '..', 'dist'),
    proxy: undefined,
    noProxy: false,
    force: false,
  }
  const flags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      if (commands.has(argument)) options.command = argument
      else throw new Error(`unknown command: ${argument}`)
      continue
    }
    const [name, inline] = argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined]
    /**
     * The value of a flag that needs one.
     * @returns {string} the value.
     */
    const value = () => {
      if (inline !== undefined) return inline
      index += 1
      if (index >= argv.length) throw new Error(`${name} needs a value`)
      return argv[index]
    }
    switch (name) {
      case '--platform': options.platform = value(); break
      case '--arch': options.arch = value(); break
      case '--dist': options.dist = path.resolve(value()); break
      case '--proxy': options.proxy = value(); break
      case '--no-proxy': options.noProxy = true; break
      case '--force': options.force = true; break
      case '--check': options.command = 'check'; break
      case '--verify-upstream': options.command = 'verify-upstream'; break
      case '--help': flags.add('help'); break
      default: throw new Error(`unknown flag: ${name}`)
    }
  }
  return { ...options, help: flags.has('help') }
}

/** Print the usage block, taken from this file's own header. */
function printUsage() {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const start = source.indexOf(' * Usage:')
  const end = source.indexOf(' * @module')
  console.log(source.slice(start + 3, end).replace(/^ \* ?/gmu, '').trimEnd())
}

/**
 * Run the requested command.
 * @returns {Promise<void>} nothing.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    printUsage()
    return
  }
  const proxy = resolveProxy(options.proxy, options.noProxy)
  const context = {
    ...options,
    proxy,
    packages: describePackages(options.platform, options.arch, options.dist),
  }
  console.log(`dsh-ops platform packages: ${options.command} -> ${options.dist}`)
  console.log(`target ${options.platform}-${options.arch}`
    + (proxy === undefined ? ' (no proxy)' : ` (proxy http://${proxy.host}:${proxy.port})`))
  console.log(`platform packages: ${context.packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}`)

  const runStep = async (name, body) => {
    log(name, 'start')
    return body()
  }

  if (options.command === 'check') {
    const problems = await stepCheck(context)
    printArtifactTable(options.dist)
    process.exitCode = problems === 0 ? 0 : 1
    return
  }
  if (options.command === 'verify-upstream') {
    await runStep('verify-upstream', () => stepVerifyUpstream(context))
    return
  }
  if (options.command === 'fetch') {
    await runStep('fetch', () => downloadPins(context, { keep: true }))
    log('fetch', 'pinned assets are in place; `check` and `assemble` need none of them')
    return
  }

  let assembled = []
  if (['all', 'assemble', 'pack', 'publish-dir'].includes(options.command)) {
    await runStep('fetch', () => downloadPins(context, { keep: true }))
    assembled = await runStep('assemble', () => stepAssemble(context))
  }
  if (['all', 'pack', 'publish-dir'].includes(options.command)) {
    await runStep('pack', () => stepPack(context, assembled))
  }
  if (['all', 'publish-dir'].includes(options.command)) {
    await runStep('publish-dir', () => stepPublishDir(context, assembled))
  }
  if (options.command === 'all') {
    const problems = await stepCheck(context)
    if (problems > 0) throw new Error(`${problems} artifact(s) failed the post-build check`)
  }
  printArtifactTable(options.dist)
  log('done', `artifacts in ${options.dist}`)
}

await main().catch((error) => {
  console.error(`\nbuild-platform-packages: ${String(error?.message ?? error)}`)
  process.exitCode = 1
})

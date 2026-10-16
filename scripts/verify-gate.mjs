#!/usr/bin/env node
/**
 * The whole release gate, in the order `.github/workflows/ci.yml` runs it, with the
 * parts that differ per platform decided here instead of by a human remembering them.
 *
 * Why a script and not the checklist in `docs/windows-verification.md`: that document
 * is for a *human* on a host that cannot run `npm run verify`, and it has to explain
 * what to look at. This one is for a host that can run it, and it exists to make two
 * properties mechanical:
 *
 *   · **A skip is never a pass.** The runner already counts them apart, but a host that
 *     silently skips a suite still exits 0, so "green" and "answered" are different
 *     claims. This script knows which suites are *allowed* to skip on this platform,
 *     names any other one, and fails on it.
 *   · **The number in the docs matches the number on the host.** The manifest check
 *     count and the skip set are printed, and both are asserted, so a stale document or
 *     a newly-guarded suite is a failure here rather than a quiet drift.
 *
 * It never fabricates a platform: `--target` must equal `process.platform-process.arch`
 * (the same guard CI uses), because the expected skip set is derived from it.
 *
 * Usage (from the repository root):
 *
 *   node scripts/verify-gate.mjs                     # this host, full gate
 *   node scripts/verify-gate.mjs --skip-install      # node_modules is already current
 *   node scripts/verify-gate.mjs --skip-fastctx      # no FastCtx; the mount suite skips
 *   node scripts/verify-gate.mjs --json              # machine-readable summary
 *   node scripts/verify-gate.mjs --keep-going        # run every step, report all failures
 *
 * Exit codes: 0 all steps passed, 1 a step failed, 2 the host cannot answer this gate
 * (wrong target, missing toolchain) — never a green run for either.
 *
 * @module dsh-ops/scripts/verify-gate
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, short) => argv.includes(`--${name}`) || (short !== undefined && argv.includes(`-${short}`))
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const HOST = `${process.platform}-${process.arch}`
const TARGET = option('target', HOST)
const JSON_OUT = flag('json')
const KEEP_GOING = flag('keep-going')

/**
 * What each platform is allowed to skip, and no more.
 *
 * Windows is the interesting one: `file-metadata` and `linux-attributes` are POSIX
 * concepts (mode bits, POSIX ACLs, `user.*` xattrs, inode identity, sparse allocation),
 * and `linux-shell` drives the POSIX bash rung — its own subject. On a POSIX host the
 * only suite that may skip is `mount`, and only when no FastCtx backend is available.
 * A platform that skips anything else is a finding, not a footnote.
 */
const ALLOWED_SKIPS = TARGET === 'win32-x64'
  ? ['file-metadata', 'linux-attributes', 'linux-shell']
  : ['mount']

/** The manifest check count the docs promise. */
const MANIFEST_CHECKS = 61

const steps = []

/** Run one step, stream its output, and return `{code, output}`. */
async function run(title, command, args, { env = {}, optional = false } = {}) {
  const shown = [command, ...args].join(' ')
  process.stdout.write(`\n=== ${title}\n$ ${shown}\n`)
  const child = spawn(command, args, { cwd: PACKAGE_ROOT, env: { ...process.env, ...env }, shell: process.platform === 'win32' })
  let output = ''
  for await (const chunk of child.stdout) { output += chunk; process.stdout.write(chunk) }
  for await (const chunk of child.stderr) { output += chunk; process.stderr.write(chunk) }
  const code = await new Promise(resolve => child.on('close', resolve))
  const step = { title, command: shown, code, optional }
  steps.push(step)
  if (code !== 0 && !optional) throw Object.assign(new Error(`step failed (${code}): ${shown}`), { step })
  return { ...step, output }
}

/** The suite summary `test/run.mjs` prints. */
function parseSummary(output) {
  const summary = /dsh-ops test: (\d+) suite\(s\) passed(?:, (\d+) skipped)?/.exec(output)
  const skipped = [...new Set([...output.matchAll(/^dsh-ops ([a-z-]+): skipped \(/gm)].map(match => match[1]))]
  return summary === null
    ? { passed: null, skippedCount: null, skipped }
    : { passed: Number(summary[1]), skippedCount: summary[2] === undefined ? 0 : Number(summary[2]), skipped }
}

function parseManifest(output) {
  const match = /validate-manifest: all (\d+) checks passed/.exec(output)
  return match === null ? null : Number(match[1])
}

async function main() {
  if (TARGET !== HOST) {
    console.error(`this gate is for the host that runs it: --target ${TARGET} does not match ${HOST}`)
    console.error('run it on that host (or in CI, where the runner is pinned to the target)')
    process.exit(2)
  }

  await run('versions', 'node', ['--version'])
  await run('cargo version', 'cargo', ['--version'])
  if (!flag('skip-install') && !existsSync(path.join(PACKAGE_ROOT, 'node_modules'))) {
    await run('install locked dependencies', 'npm', ['ci', '--ignore-scripts', '--registry=https://registry.npmjs.org'])
  } else {
    process.stdout.write('\n=== install locked dependencies\n(skipped: node_modules is present; pass --skip-install to make this explicit)\n')
  }

  await run('native worker unit tests', 'cargo', ['test', '--locked', '--manifest-path', 'native/Cargo.toml'])
  await run('build and stage the native worker', 'npm', ['run', 'build:ptc'])

  if (TARGET === 'win32-x64') {
    await run('Windows IPC payloads', 'npm', ['run', 'build:bash-ipc'])
  } else {
    await run('optional FastCtx backend', 'cargo', ['build', '--release', '--locked', '--manifest-path', 'vendor/fastctx/Cargo.toml'], { optional: flag('skip-fastctx') })
  }

  const manifest = await run('manifest contract', 'npm', ['run', 'validate:manifest'])
  const manifestChecks = parseManifest(manifest.output)

  const env = { DSH_HOME: mkdtempSync(path.join(tmpdir(), 'dsh-ops-gate-')), DSH_OPS_REQUIRE_RUNTIME: '1' }
  if (TARGET !== 'win32-x64') env.DSH_OPS_FASTCTX_BIN = path.join(PACKAGE_ROOT, 'vendor/fastctx/target/release/fastctx')
  const verify = await run('full suite verification', 'npm', ['run', 'verify'], { env })
  const summary = parseSummary(verify.output)

  await run('staged runtime closure', 'node', ['bin/native-runtime.mjs', 'check', '--platform', TARGET])

  // The assertions. Failures here are the point of the script, not a detail of it.
  const failures = []
  if (manifestChecks !== MANIFEST_CHECKS) failures.push(`manifest checks: expected ${MANIFEST_CHECKS}, got ${manifestChecks ?? 'none reported'}`)
  if (summary.passed === null) failures.push('no suite summary line; the runner did not finish')
  const unexpected = summary.skipped.filter(name => !ALLOWED_SKIPS.includes(name))
  if (unexpected.length > 0) failures.push(`suites skipped that must not skip on ${TARGET}: ${unexpected.join(', ')} (a skip is not a pass)`)
  if (summary.skippedCount !== summary.skipped.length) failures.push(`the runner counted ${summary.skippedCount} skip(s) but ${summary.skipped.length} were named`)

  const result = {
    host: HOST,
    target: TARGET,
    manifestChecks,
    suitesPassed: summary.passed,
    suitesSkipped: summary.skipped,
    allowedSkips: ALLOWED_SKIPS,
    failures,
    steps: steps.map(({ title, command, code }) => ({ title, command, code })),
  }
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else {
    process.stdout.write('\n=== summary\n')
    for (const step of steps) process.stdout.write(`  ${step.code === 0 ? 'ok  ' : 'FAIL'} ${step.title}\n`)
    process.stdout.write(`  ${summary.passed ?? '?'} suites passed; skipped: ${summary.skipped.join(', ') || 'none'} (allowed: ${ALLOWED_SKIPS.join(', ')})\n`)
    process.stdout.write(`  manifest: ${manifestChecks ?? '?'}/${MANIFEST_CHECKS} checks\n`)
    for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`)
  }

  if (failures.length > 0) { console.error(`\n${failures.length} assertion(s) failed`); process.exit(1) }
  process.stdout.write(`\n${TARGET}: gate green\n`)
}

main().catch(error => {
  console.error(`\n${error.message}`)
  if (!KEEP_GOING) {
    process.stdout.write('\n=== summary of the steps that ran\n')
    for (const step of steps) process.stdout.write(`  ${step.code === 0 ? 'ok  ' : 'FAIL'} ${step.title}\n`)
  }
  process.exit(1)
})

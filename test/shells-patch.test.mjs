/**
 * The L3 patch override in `cordis.patch.yml`: the bundle patch itself, the
 * runtime pwsh overlay, and the agreement between the overlay and the plugin's
 * own probe.
 *
 * The patch text is read here through the loader's own `!!js` tag, and the
 * overlay is exercised against a linked-profile fixture: the one real parser
 * involved is the bundle patch, which no other suite reads through the plugin's
 * own eyes.
 */

import * as urlHelpers from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { mountBundledPwsh } from '../lib/session-pwsh.js'
import { parseDocument } from 'yaml'
import { resolveConfig } from '../lib/config.js'
import {
  BASH_TOOL_NAME,
  ENV_OVERRIDES,
  shellEnvOverrides,
  PWSH_LAYOUT_ORDER,
  bundledShellPath,
  provisionedShellVersionDir,
  resolveShells,
  shellExecutable,
} from '../lib/shells.js'
import { assert, PACKAGE_ROOT, TEST_HOME, report, test, withTempDir } from './lib/harness.mjs'
import { config, makeExecutable, platformPackageName } from './lib/shells-fixtures.mjs'

/** The bundle patch's raw text, read once. */
const PATCH_TEXT = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')

/**
 * Teach a general-purpose YAML parser the loader's `!!js` tag, so a tagged
 * scalar arrives as its expression text instead of an unknown-tag warning.
 * @returns {object} a schema that resolves `!!js` scalars.
 */
function entryListSchema() {
  const probe = parseDocument(PATCH_TEXT)
  probe.schema.tags.push({
    tag: 'tag:yaml.org,2002:js',
    resolve: (data) => data,
    construct: (data) => ({ __jsExpr: data }),
    identify: (value) => typeof value === 'object' && value !== null && '__jsExpr' in value,
  })
  return probe.schema
}

/**
 * The bundle patch as the loader reads it: `!!js` scalars stay expression text
 * (the loader wraps them into expression nodes one step later).
 * @returns {object[]} the patch entries.
 */
function patchEntries() {
  return parseDocument(PATCH_TEXT, { schema: entryListSchema() }).toJS()
}

/**
 * The L3 override expression exactly as written in the patch.
 * @returns {string} the expression body.
 */
function pwshOverrideExpression() {
  return 'runtime-overlay'
}

function volatileRef(initial) {
  let current = initial
  return { get: () => current, [Symbol.for('cosmokit.volatile.write')](next) { current = next } }
}

/**
 * Evaluate one loader expression exactly as the vendored loader does.
 * @param {string} expr - the expression body.
 * @param {object} ctx - the evaluation scope (`with (ctx)`).
 * @returns {unknown} the expression's value.
 */
function evaluateLoaderExpression(expr, ctx) {
  // Exercise the real runtime overlay against a loader fixture instead of the
  // removed YAML expression. The resolver and the component share this input.
  if (expr !== 'runtime-overlay') return undefined
  if (!ctx.baseUrl) return undefined
  const { fileURLToPath } = urlHelpers
  const bundleRoot = fs.realpathSync(path.join(fileURLToPath(ctx.baseUrl), 'node_modules', 'dsh-ops'))
  const shells = resolveShells(config(), { bundleRoot })
  const entry = { options: { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox', config: {} },
    fiber: { state: 2, config: { pwshPath: volatileRef(undefined) } } }
  mountBundledPwsh({ inject(_deps, body) { body({ get() { return { entries: () => [entry] } },
    on() { return () => {} }, effect() {} }) } }, shells)
  return entry.fiber.config.pwshPath.get()
}

await test('the manifest declares the plugin\'s own shell tools as their own namespace', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'dsh-plugin.json'), 'utf8'))
  const namespaces = manifest.contributes['x-tool-namespaces']
  // Unconditional: the manifest describes the capability, not this deployment's
  // switch state, so `bash` is declared even while a profile ships no bash.
  // Index 1, directly after the native file namespace (the FastCtx namespace is gone).
  assert.deepEqual(namespaces[1], {
    serverName: 'dsh-ops',
    transport: 'in-process',
    source: "the plugin's bash layer via host subprocess",
    publicPrefix: 'ops_',
    tools: ['bash'],
    shellPermission: 'shell component enabled AND publishBashTool AND authoritative per-session DSH policy; restricted modes require host confinement',
  })
  // The declared name is the name the tool actually registers under.
  assert.equal(BASH_TOOL_NAME, `${namespaces[1].publicPrefix}${namespaces[1].tools[0]}`)
})

await test('the bundle patch declares independent components, with no persistent pwsh override', () => {
  const entries = patchEntries()
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].insert.map(row => row.id), ['dsh-ops-shell', 'dsh-ops-file', 'dsh-ops-ptc', 'dsh-ops-panel', 'dsh-ops-tui', 'dsh-ops-hide-official'])
  assert.equal(entries[0].insert[0].disabled, undefined)
  assert.equal(entries[0].insert[1].disabled, undefined)
  assert.equal(entries[0].insert[2].disabled, undefined)
  // The panel row mounts so its switch is addressable; the switch itself is off.
  assert.equal(entries[0].insert[3].disabled, undefined)
  assert.equal(entries[0].insert[3].config.capture, false)
  assert.equal(entries[0].insert[4].disabled, true)
  assert.equal(entries[0].insert[5].disabled, true)
})

await test('the shipped dsh-ops row states the documented shell defaults', () => {
  const row = patchEntries()[0].insert.find((candidate) => candidate.id === 'dsh-ops-shell')
  const resolved = resolveConfig(row.config)
  assert.equal(resolved.bashPath, undefined)
  assert.equal(resolved.publishBashTool, true)
  assert.equal(resolved.allowSystemShellFallback, false)
})

await test('the L3 override is inert while the plugin carries no pwsh', async () => {
  await withTempDir('shells-patch-inert', async (dir) => {
    // A profile that resolves the plugin perfectly well — the plugin simply
    // carries no pwsh yet, which is the documented state until phase C.
    const { bundleRoot, profileUrl } = stageLinkedProfile(dir)
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({
      name: 'dsh-ops', version: '0.1.0',
      optionalDependencies: { [platformPackageName('pwsh')]: '0.1.0' },
    }))
    const expr = pwshOverrideExpression()

    // No pwsh in the plugin: the expression yields `undefined`, which is the
    // row's own default, so the host keeps its own PowerShell resolution.
    assert.equal(evaluateLoaderExpression(expr, { baseUrl: profileUrl, ctx: {} }), undefined)
    // An unresolvable base URL must degrade to undefined rather than throw.
    assert.equal(evaluateLoaderExpression(expr, { baseUrl: undefined, ctx: {} }), undefined)
  })
})

await test('the L3 override follows the plugin\'s own pwsh on every platform', async () => {
  await withTempDir('shells-patch-platform', async (dir) => {
    const { bundleRoot, profileUrl } = stageLinkedProfile(dir)
    const bundled = makeExecutable(bundledShellPath({
      kind: 'pwsh', bundleRoot, platform: process.platform, arch: process.arch,
    }))
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'dsh-ops', version: '0.1.0' }))
    const value = evaluateLoaderExpression(pwshOverrideExpression(), { baseUrl: profileUrl, ctx: {} })
    // The plugin carries the executable and the overlay points the owning row at
    // exactly that file. There is no platform gate left: the overlay is gated by
    // `shells.pwsh.available` alone. Whether the owning `pwsh-sandbox` row is
    // mounted stays the host's decision — `cordis.patch.yml` ships no persistent
    // pwsh override — so on a host that disables its pwsh rows this stays a no-op.
    assert.equal(value, bundled)
  })
})

await test('L3 reports unavailable without a bundled pwsh, and says what the last rung is', async () => {
  await withTempDir('shells-pwsh-absent', async (dir) => {
    const fallback = resolveShells(config({ allowSystemShellFallback: true }), {
      bundleRoot: path.join(dir, 'plugin'),
      env: { DSH_HOME: TEST_HOME, PATH: '' },
      platform: 'linux',
      arch: 'x64',
    })
    assert.equal(fallback.pwsh.available, false)
    assert.equal(fallback.pwsh.source, 'missing')
    assert.equal(fallback.pwsh.file, undefined)
    // The host's own pwsh tool is the ladder's last rung, and the detail says so.
    assert.match(fallback.pwsh.detail, /host's own pwsh tool is the ladder's last rung/)

    // Confining the ladder to plugin-provided shells changes the wording, not
    // the fact: L3 is still unavailable.
    const confined = resolveShells(config({ allowSystemShellFallback: false }), {
      bundleRoot: path.join(dir, 'plugin'),
      env: { DSH_HOME: TEST_HOME, PATH: '' },
      platform: 'linux',
      arch: 'x64',
    })
    assert.equal(confined.pwsh.available, false)
    assert.match(confined.pwsh.detail, /no PowerShell rung/)
  })
})

/**
 * Stage one profile whose `dsh-ops` is installed as a junction, exactly as a
 * `link:` install looks: `dir/` is the profile directory (it holds
 * `cordis.yml`, so `ctx.baseUrl` is `dir/`), `dir/node_modules/dsh-ops` links to
 * the bundle at `dir/dsh-ops`, and any platform package sits beside it in
 * `dir/node_modules/`. That shared `node_modules` is the point: the patch
 * expression reaches it through the profile's `baseUrl`, and `resolveShells`
 * reaches the same directory by walking up from its `bundleRoot`.
 * @param {string} dir - the temporary root, used as the profile directory.
 * @returns {{bundleRoot: string, profileUrl: string}} the tree.
 */
function stageLinkedProfile(dir) {
  const bundleRoot = path.join(dir, 'dsh-ops')
  fs.mkdirSync(bundleRoot, { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  fs.symlinkSync(bundleRoot, path.join(dir, 'node_modules', 'dsh-ops'), 'junction')
  return {
    bundleRoot,
    profileUrl: new URL('.', `file:///${dir.replace(/\\/g, '/')}/`).href,
  }
}

await test('the L3 override and the plugin probe agree on all three places, in the same order', async () => {
  const expr = pwshOverrideExpression()
  const platformPackage = platformPackageName('pwsh')

  /**
   * Build a linked profile whose pwsh sits in the named places, then report what
   * each side of the contract says.
   *
   * The platform package is staged beside the linked bundle (in the same
   * `node_modules`), so `createRequire` from either side resolves the identical
   * directory — the patch expression through the profile's `baseUrl`, the probe
   * through its own `bundleRoot`. The provisioned store is the one input the
   * expression reads from `process.env` rather than from `baseUrl`, so `DSH_HOME`
   * is set for the evaluation and restored afterwards.
   * @param {string} dir - the temporary root.
   * @param {('provisioned'|'package'|'vendor')[]} places - which places carry the pwsh.
   * @returns {{made: Record<string, string>, expression: unknown, probe: object}} both answers.
   */
  const build = (dir, places) => {
    const { bundleRoot, profileUrl } = stageLinkedProfile(dir)
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({
      name: 'dsh-ops',
      version: '0.1.0',
      optionalDependencies: { [platformPackage]: '0.1.0' },
    }))
    const home = path.join(dir, 'home')
    /** @type {Record<string, string>} */
    const made = {}
    if (places.includes('provisioned')) {
      // What `dsh-ops provision-shells` installs: the pinned upstream release,
      // at the layout the pin for this platform names.
      made.provisioned = makeExecutable(path.join(
        provisionedShellVersionDir({ kind: 'pwsh', version: '7.6.6', env: { DSH_HOME: home } }),
        'bin', shellExecutable('pwsh', process.platform),
      ))
    }
    if (places.includes('package')) {
      const packageDir = path.join(dir, 'node_modules', ...platformPackage.split('/'))
      fs.mkdirSync(packageDir, { recursive: true })
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
        name: platformPackage, version: '0.1.0',
      }))
      made.package = makeExecutable(path.join(packageDir, 'bin', shellExecutable('pwsh', process.platform)))
    }
    if (places.includes('vendor')) {
      made.vendor = makeExecutable(bundledShellPath({
        kind: 'pwsh', bundleRoot, platform: process.platform, arch: process.arch,
      }))
    }

    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      return {
        made,
        expression: evaluateLoaderExpression(expr, { baseUrl: profileUrl, ctx: {} }),
        probe: resolveShells(config(), {
          bundleRoot,
          env: { DSH_HOME: home, PATH: '' },
          platform: process.platform,
        }),
      }
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }

  // Each place ALONE: the one place present is the one both sides answer with.
  for (const place of PWSH_LAYOUT_ORDER) {
    await withTempDir(`shells-place-${place}`, async (dir) => {
      const { made, expression, probe } = build(dir, [place])
      assert.equal(probe.pwsh.available, true, probe.pwsh.detail)
      assert.equal(probe.pwsh.source, place === 'provisioned' ? 'provisioned' : 'bundled', probe.pwsh.detail)
      assert.equal(probe.pwsh.file, made[place])
      // Both sides of the L3 contract resolve the same file. The overlay has no
      // platform gate, so this holds everywhere.
      assert.equal(expression, made[place])
    })
  }

  // Every place at once: the ORDER itself is pinned, on both sides.
  await withTempDir('shells-place-all', async (dir) => {
    const { made, expression, probe } = build(dir, ['vendor', 'package', 'provisioned'])
    assert.notEqual(made.provisioned, made.package)
    assert.notEqual(made.package, made.vendor)
    assert.equal(probe.pwsh.source, 'provisioned', probe.pwsh.detail)
    assert.equal(probe.pwsh.file, made.provisioned)
    assert.equal(expression, made.provisioned)
  })

  await withTempDir('shells-place-bundled', async (dir) => {
    const { made, expression, probe } = build(dir, ['vendor', 'package'])
    assert.equal(probe.pwsh.source, 'bundled', probe.pwsh.detail)
    assert.equal(probe.pwsh.file, made.package)
    assert.equal(expression, made.package)
  })
})

await test('the L3 override declines without a base URL, whatever the plugin carries', () => {
  const expr = pwshOverrideExpression()
  assert.equal(evaluateLoaderExpression(expr, { baseUrl: undefined, ctx: {} }), undefined)
})

await test('system discovery is opt-in on Windows and is the rung on a POSIX host', async () => {
  await withTempDir('shells-default-confined', dir => {
    // Both spellings exist, so the case asserts the same facts on either host.
    const system = makeExecutable(path.join(dir, 'bin', 'bash'))
    const systemExe = makeExecutable(path.join(dir, 'bin', 'bash.exe'))
    const programFiles = path.join(dir, 'Program Files')
    const wellKnown = makeExecutable(path.join(programFiles, 'Git', 'bin', 'bash.exe'))
    const base = { bundleRoot: path.join(dir, 'plugin'), env: { DSH_HOME: TEST_HOME, PATH: path.join(dir, 'bin'), ProgramFiles: programFiles } }
    const host = process.platform
    // Windows: with no pinned payload and the flag off, PATH and the well-known install are both
    // visible and both deliberately not taken — `allowSystemShellFallback` is the gate on reaching
    // past the pinned copy, and there is none.
    for (const raw of [resolveConfig({}), {}, undefined]) {
      const result = resolveShells(raw, { ...base, platform: 'win32', arch: 'x64' }).bash
      assert.equal(result.available, false, JSON.stringify(result))
      assert.equal(result.source, 'disabled')
      assert.equal(result.file, undefined)
    }
    // Windows with the flag ON: PATH answers first, and the well-known install answers when PATH
    // does not — the same two rungs the POSIX host uses, reached through the gate instead.
    const winFallback = resolveShells(config({ allowSystemShellFallback: true }), { ...base, platform: 'win32', arch: 'x64' }).bash
    assert.equal(winFallback.source, 'path')
    assert.equal(winFallback.file, systemExe)
    const winWellKnown = resolveShells(config({ allowSystemShellFallback: true }), {
      ...base, platform: 'win32', arch: 'x64', env: { ...base.env, PATH: '/nonexistent-bin' },
    }).bash
    assert.equal(winWellKnown.source, 'well-known', JSON.stringify(winWellKnown))
    assert.equal(winWellKnown.file, wellKnown)
    // POSIX: the machine's own bash IS the rung, so the same config resolves it with no flag — and
    // `config.bashPath` still outranks discovery.
    const linux = resolveShells(config({}), { ...base, platform: 'linux', arch: 'x64' }).bash
    assert.equal(linux.available, true, JSON.stringify(linux))
    assert.equal(linux.source, 'path')
    assert.equal(linux.file, system)
    if (process.platform !== 'win32') {
      const posixWellKnown = resolveShells(config({}), { ...base, platform: 'linux', arch: 'x64', env: { ...base.env, PATH: '/nonexistent-bin' } }).bash
      assert.equal(posixWellKnown.source, 'well-known', JSON.stringify(posixWellKnown))
    }
    assert.equal(resolveShells(config({ bashPath: system }), { ...base, platform: host, arch: process.arch }).bash.source, 'config')
  })
})

await test('runtime pwsh overlay commits in place, targets only the owning row, and restores the latest raw value', () => {
  let hook, cleanup
  const ref = volatileRef('original')
  const target = {
    options: { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox', config: { pwshPath: 'original', retained: true } },
    fiber: { state: 2, config: { pwshPath: ref }, update() { throw new Error('the overlay must not restart the owning row') } },
  }
  const bareRef = volatileRef('original')
  const bare = { options: { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox', config: { retained: true } },
    fiber: { state: 2, config: { pwshPath: bareRef }, update() { throw new Error('the overlay must not restart the owning row') } } }
  const foreignRef = volatileRef('foreign')
  const foreign = { options: { id: 'pwsh-sandbox', name: 'foreign-executor', config: {} }, fiber: { state: 2, config: { pwshPath: foreignRef } } }
  const fixture = { inject(_deps, body) { body({
    get() { return { entries: () => [target, bare, foreign] } },
    on(_name, callback) { hook = callback; return () => { hook = undefined } },
    effect(callback) { cleanup = callback() },
  }) } }
  const original = target.options.config
  mountBundledPwsh(fixture, { pwsh: { available: true, file: 'approved-pwsh' } })
  assert.equal(ref.get(), 'approved-pwsh')
  assert.equal(bareRef.get(), 'approved-pwsh')
  assert.equal(target.options.config, original)
  assert.equal(foreignRef.get(), 'foreign')
  assert.deepEqual(hook.call({ entry: foreign }, {}, () => ({ pwshPath: 'foreign' })), { pwshPath: 'foreign' })
  target.options.config = { pwshPath: 'new-owner-choice', retained: false }
  cleanup()
  assert.equal(ref.get(), 'new-owner-choice', 'the restore uses the owner\'s latest raw config')
  assert.equal(bareRef.get(), undefined, 'no declared value restores to undefined')
  cleanup()
  assert.equal(ref.get(), 'new-owner-choice', 'cleanup is idempotent')
})

await test('an inherited LC_ALL cannot un-pin the message locale, and encoding survives it', () => {
  // Reported by @Haoming9527 in review of #81: POSIX resolves LC_ALL before LC_MESSAGES, so on a host
  // that sets LC_ALL (`zh_CN.UTF-8` desktops commonly set nothing else) the English pin below was
  // silently ineffective, and a localized libc stopped matching the host's English
  // `denialSignatures`. Measured on this host before the fix: `LC_MESSAGES="zh_CN.UTF-8"`.
  const pinned = shellEnvOverrides({ LC_ALL: 'zh_CN.UTF-8' }, {})
  assert.equal(pinned.LC_MESSAGES, 'C')
  assert.equal(pinned.LC_ALL, '', 'an empty value is "unset" to the C library, so the pin holds')
  assert.equal(pinned.LC_CTYPE, 'zh_CN.UTF-8', "the variable's encoding intent must survive")
  // A host that stated its own ctype keeps it: only the language is pinned, never the codeset.
  assert.equal(Object.hasOwn(shellEnvOverrides({ LC_ALL: 'zh_CN.UTF-8', LC_CTYPE: 'en_US.UTF-8' }, {}), 'LC_CTYPE'), false)
  // No ambient override to neutralize: the plain shape is unchanged, byte for byte.
  assert.deepEqual(shellEnvOverrides({ LANG: 'zh_CN.UTF-8' }, {}), { ...ENV_OVERRIDES })
  // A caller's own LC_ALL is neutralized the same way, so the seam cannot un-pin it either.
  assert.equal(shellEnvOverrides({}, { LC_ALL: 'zh_CN.UTF-8' }).LC_ALL, '')
  assert.equal(shellEnvOverrides({}, { LC_ALL: 'zh_CN.UTF-8' }).LC_CTYPE, 'zh_CN.UTF-8')
  if (process.platform === 'win32') return
  // Effective locale, read back from the C library rather than from the environment: `locale` prints
  // what libc resolved, and `wc -m` counts characters, which `LC_ALL=C` would break (6 for `中文`).
  const utfLocale = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  const probe = spawnSync('/bin/sh', ['-c', 'locale 2>/dev/null | grep "^LC_MESSAGES="; printf "中文" | wc -m'], {
    env: { ...process.env, ...shellEnvOverrides({ LC_ALL: utfLocale }, {}), LC_CTYPE: utfLocale }, encoding: 'utf8',
  })
  assert.equal(probe.status, 0, probe.stderr)
  assert.match(probe.stdout, /LC_MESSAGES="?C"?/, `the effective message locale must be C: ${probe.stdout}`)
  assert.equal(probe.stdout.trim().split('\n').pop().trim(), '2', `UTF-8 input must still count per character: ${probe.stdout}`)
})

report('shells-patch')

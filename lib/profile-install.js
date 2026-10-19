/** Profile operations delegate to the official CLI instead of reimplementing its locks and rollback. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { PACKAGE_ROOT, dshHome } from './paths.js'
import { PLATFORMS } from './ptc/runtime.js'

/**
 * Architectures this fork will run its profile commands on.
 *
 * Upstream refused anything but `win32-x64`. The commands below only drive the
 * official DSH CLI and a package manager, both of which are platform neutral;
 * the native payloads are a separate question with their own gate in
 * `lib/ptc/runtime.js`.
 */
const SUPPORTED_TARGETS = Object.freeze({ win32: ['x64'], linux: ['x64'], darwin: ['arm64'] })

/**
 * Where each platform's desktop application keeps its own CLI.
 *
 * The desktop profile is Electron-owned: an ordinary `dsh` refuses to manage it,
 * so the carrier's bundled launcher is the only supported entry point.
 */
function desktopCliCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData/Local')
    return [path.join(local, 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd')]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      path.join(home, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'),
    ]
  }
  return []
}

export function profileCommand(operation, { profile, dshCli, dryRun = false }) {
  if (!(SUPPORTED_TARGETS[process.platform] ?? []).includes(process.arch)) throw new Error(`Supported targets: ${PLATFORMS.join(', ')}; unsupported host ${process.platform}-${process.arch}.`)
  const aliases = { desktop: 'desktop', web: 'web', tui: 'dsh-tui', 'dsh-tui': 'dsh-tui' }
  if (!Object.hasOwn(aliases, profile ?? '')) throw new Error('Explicit --profile desktop|web|tui is required (tui maps to dsh-tui).')
  const target = aliases[profile]
  const directory = path.join(dshHome(), 'profiles', target)
  if (!fs.existsSync(path.join(directory, 'package.json'))) throw new Error(`Initialize the target DSH application/profile first: ${directory}`)
  const version = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
  if (operation === 'status') {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    console.log(JSON.stringify({ profile: target, directory, dependency: manifest.dependencies?.['dsh-ops'] ?? null, enabled: (manifest.dsh?.profile?.bundles ?? []).includes('dsh-ops') }, null, 2))
    return 0
  }
  const args = ['plugin', '--profile', target, operation === 'install' ? 'add' : 'remove',
    operation === 'install' ? (process.env.DSH_OPS_INSTALL_SPEC ?? `dsh-ops@${version}`) : 'dsh-ops']
  let command = dshCli ?? process.env.DSH_OPS_DSH_CLI
  let prefix = []
  if (!command && target === 'desktop') {
    command = desktopCliCandidates().find(file => fs.existsSync(file))
    if (!command) throw new Error('Desktop requires its own CLI. Pass --dsh-cli <installation>/resources/runtime/cli/bin/dsh; ordinary dsh cannot manage desktop.')
  }
  if (!command) {
    const globalNpm = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm/node_modules/_anchor.json') : undefined
    for (const anchor of [path.join(directory, 'package.json'), path.join(dshHome(), 'package.json'), globalNpm].filter(Boolean)) {
      try {
        const require = createRequire(anchor)
        const file = require.resolve('@deepseek-ai/dsh/package.json')
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
        if (bin) { command = process.execPath; prefix = [path.resolve(path.dirname(file), bin)]; break }
      } catch {}
    }
    if (!command) {
      if (process.platform === 'win32') {
        const desktopCli = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd')
        command = fs.existsSync(desktopCli) ? desktopCli : 'dsh.cmd'
      } else {
        // POSIX has no `dsh.cmd` and no `cmd.exe` to launch it with: selecting the Windows wrapper
        // made the fallback fail as `spawnSync cmd.exe ENOENT` even with an executable `dsh` on PATH.
        // The official CLI there is the `dsh` entry point itself. Reported by @Haoming9527 in review
        // of #81.
        command = 'dsh'
      }
    }
  }
  console.log(`Target: ${target} (${directory})`)
  console.log(`Official CLI: ${command}; ${args.join(' ')}`)
  if (dryRun) return 0
  let result
  if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
    // cmd wrappers are Windows-owned launchers; reject shell metacharacters in caller-supplied paths.
    if (/["\r\n&|<>^%!]/.test(command)) throw new Error('Unsafe CLI path; use a path without cmd metacharacters.')
    result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${command}" ${args.join(' ')}"`], { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true })
  } else result = spawnSync(command, [...prefix, ...args], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) return result.status ?? 1
  console.log(operation === 'install'
    ? 'Installed through the official profile manager. Reload/restart the target application if needed. Binaries are profile dependencies; no postinstall downloads.'
    : 'Removed through the official profile manager, including its runtime dependency references. Package-manager shared caches are not deleted.')
  return 0
}

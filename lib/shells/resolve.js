/**
 * Resolution of the plugin's two shell rungs: its own bash and PowerShell 7.
 *
 * Together with the probes in `lib/shells/paths.js`, this module is the ONLY
 * place that answers "can this deployment run the plugin's bash / pwsh right
 * now, and where is the executable". A rung that
 * cannot be resolved reports `available: false` with the reason; it never
 * throws, so a missing shell degrades the prompt ladder instead of failing the
 * plugin.
 *
 * Contract: {@link resolveShells} is called synchronously during mount and its
 * result feeds the prompt ladder (`lib/policy.js` renders only the available
 * rungs). The other half of the contract — `publishShellTools`, called inside
 * one `ctx.effect` during mount — lives in `lib/shells/publish.js`.
 *
 * The bash rung's order is explicit config, the provisioned copy, the plugin's
 * own copy, then — only while the deployment allows a system shell — `PATH`
 * and the well-known install locations. On POSIX the machine's own bash IS the
 * rung (see `lib/shells/pins.js` for why there is no pinned POSIX payload), so
 * that gate is skipped there.
 *
 * @module dsh-ops/shells/resolve
 */

import { PACKAGE_ROOT } from '../paths.js'
import {
  POSIX_BASH_REMEDY,
  bashRemedy,
  bundledShell,
  executableNames,
  fromPath,
  isSpawnableFile,
  isWslBashLauncher,
  provisionedShell,
  wellKnownCandidates,
} from './paths.js'

/** The directory this module was loaded from; the resolution root of a checkout. */
const MODULE_ROOT = PACKAGE_ROOT

/**
 * Resolve the bash rung: explicit config, the provisioned copy, the plugin's own
 * copy, then — only while the deployment allows a system shell — PATH and the
 * well-known install locations.
 *
 * A configured path is authoritative: when it is unusable the rung reports
 * `available: false` instead of quietly running a different shell.
 * @param {object} options - resolution inputs.
 * @param {string|undefined} options.configured - the configured executable.
 * @param {{file: string, version: string}|undefined} options.provisioned - the
 *   copy `provision-shells` installed, when the store has one.
 * @param {string|undefined} options.bundled - the plugin's own executable, when it has one.
 * @param {string|undefined} options.bundledDetail - why the plugin's own copy is unusable, when it has none.
 * @param {import('./paths.js').BundledCause|undefined} options.bundledCause - the same reason in machine-readable form;
 *   it decides which remedy the detail ends with.
 * @param {boolean} options.allowSystemFallback - whether system installations may be used.
 * @param {NodeJS.ProcessEnv} options.env - the environment to read.
 * @param {string} options.platform - `process.platform`.
 * @returns {import('./paths.js').ShellResolution} the resolution.
 */
function resolveBash({
  configured,
  provisioned,
  bundled,
  bundledDetail,
  bundledCause,
  allowSystemFallback,
  env,
  platform,
  posix = platform !== 'win32',
}) {
  if (configured !== undefined) {
    return isSpawnableFile(configured)
      ? { available: true, file: configured, source: 'config', detail: 'configured bash executable' }
      : {
        available: false,
        file: undefined,
        source: 'config',
        detail: `the configured bash executable does not exist: ${configured}`,
      }
  }
  if (provisioned !== undefined) {
    return {
      available: true,
      file: provisioned.file,
      source: 'provisioned',
      detail: `the bash this deployment provisioned from upstream (version ${provisioned.version})`,
    }
  }
  if (bundled !== undefined) {
    return {
      available: true,
      file: bundled,
      source: 'bundled',
      detail: "the plugin's own bash",
    }
  }
  // On POSIX the machine's own bash is the rung, not a fallback: there is no pinned payload to
  // prefer it to, and `allowSystemShellFallback` exists to gate reaching *past* one. The gate is
  // therefore skipped there and resolution is PATH -> well-known, in that order.
  if (!allowSystemFallback && !posix) {
    return {
      available: false,
      file: undefined,
      source: 'disabled',
      detail: 'no provisioned or bundled bash and allowSystemShellFallback is false'
        + (bundledDetail === undefined ? '' : ` (${bundledDetail})`)
        + `; ${bashRemedy(bundledCause)}`,
    }
  }
  const onPath = fromPath({
    names: executableNames('bash', platform),
    pathValue: env.PATH ?? env.Path,
    reject: file => isWslBashLauncher(file, env, platform),
  })
  if (onPath !== undefined) {
    return {
      available: true,
      file: onPath,
      source: 'path',
      detail: posix ? "the host distribution's own bash, found on PATH" : 'bash found on PATH',
    }
  }
  for (const candidate of wellKnownCandidates({ kind: 'bash', env, platform })) {
    if (isSpawnableFile(candidate)) {
      return {
        available: true,
        file: candidate,
        source: 'well-known',
        detail: posix ? "the host distribution's own bash, at a well-known location" : 'well-known bash install',
      }
    }
  }
  return {
    available: false,
    file: undefined,
    source: 'missing',
    detail: 'no bash found by config, a provisioned copy, a bundled copy, PATH, or a well-known '
      + 'install location'
      + (bundledDetail === undefined ? '' : ` (${bundledDetail})`)
      + `; ${posix ? POSIX_BASH_REMEDY : bashRemedy(bundledCause)}`,
  }
}

/**
 * Resolve the PowerShell 7 rung.
 *
 * L3 is "the plugin's own pwsh 7", and whether that rung runs is decided by the
 * executable it needs actually being there: `cordis.patch.yml` points the
 * host's `pwsh-sandbox` row at this same path whenever it exists, so
 * `available` here and the host row's behaviour are one fact, not two. There is
 * deliberately no configured-path form: the row the plugin would have to
 * rewrite is resolved before any dsh-ops config is read.
 * @param {object} options - resolution inputs.
 * @param {{file: string, version: string}|undefined} options.provisioned - the
 *   copy `provision-shells` installed, when the store has one.
 * @param {string|undefined} options.bundled - the plugin's own pwsh, when it has one.
 * @param {string|undefined} options.bundledDetail - why the plugin's own copy is unusable, when it has none.
 * @param {boolean} options.allowSystemFallback - whether the host's pwsh may serve as the last rung.
 * @returns {import('./paths.js').ShellResolution} the resolution.
 */
function resolvePwsh({ provisioned, bundled, bundledDetail, allowSystemFallback }) {
  if (provisioned !== undefined) {
    return {
      available: true,
      file: provisioned.file,
      source: 'provisioned',
      detail: 'the PowerShell 7 this deployment provisioned from upstream '
        + `(version ${provisioned.version}), which the pwsh-sandbox override points at`,
    }
  }
  if (bundled !== undefined) {
    return {
      available: true,
      file: bundled,
      source: 'bundled',
      detail: "the plugin's own PowerShell 7, which the pwsh-sandbox override points at",
    }
  }
  return {
    available: false,
    file: undefined,
    source: 'missing',
    detail: 'the plugin carries no PowerShell 7 for this platform'
      + (bundledDetail === undefined ? '' : ` (${bundledDetail})`)
      + '; run `dsh-ops provision-shells --pwsh` to install the pinned upstream copy'
      + (allowSystemFallback
        ? "; the host's own pwsh tool is the ladder's last rung"
        : '; allowSystemShellFallback is false, so the ladder has no PowerShell rung'),
  }
}

/**
 * Resolve both shell rungs for this configuration.
 *
 * Synchronous, side-effect free, and total: every failure mode becomes a
 * resolution with `available: false`, never a throw, because this runs during
 * mount where an exception would take the whole plugin down.
 * @param {import('../config.js').ResolvedConfig} config - the plugin configuration.
 * @param {object} [options] - resolution overrides, for tests and for a host
 *   resolving against a different root. Production callers pass none.
 * @param {string} [options.bundleRoot] - the plugin package root.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to probe.
 * @param {string} [options.platform] - `process.platform`.
 * @param {string} [options.arch] - `process.arch`.
 * @returns {{bash: import('./paths.js').ShellResolution, pwsh: import('./paths.js').ShellResolution}} one resolution per rung.
 */
export function resolveShells(config, options = {}) {
  const bundleRoot = options.bundleRoot ?? MODULE_ROOT
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const allowSystemFallback = config?.allowSystemShellFallback === true
  // A POSIX host answers with its own bash: that is the deployment truth for the shell component
  // and for `dsh-ops ladder`.
  const posix = platform !== 'win32'
  const probe = { bundleRoot, env, platform, arch }
  const pwshBundled = bundledShell({ kind: 'pwsh', ...probe })
  const pwshProvisioned = provisionedShell({ kind: 'pwsh', env, platform, arch })

  const pwsh = resolvePwsh({
    provisioned: pwshProvisioned,
    bundled: pwshBundled.file,
    bundledDetail: pwshBundled.detail,
    allowSystemFallback,
  })

  if (config?.publishBashTool === false) {
    return {
      bash: {
        available: false,
        file: undefined,
        source: 'disabled',
        detail: 'publishBashTool is false',
      },
      pwsh,
    }
  }

  const bashBundled = bundledShell({ kind: 'bash', ...probe })
  return {
    bash: resolveBash({
      configured: config?.bashPath,
      provisioned: provisionedShell({ kind: 'bash', env, platform, arch }),
      bundled: bashBundled.file,
      bundledDetail: bashBundled.detail,
      bundledCause: bashBundled.cause,
      allowSystemFallback,
      env,
      platform,
      posix,
    }),
    pwsh,
  }
}

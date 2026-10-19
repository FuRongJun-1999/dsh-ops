/** dsh-ops host half. Own registrations only; no @deepseek-ai value imports. */
import { resolveConfig } from './config.js'
import { mountConfigUpdates, updatedConfig } from './config-updates.js'
import { SECTION_ORDERS, TOOLING_SECTION, BASH_TOOL, publicToolName, hostShellRefusal, renderToolingPolicy } from './policy.js'
import { FILE_TOOLS } from './file/contract.js'
import { resolveShells } from './shells.js'
import { mountSessionBash } from './session-shells.js'
import { mountBundledPwsh } from './session-pwsh.js'
import { NativeFileTools } from './file/runtime.js'
import { resolveWorker } from './ptc/runtime.js'
import { mountWorkspacePreparation } from './workspace-preparation.js'
import { safeDispose, safeDisposeAll } from './teardown.js'

export const name = 'dsh-ops'
function report(ctx, message, level = 'error') {
  const logger = ctx?.logger
  if (typeof logger?.[level] === 'function') logger[level](message)
  else if (level === 'warn') console.warn(message)
  else console.error(message)
}
function visibleTools(ctx, agent) {
  try {
    return (ctx.get('tools')?.schemas(agent) ?? []).map(schema => schema.name)
      .filter(tool => typeof tool === 'string')
  } catch { return [] }
}

/** Explicit host-shell denial is independent of whether ops commands exist. */
function installHostShellDenial(ctx, config) {
  const denied = new Set(config.deniedHostTools)
  const lifts = new Map()
  let warned = false
  const hide = agent => {
    if (lifts.has(agent) || !agent?.ctx) return
    try {
      const names = (ctx.get('tools').schemas(agent) ?? []).map(tool => tool.name).filter(name => denied.has(name))
      if (names.length) lifts.set(agent, agent.ctx.tools.restrict({ deny: names }))
    } catch (error) {
      if (!warned) {
        warned = true
        report(ctx, `dsh-ops: host shell visibility restriction unavailable: ${error.message}; calls remain denied.`, 'warn')
      }
    }
  }
  ctx.on('agent/created', ({ agent }) => hide(agent))
  // Same isolation as the bulk teardown below: a throwing lift must not stop `lifts.delete`, nor
  // leave this agent's shell visibility permanently restricted.
  ctx.on('agent/disposed', ({ agent }) => {
    safeDispose(lifts.get(agent), (error) => report(ctx, `dsh-ops: host shell restriction lift failed: ${error?.message ?? error}`, 'warn'), 'host shell lift (agent disposed)')
    lifts.delete(agent)
  })
  for (const agent of ctx.get('agents')?.list?.() ?? []) hide(agent)
  ctx.effect(() => () => {
    // Isolate each lift: these restore the host's shell visibility, so one throwing callback
    // must not leave the remaining agents' tools hidden (nor skip the map cleanup).
    safeDisposeAll(lifts.values(), (error) => report(ctx, `dsh-ops: host shell restriction lift failed: ${error?.message ?? error}`, 'warn'), 'host shell lift')
    lifts.clear()
  }, 'dsh-ops: host shell restrictions')
  ctx.on('tools/pre-execute', (exec, next) => hostShellRefusal({ toolName: String(exec?.name ?? ''), denied }) ?? next())
  if (typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard(exec => hostShellRefusal({ toolName: String(exec?.name ?? ''), denied })?.reason), 'dsh-ops: host shell guard')
  }
}

async function mountNativeFile(ctx, config, file) {
  const surface = new NativeFileTools({ ctx, config: { ...config, workerPath: file },
    report: (message, level) => report(ctx, message, level) })
  // `safeDispose` isolates synchronous teardown callbacks; a *rejecting promise* needs its own
  // catch, or the rejection is dropped and the worker's shutdown failure stays invisible (#30).
  ctx.effect(() => () => {
    void surface.stop().catch(error => report(ctx, `dsh-ops: native file worker shutdown failed: ${error?.message ?? error}`, 'warn'))
  }, 'dsh-ops: native file worker')
  const tools = await surface.start()
  if (tools.length) report(ctx, `dsh-ops: native Rust file worker ready; ${tools.length} tools.`, 'info')
}

/** The components this host half mounts; `dsh-ops/background` is a separate no-op stub. */
const COMPONENTS = Object.freeze(['shell', 'file'])

export function applyComponent(root, rawConfig, component) {
  if (!COMPONENTS.includes(component)) throw new Error(`dsh-ops: unknown component ${JSON.stringify(component)}`)
  // Validate before migrating: malformed/unknown keys still fail loud.
  resolveConfig(rawConfig)
  const config = resolveConfig(updatedConfig(rawConfig ?? {}))
  mountConfigUpdates(root, rawConfig)
  const nativeWorker = component === 'file' ? (() => {
    try { return resolveWorker(config) }
    catch (error) {
      report(root, `dsh-ops: native file worker unavailable: ${error.message}`)
      if (config.required) throw new Error(`Native file worker unavailable for binaryPath ${config.binaryPath ?? '(automatic resolution)'}: ${error.message}`)
      return undefined
    }
  })() : undefined
  const shells = component === 'shell' ? resolveShells(config) : undefined
  const owned = component === 'shell' ? [BASH_TOOL, 'pwsh'] : [...FILE_TOOLS.map(publicToolName), 'read_image']
  if (config.promptPolicy) root.inject(['systemPrompt'], ctx => {
    ctx.effect(() => ctx.systemPrompt.section({
      name: `${TOOLING_SECTION}:${component}`,
      order: SECTION_ORDERS[TOOLING_SECTION] + (component === 'shell' ? 1 : 0),
      interpolate: false,
      text: context => renderToolingPolicy({
        published: visibleTools(ctx, context.agent).filter(name => owned.includes(name)),
        shellComponent: component === 'shell', pwsh7: shells?.pwsh.available ?? false,
        extraGuidance: config.extraGuidance,
      }),
    }), `dsh-ops: ${component} tooling`)
  })
  if (component === 'shell') {
    // Two of the three halves describe a Windows host and say so themselves: the ACL workspace
    // preparation, and the bundled PowerShell 7 overlay that `pwsh-sandbox` is pointed at. The bash
    // surface is the half with a POSIX answer — on Linux it publishes `ops_bash` over the host
    // distribution's own bash — so the split is written here rather than left implicit in guards.
    if (process.platform === 'win32') {
      mountWorkspacePreparation(root)
      mountBundledPwsh(root, shells)
    }
    root.inject(['tools'], ctx => {
      mountSessionBash(ctx, config, shells)
      if (config.shellPolicy === 'deny-host-shell') installHostShellDenial(ctx, config)
    })
  } else {
    root.inject(['tools', 'sandboxPolicy', 'subprocess'], ctx => mountNativeFile(ctx, config, nativeWorker))
  }
}

// Backward-compatible module entry. The bundle uses independently toggled rows.
export function apply(root, rawConfig) { return applyComponent(root, rawConfig, 'file') }

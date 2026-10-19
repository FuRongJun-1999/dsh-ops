/** Plugin-owned bash layers; permission changes never mutate the shared registry. */
import path from 'node:path'
import { BASH_TOOL } from './policy.js'
import { bashToolDefinition, withBashStatus, DEFAULT_BASH_TIMEOUT_MS } from './shells.js'
import { BashArgumentError, isBashArgumentError } from './shells/argument-error.js'
import { MODES, authorityChanged, executionRestriction } from './permissions.js'
import { prepareWorkspace } from './workspace-preparation.js'
import { confinedBash } from './bash-ipc.js'

/**
 * Whether a session workspace is written in a Windows form.
 *
 * The flavour comes from the workspace itself, not from `process.platform`: a
 * Windows session must be resolved with Windows rules even when this helper runs
 * on another host (the same reason `lib/shells/paths.js` probes foreign layouts
 * with `path.win32`), and a POSIX workspace must never borrow a drive's ambient
 * current directory. A drive-absolute (`C:\ws`) or UNC (`\\server\share`) root
 * is unambiguous; everything else is POSIX.
 * @param {unknown} cwd - the session workspace.
 * @returns {boolean} whether Windows path rules apply.
 */
function windowsFlavoured(cwd) {
  return typeof cwd === 'string' && (/^[A-Za-z]:[\\/]/.test(cwd) || (cwd[0] === '\\' && cwd[1] === '\\'))
}

/**
 * The workdir one session bash call runs in. Adapter placeholders for an unset
 * optional string are "" or whitespace, not a directory to run in: they fall
 * back to the session directory like an omitted value instead of failing the
 * spawn (the executor rejects paths that do not exist).
 *
 * A relative workdir is anchored at `session.header.cwd`, never at the helper
 * process's own cwd: that process belongs to the plugin host, and a caller's `.`
 * means the calling session's workspace (#180, #204 P3). Absolute paths are
 * returned unchanged, and a non-string still reaches the executor's own
 * validation rather than being coerced to the default. On Windows a
 * drive-relative path (`C:child`) is anchored at the session's drive when the
 * drives match and refused when they do not, because resolving it would consult
 * that drive's process-wide current directory — state a session does not own.
 * @param {object} args - the tool call arguments.
 * @param {object} session - the authoritative DSH session.
 * @returns {string|undefined} the absolute workdir, or the session directory.
 * @throws {BashArgumentError} when a relative path has no absolute session workspace to anchor at,
 *   or names a drive other than the session's.
 */
export function sessionWorkdir(args, session) {
  const raw = args?.workdir
  const explicit = typeof raw === 'string' && raw.trim() === '' ? undefined : raw
  const cwd = session?.header?.cwd
  if (explicit === undefined || explicit === null) return cwd
  if (typeof explicit !== 'string') return explicit
  const win = windowsFlavoured(cwd)
  const p = win ? path.win32 : path.posix
  // On Windows, `\child` is rooted but still needs the session's drive.
  const driveRooted = win && path.win32.parse(explicit).root === '\\'
  if (p.isAbsolute(explicit) && !driveRooted) return explicit
  if (typeof cwd !== 'string' || !p.isAbsolute(cwd) || (win && path.win32.parse(cwd).root === '\\')) {
    throw new BashArgumentError('invalid workdir: resolving the relative path '
      + `${JSON.stringify(explicit)} needs an absolute session workspace, but the session reported `
      + `${JSON.stringify(cwd ?? null)}; pass an absolute workdir instead.`, 'workdir')
  }
  const drive = win ? /^([A-Za-z]):/.exec(explicit) : null
  if (drive !== null) {
    const sessionDrive = /^([A-Za-z]):/.exec(cwd)
    if (sessionDrive === null || sessionDrive[1].toLowerCase() !== drive[1].toLowerCase()) {
      throw new BashArgumentError('invalid workdir: the drive-relative path '
        + `${JSON.stringify(explicit)} names drive ${drive[1].toUpperCase()}:, but the session workspace is on `
        + `${sessionDrive === null ? 'no drive' : `${sessionDrive[1].toUpperCase()}:`}; `
        + 'write it as an absolute path instead of relying on another drive\'s current directory.', 'workdir')
    }
    // The drive matches: resolve against the session workspace, never `C:`'s own cwd.
    return p.resolve(cwd, explicit.slice(2))
  }
  return p.resolve(cwd, explicit)
}

/**
 * The canonical value one refusing bash layer settles on.
 *
 * It is a complete `BASH_OUTPUT_SCHEMA` value rather than a bare `{ error }`.
 * The host validates every returned value against the schema this tool registers
 * (`ToolRuntime.createSuccessResult` → `validateJsonSchemaValue`) and throws
 * `ToolOutputError` — "returned invalid output" — for a value missing
 * `timedOut`/`timeoutMs`/`stdout`/`stderr`, which is exactly how a real failure's
 * cause was lost (#235).
 * @param {unknown} error - the failure the executor raised.
 * @returns {object} the settled value, still to be stamped with `status`.
 */
export function bashRefusalValue(error) {
  return {
    error: String(error?.message ?? error),
    timedOut: false,
    timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
  }
}

export function mountSessionBash(ctx, config, shells) {
  if (!config.publishBashTool) return
  const bash = shells.bash
  if (!bash.available) {
    ctx.logger?.warn?.(`dsh-ops: bash unavailable: ${bash.detail}`)
    return
  }
  const entries = new Map()
  let ready = false
  let stopped = false
  const allowed = agent => {
    if (!ready || stopped || !agent?.session) return false
    try {
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      return MODES.includes(policy?.mode) && (policy.mode === 'danger-full-access' || !!ctx.get('sandbox')?.confine)
    }
    catch { return false }
  }
  const clear = entry => {
    // One broken teardown must not strand the rest: `reconcile()` clears every entry before
    // republishing, so an exception escaping here stops the loop at the first entry and leaves the
    // later sessions without a bash tool. Log it — a silently swallowed dispose failure would hide
    // a real leak.
    try {
      entry.dispose?.()
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ops: bash tool teardown failed; continuing with the remaining sessions: ${error?.message ?? error}`)
    } finally {
      entry.dispose = undefined
    }
  }
  const publish = (entry, definition) => {
    // A failed publication must leave the session with the definition that last worked rather than
    // with no bash tool at all (#30). `entry.definition` survives `clear()`, so it holds the last
    // definition registered successfully for this entry.
    try {
      entry.dispose = entry.ctx.tools.register(definition)
      entry.definition = definition
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ops: bash publication failed: ${error.message}`)
      if (entry.definition === undefined) return
      try { entry.dispose = entry.ctx.tools.register(entry.definition) }
      catch (restoreError) { ctx.logger?.warn?.(`dsh-ops: bash restoration failed: ${restoreError.message}`) }
    }
  }
  const reconcile = () => {
    for (const entry of entries.values()) clear(entry)
    // Publish authorized ancestors before masking inheritance in restricted children.
    for (const [agent, entry] of entries) {
      if (!entry.ctx || !allowed(agent)) continue
      const definition = bashToolDefinition({ file: bash.file, source: bash.source, subprocess: ctx.get('subprocess') })
      const run = async (args, exec) => {
        const session = exec?.agent?.session
        // Declared before the helper so every refusal below can state the authoritative mode it was
        // made under: a caller that only sees `failed` cannot tell a read-only refusal from a
        // missing runtime, and the mode is what makes the difference actionable.
        let policy
        const unavailable = message => withBashStatus({ error: `EXECUTOR_UNAVAILABLE: ${message}`,
          ...(policy ? { sandbox: { mode: policy.mode } } : {}),
          timedOut: false, timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
          stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } })
        if (!session?.id || !ready || stopped) return unavailable('Bash requires an authoritative DSH session and executor.')
        try { policy = ctx.get('sandboxPolicy')?.resolve({ session }) }
        catch { return unavailable('DSH policy resolution is unavailable.') }
        if (!MODES.includes(policy?.mode)) return unavailable('Invalid authoritative DSH permission mode.')
        let confinement
        let runtime
        try { runtime = policy.mode === 'danger-full-access' ? { file: bash.file } : confinedBash(bash.file, { source: bash.source }) }
        catch { return unavailable('The restricted Bash runtime is unavailable or incompatible. Restore the verified pinned Bash payload and IPC runtime; changing the DSH selector is not a repair. Do not retry or bypass confinement.') }
        const definitionForCall = bashToolDefinition({ file: runtime.file, source: bash.source, env: runtime.env,
          prepareArgv: async (argv, signal) => {
            await prepareWorkspace(policy)
            if (policy.mode !== 'danger-full-access') {
              const sandbox = ctx.get('sandbox')
              if (!sandbox?.confine) throw new Error('SANDBOX_UNAVAILABLE: DSH confinement provider is unavailable; no command executed.')
              confinement = await sandbox.confine(argv, policy, signal)
              if (!['full', 'partial'].includes(confinement?.enforcement) || !confinement.argv?.length) throw new Error('SANDBOX_UNAVAILABLE: invalid DSH confinement result.')
            }
            const current = ctx.get('sandboxPolicy').resolve({ session })
            if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) {
              const changed = authorityChanged(current, 'bash')
              throw new Error(`${changed.error.code}: ${changed.error.message} ${changed.error.nextAction}`)
            }
            return confinement?.argv ?? argv
          }, subprocess: ctx.get('subprocess'),
        })
        let value
        try {
          value = await definitionForCall.execute({ ...args, workdir: sessionWorkdir(args, session) }, exec)
        } catch (error) {
          // The bash contract states RUNTIME failures as values, never as thrown errors (#168): a
          // refusing runtime that throws must still come back with the mode it refused under, or the
          // caller cannot tell a read-only refusal from a runtime that is simply absent. A CALLER's
          // bad argument is the one thing that must not be folded away: a bare `{ error }` fails
          // BASH_OUTPUT_SCHEMA, so the host reported "returned invalid output" and the wrong field
          // never reached the caller (#235). Refusals are rethrown; everything else settles on a
          // value complete enough for the registered schema.
          if (isBashArgumentError(error)) throw error
          value = bashRefusalValue(error)
        }
        const text = `${value.stderr?.text ?? ''}\n${value.error ?? ''}`.toLowerCase()
        const runnerFailed = value.exitCode !== 0 && confinement?.runnerFailureRules?.some(rule =>
          (!rule.allowedExitCodes || rule.allowedExitCodes.includes(value.exitCode)) &&
          rule.fatalSignatures?.some(s => text.includes(s.toLowerCase())))
        if (runnerFailed || /couldn't create signal pipe|fatal error.*win32 error|sandbox_unavailable/.test(text)) {
          return { ...value, error: 'EXECUTOR_UNAVAILABLE: The bash runtime could not initialize under the DSH sandbox; the command did not run. This is not a user authorization denial. Restore the host runtime or confinement provider. Do not retry or bypass confinement; changing the DSH selector is not a repair.',
            sandbox: { mode: policy.mode, ...(confinement ? { enforcement: confinement.enforcement } : {}) } }
        }
        const refused = value.exitCode !== 0 && confinement?.denialSignatures?.some(s => text.includes(s.toLowerCase()))
        if (refused) {
          // A settled bash result states the authoritative mode it ran under, and a refusal is
          // exactly when the caller needs that fact — the status field alone cannot carry it.
          return { ...value, restriction: executionRestriction('command file effects'),
            sandbox: { mode: policy.mode, ...(confinement ? { enforcement: confinement.enforcement } : {}) } }
        }
        return { ...value, sandbox: { mode: policy.mode, ...(confinement ? { enforcement: confinement.enforcement } : {}) } }
      }
      // Stamp status after every wrapper above, so an added error/permission always reads as failed (#44).
      definition.execute = async (args, exec) => withBashStatus(await run(args, exec))
      publish(entry, definition)
    }
    for (const [agent, entry] of entries) {
      if (!entry.ctx || allowed(agent) || stopped) continue
      if ((ctx.get('tools').schemas(agent) ?? []).some(tool => tool.name === BASH_TOOL)) {
        try { entry.dispose = entry.ctx.tools.restrict({ deny: [BASH_TOOL] }) }
        catch (error) { ctx.logger?.warn?.(`dsh-ops: inherited bash restriction failed: ${error.message}`) }
      }
    }
  }
  const attach = agent => {
    if (stopped || !agent?.ctx || entries.has(agent)) return
    const entry = { ctx: undefined, fiber: undefined, dispose: undefined, definition: undefined }
    entries.set(agent, entry)
    entry.fiber = agent.ctx.plugin(child => {
      child.inject(['tools'], toolsCtx => {
        entry.ctx = toolsCtx
        reconcile()
      })
    })
  }
  const detach = agent => {
    const entry = entries.get(agent)
    if (!entry) return
    entries.delete(agent)
    clear(entry)
    reconcile()
    return entry.fiber?.dispose()
  }
  ctx.effect(() => async () => {
    stopped = true
    // allSettled: one failing detach must not leave the remaining sessions' bash layers published.
    await Promise.allSettled([...entries.keys()].map(detach))
  }, 'dsh-ops: session bash layers')
  ctx.on('agent/created', ({ agent }) => attach(agent))
  ctx.on('agent/disposed', ({ agent }) => detach(agent))
  ctx.on('session/event', (_session, event) => { if (event.type === 'sandbox/mode') reconcile() })
  ctx.inject(['sandbox'], () => { reconcile() })
  ctx.inject(['sandboxPolicy', 'subprocess'], authorityCtx => {
    ready = true
    reconcile()
    authorityCtx.effect(() => () => { ready = false; reconcile() }, 'dsh-ops: bash authority and executor')
  })
  for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)
}

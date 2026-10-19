/**
 * The `ops_bash` tool definition, its rendered result shape, and the canonical
 * output contract it registers.
 *
 * The definition is a plain object — no `@deepseek-ai/*` value import, at load
 * time or later — and it is registered through the caller's own
 * `ctx.tools.register`, never by rewriting the shared registry. Its one host
 * dependency, the subprocess service, is read with `ctx.get('subprocess')`:
 * reaching a host service through `ctx.get` needs no import, and it buys the
 * harness's real credential scrub and process governance instead of a
 * hand-rolled spawn.
 *
 * @module dsh-ops/shells/tool
 */

import fs from 'node:fs'
import { Buffer } from 'node:buffer'
import {
  BASH_ARGUMENTS,
  BASH_TOOL_NAME,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_SPILL_BYTES,
  MAX_BASH_TIMEOUT_MS,
  shellEnvOverrides,
} from './constants.js'
import { BashArgumentError } from './argument-error.js'
import { formatBashSpawnError } from './spawn-error.js'

/**
 * Reject a value this tool cannot run with, naming the field.
 * @param {string} name - the argument name.
 * @param {number} value - the value to check.
 * @returns {void}
 * @throws {BashArgumentError} when the value is not a positive finite number.
 */
function assertPositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new BashArgumentError(`invalid ${name}: expected a positive finite number, got ${JSON.stringify(value)}`, name)
  }
}

/**
 * Refuse arguments this tool does not declare.
 *
 * A first-party tool built with the harness's `defineTool` gets its arguments
 * checked against the parameter schema before its body runs
 * (`dsh-tools/lib/index.js`: `validate(args)` → `ToolArgsError`). This plugin
 * registers a plain definition through `ctx.tools.register` instead, to stay
 * free of any `@deepseek-ai/*` value import, and that path validates only
 * `output.schema`: the model's arguments reach `execute` verbatim. Reading the
 * known fields with `args?.name` then drops an undeclared key in silence — the
 * call reports success while ignoring what the caller asked for.
 *
 * `run_in_background` is the costly case, because the host's own `bash` and
 * `pwsh` tools really do accept it. A command that never exits (a server, a
 * watcher) then runs in the foreground and occupies the call for the whole
 * `timeoutMs`, which may be as much as {@link MAX_BASH_TIMEOUT_MS}.
 * @param {unknown} args - the model arguments.
 * @param {readonly string[]} known - the argument names the schema declares.
 * @returns {void}
 * @throws {BashArgumentError} when `args` is not an object, or carries an undeclared key.
 */
function assertKnownArguments(args, known) {
  if (args === undefined || args === null) return
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new BashArgumentError(`invalid arguments: expected an object, got ${JSON.stringify(args)}`, 'arguments')
  }
  const unknown = Object.keys(args).filter(key => !known.includes(key))
  if (unknown.length === 0) return
  const names = unknown.map(key => JSON.stringify(key)).join(', ')
  // Host shell tools accept per-call escalation; say plainly that this one does not (#42).
  const escalation = unknown.some(key => key === 'sandbox_permissions' || key === 'justification')
    ? '. ops_bash has no per-call sandbox escalation; ask the user to change the session permission mode instead'
    : ''
  throw new BashArgumentError(`invalid arguments: unknown ${unknown.length === 1 ? 'key' : 'keys'} ${names}; `
    + `this tool accepts ${known.join(', ')}${escalation}`, unknown[0])
}

/**
 * Compose the model-facing text for one settled run.
 *
 * The shape matches the host's own bash tool
 * (`packages/shell/tool-bash/src/render.ts`): the body is stdout, then a marked
 * stderr section, then interruption markers, with `[exit code: N]` last so a
 * reader can anchor on it. A non-zero exit is reported rather than raised; only
 * an infrastructure failure (a spawn failure) rejects the call.
 * @param {object} value - the canonical result value.
 * @returns {string} the rendered text.
 */
export function renderBashResult(value) {
  const stream = (output) => (output.truncated
    ? `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
    : output.text)
  const out = stream(value.stdout)
  const err = stream(value.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (value.cancelled === true) markers.push('[cancelled]')
  if (value.restriction) markers.push(`[${value.restriction.code}: ${value.restriction.message} ${value.restriction.nextAction}]`)
  if (value.permission) markers.push(`[${value.permission.code}: ${value.permission.message} ${value.permission.nextAction}]`)
  if (value.error !== undefined) markers.push(`[error: ${value.error}]`)
  if (value.timedOut === true) markers.push(`[timed out after ${value.timeoutMs}ms]`)
  if (value.signal !== undefined) markers.push(`[signal: ${value.signal}]`)
  if (value.exitCode !== undefined && value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`)
  return [body, ...markers].join('\n')
}

/**
 * Read one settled collect-mode stream as its complete retained output.
 * @param {{readFrom: (from: number) => {text: string, lossy: boolean, spillPath?: string}}|undefined} reader - the reader.
 * @returns {{text: string, truncated: boolean, spillPath?: string}} the canonical stream value.
 */
function settledStream(reader, includeMetadata = false) {
  if (reader === undefined || typeof reader.readFrom !== 'function') return { text: '', truncated: false }
  const read = reader.readFrom(0)
  const text = typeof read.text === 'string' ? read.text : ''
  if (!includeMetadata) {
    return {
      text,
      truncated: read.lossy === true,
      ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
    }
  }
  const lines = text === '' ? 0 : text.split(/\n/).length - (text.endsWith('\n') ? 1 : 0)
  return {
    text,
    truncated: read.lossy === true,
    bytes: Buffer.byteLength(text),
    bytesTotal: Number.isFinite(read.nextOffset) ? read.nextOffset : Buffer.byteLength(text),
    lines,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

/**
 * The canonical output contract of `ops_bash`, as plain JSON Schema.
 *
 * EVERY `type` here is a single type string: the harness's
 * `assertSupportedJsonSchema` rejects type arrays outright ("type arrays are
 * not supported", `packages/core/tools/src/json-schema.ts:302-307`), so
 * `['integer', 'null']` is a definition the real registry refuses to register.
 * "Nothing to report" is expressed by OMITTING the key, never by a `null`, which
 * is why `exitCode` and `signal` are optional rather than nullable.
 *
 * Exported beside the definition so a test can validate a wrapped value against
 * the very schema the host enforces on this tool (#235): a refusal folded into a
 * value that does not satisfy it is what the host reports as "returned invalid
 * output".
 */
export const BASH_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'timedOut', 'timeoutMs', 'stdout', 'stderr'],
  properties: {
    status: { type: 'string', enum: ['completed', 'failed'] },
    exitCode: { type: 'integer' },
    signal: { type: 'string' },
    error: { type: 'string' },
    permission: { type: 'object' },
    restriction: { type: 'object' },
    sandbox: { type: 'object' },
    cancelled: { type: 'boolean' },
    diagnostics: { type: 'object' },
    timedOut: { type: 'boolean' },
    timeoutMs: { type: 'number' },
    stdout: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        bytes: { type: 'integer' },
        bytesTotal: { type: 'integer' },
        lines: { type: 'integer' },
        spillPath: { type: 'string' },
      },
    },
    stderr: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        bytes: { type: 'integer' },
        bytesTotal: { type: 'integer' },
        lines: { type: 'integer' },
        spillPath: { type: 'string' },
      },
    },
  },
})

/**
 * Stamp one settled result with its one-word outcome, so ops_bash shares the
 * `status` field the file tools use (#44). Only a clean zero exit is
 * `completed`; any error, restriction, signal, cancellation or timeout is `failed`.
 * @param {object} value - the canonical result value, without `status`.
 * @returns {object} the same value with `status` (re)computed.
 */
export function withBashStatus(value) {
  const completed = value.exitCode === 0 && value.error === undefined && value.permission === undefined && value.restriction === undefined
    && value.signal === undefined && value.timedOut !== true && value.cancelled !== true
  return { ...value, status: completed ? 'completed' : 'failed' }
}

/**
 * The model-facing description of the bash rung.
 *
 * It states the rung's position in the ladder and the recovery step on failure,
 * so the model fixes the command instead of switching shells — the same contract
 * `lib/policy.js` renders into the prompt.
 * @returns {string} the description.
 */
export function bashToolDescription() {
  return 'Run general commands, builds, git/gh, pipelines and scripts in bash; prefer this command '
    + 'executor over PowerShell. Use file tools for file operations. Each call uses a fresh non-login '
    + 'shell; set workdir explicitly. For scripts longer than about 1 KB or containing heredocs, '
    + 'quotes, backslashes or non-ASCII text, write the script to a file first and pass script_path '
    + 'instead of embedding it in command. Use command for short commands and pipelines. Fix failed '
    + 'bash commands here, do not switch shells or mix PowerShell syntax. Output is bounded with '
    + 'spill paths; verify absolute targets before delete/move. Foreground only: no run_in_background '
    + 'and no job id, so a server or watcher occupies the call until timeoutMs; use host pwsh for background.'
}

/**
 * One `ops_bash` tool definition, bound to the resolved bash executable.
 *
 * The definition is a plain object — no `@deepseek-ai/*` value import, at load
 * time or later — and it is registered through the caller's own
 * `ctx.tools.register`, never by rewriting the shared registry. Its one host
 * dependency, the subprocess service, is read with `ctx.get('subprocess')`:
 * reaching a host service through `ctx.get` needs no import, and it buys the
 * harness's real credential scrub and process governance instead of a
 * hand-rolled spawn.
 * @param {object} options - the tool inputs.
 * @param {string} options.file - the resolved bash executable.
 * @param {string} options.source - where that executable came from, for diagnostics.
 * @param {{spawn: (spec: object) => object}} options.subprocess - the harness subprocess service.
 * @returns {object} the definition `ctx.tools.register()` accepts.
 */
export function bashToolDefinition({ file, source, subprocess, prepareArgv, env = {} }) {
  return {
    name: BASH_TOOL_NAME,
    description: bashToolDescription(),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Short bash command or pipeline. Omit or leave empty when using script_path.',
        },
        description: {
          type: 'string',
          description: 'Short human-readable description of the command; accepted for compatibility with the host shell tool.',
        },
        script_path: {
          type: 'string',
          description: 'Existing bash script path. Omit or leave empty when using command. Never use /dev/null as a placeholder.',
        },
        workdir: {
          type: 'string',
          description: 'Working directory, relative to the session workspace; defaults to that workspace when omitted.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds; the command is killed on expiry. '
            + `Defaults to ${DEFAULT_BASH_TIMEOUT_MS}.`,
        },
        graceMs: {
          type: 'number',
          description: 'Grace period in milliseconds between termination and a forced kill. '
            + `Defaults to ${DEFAULT_GRACE_MS}.`,
        },
        includeDiagnostics: {
          type: 'boolean',
          description: 'Include compact timing and executor diagnostics in structured output; omitted by default.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: BASH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderBashResult(value) }],
    },
    /**
     * Run one command through the harness subprocess service.
     *
     * The service owns credential scrubbing, output spilling, and process-range
     * termination; this body supplies only the argv, the directory, the budgets,
     * the terminal overrides, and its cancellation.
     * @param {Record<string, unknown>} args - the model arguments.
     * @param {{signal?: AbortSignal}} [exec] - the host execution context.
     * @returns {Promise<object>} the canonical result value.
     */
    async execute(args, exec) {
      assertKnownArguments(args, BASH_ARGUMENTS)
      // Every refusal in this body is a BashArgumentError, never a plain Error: the session layer
      // folds RUNTIME failures into a value (#168) and rethrows a caller's bad argument, so a wrong
      // field reaches the caller as itself instead of as "returned invalid output" (#235).
      if (args?.description !== undefined && typeof args.description !== 'string') throw new BashArgumentError('invalid description: expected a string', 'description')
      const rawCommand = args?.command
      const rawScriptPath = args?.script_path
      for (const [name, value] of [['command', rawCommand], ['script_path', rawScriptPath]]) {
        if (value != null && typeof value !== 'string') {
          throw new BashArgumentError(`invalid ${name}: expected a string`, name)
        }
      }
      // Some model/tool adapters fill optional strings with "" or null rather
      // than omitting them. Treat those as absent, not as a second executor.
      // Never ignore two real inputs: choosing one would silently discard intent.
      const command = typeof rawCommand === 'string' && rawCommand.trim() !== '' ? rawCommand : undefined
      const scriptPath = typeof rawScriptPath === 'string' && rawScriptPath.trim() !== '' ? rawScriptPath : undefined
      const hasCommand = command !== undefined
      const hasScriptPath = scriptPath !== undefined
      if (!hasCommand && !hasScriptPath) {
        if (typeof rawCommand === 'string') throw new BashArgumentError('invalid command: expected a non-empty string; omit or leave script_path empty when using command', 'command')
        if (typeof rawScriptPath === 'string') throw new BashArgumentError('invalid script_path: expected a non-empty string; omit or leave command empty when using script_path', 'script_path')
        throw new BashArgumentError('invalid bash input: provide exactly one of command or script_path', 'command')
      }
      if (hasCommand && hasScriptPath) {
        throw new BashArgumentError('invalid bash input: provide exactly one of command or script_path; for commands omit script_path or set it to "", not /dev/null', 'script_path')
      }
      const timeoutMs = args?.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS
      assertPositiveFinite('timeoutMs', timeoutMs)
      if (timeoutMs > MAX_BASH_TIMEOUT_MS) {
        throw new BashArgumentError(`invalid timeoutMs: must be no greater than ${MAX_BASH_TIMEOUT_MS}, got ${timeoutMs}`, 'timeoutMs')
      }
      const graceMs = args?.graceMs ?? DEFAULT_GRACE_MS
      assertPositiveFinite('graceMs', graceMs)
      if (args?.includeDiagnostics !== undefined && typeof args.includeDiagnostics !== 'boolean') {
        throw new BashArgumentError('invalid includeDiagnostics: expected a boolean', 'includeDiagnostics')
      }
      const includeDiagnostics = args?.includeDiagnostics === true
      const workdir = args?.workdir
      if (workdir !== undefined && typeof workdir !== 'string') {
        throw new BashArgumentError('invalid workdir: expected a string', 'workdir')
      }
      // A missing cwd and a missing executable both surface as spawn ENOENT
      // (the host runner maps win32 file-/path-not-found onto one code), so the
      // cause cannot be recovered from the error; reject it before spawning or
      // the failure is misreported as a gone bash payload. The session layer
      // resolves omitted and placeholder workdirs to the session directory, so
      // a string that reaches here is a path the caller chose.
      if (workdir !== undefined) {
        let stat
        try {
          stat = fs.statSync(workdir, { throwIfNoEntry: false })
        } catch (error) {
          throw new BashArgumentError(`invalid workdir: cannot access directory (${error?.code ?? 'unknown error'}): ${workdir}`, 'workdir')
        }
        if (stat?.isDirectory() !== true) {
          throw new BashArgumentError(`invalid workdir: must be an existing directory, got ${workdir}`, 'workdir')
        }
      }

      // No subprocess re-check here: `publishShellTools` publishes this tool
      // only while `ctx.subprocess` is mounted, so a definition that exists at
      // all always has the one service it needs.

      // One deadline plus the caller's cancellation, fused into the signal the
      // subprocess service terminates its process range on.
      const controller = new AbortController()
      let timedOut = false
      let cancelled = false
      const startedAt = performance.now()
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`command timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      const callerSignal = exec?.signal
      const onCallerAbort = () => {
        cancelled = true
        controller.abort(callerSignal?.reason)
      }
      if (callerSignal !== undefined) {
        if (callerSignal.aborted) onCallerAbort()
        else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
      }

      try {
        let handle
        try {
          const argv = hasCommand ? [file, '-c', command] : [file, scriptPath]
          if (controller.signal.aborted) throw controller.signal.reason ?? new Error('bash execution cancelled')
          const preparedArgv = prepareArgv ? await prepareArgv(argv, controller.signal) : argv
          if (controller.signal.aborted) throw controller.signal.reason ?? new Error('bash execution cancelled')
          handle = subprocess.spawn({
            argv: preparedArgv,
            cwd: workdir,
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: DEFAULT_MAX_OUTPUT_BYTES, spill: { maxBytes: DEFAULT_MAX_SPILL_BYTES } },
              stderr: { maxBytes: DEFAULT_MAX_OUTPUT_BYTES, spill: { maxBytes: DEFAULT_MAX_SPILL_BYTES } },
            },
            graceMs,
            signal: controller.signal,
            // The terminal overrides and nothing else: the subprocess service's
            // own scrub decides what else a child may inherit, and this plugin
            // never adds a credential-shaped name or a `DSH_*` fact to that set.
            env: shellEnvOverrides(process.env, env),
          })
          const outcome = await handle.done
          // "Nothing to report" is an ABSENT key, not a null: the output schema
          // declares single types only (see BASH_OUTPUT_SCHEMA).
          return withBashStatus({
            ...outcome?.exitCode !== undefined && outcome?.exitCode !== null ? { exitCode: outcome.exitCode } : {},
            ...outcome?.signal !== undefined && outcome?.signal !== null ? { signal: outcome.signal } : {},
            timedOut,
            timeoutMs,
            ...(cancelled ? { cancelled: true } : {}),
            stdout: settledStream(handle.collected?.stdout, includeDiagnostics),
            stderr: settledStream(handle.collected?.stderr, includeDiagnostics),
            ...(includeDiagnostics ? { diagnostics: {
              durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
              executor: { kind: 'subprocess', source },
            } } : {}),
          })
        } catch (error) {
          return withBashStatus({
            // The workdir is part of the diagnosis: a vanished cwd and a vanished executable
            // both surface as one ENOENT, and only one of them is the bash payload (#180).
            error: formatBashSpawnError(error, file, source, workdir),
            timedOut,
            timeoutMs,
            ...(cancelled ? { cancelled: true } : {}),
            stdout: { text: '', truncated: false },
            stderr: { text: '', truncated: false },
            ...(includeDiagnostics ? { diagnostics: {
              durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
              executor: { kind: 'subprocess', source },
            } } : {}),
          })
        }
      } finally {
        clearTimeout(timer)
        callerSignal?.removeEventListener('abort', onCallerAbort)
      }
    },
  }
}

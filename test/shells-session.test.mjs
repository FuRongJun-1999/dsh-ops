/**
 * The session bash layer on a real host, with the machine's own bash: what #235
 * and #237 look like at the boundary the caller sees.
 *
 * Nothing here is a fake. `mountSessionBash` publishes `ops_bash` into a real
 * scoped registry, the host's own subprocess service spawns a real bash, and the
 * request travels through `ctx.get('tools').execute` -- the path that once
 * reported "returned invalid output" because a folded argument refusal failed
 * the registered output schema (#235).
 *
 * @module dsh-ops/test/shells-session
 */

import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, report, scenarioDir, skipSuite, test, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { resolveShells, withBashStatus } from '../lib/shells.js'
import { BASH_ARGUMENT_ERROR_CODE } from '../lib/shells/argument-error.js'
import { bashRefusalValue, mountSessionBash } from '../lib/session-shells.js'

const bash = resolveShells({}).bash
if (!bash.available) {
  skipSuite('shells-session', 'this suite needs a real bash to run a command through the session layer: ' + bash.detail)
}

const signal = () => new AbortController().signal

/**
 * Publish `ops_bash` into one real agent scope, the way the component row does.
 * @param {object} ctx - the booted host context.
 * @param {string} id - the session id.
 * @param {string} workspace - the session workspace.
 * @returns {Promise<{agent: object, scope: object, tool: object}>} the scoped call surface.
 */
async function publishOpsBash(ctx, id, workspace) {
  const agent = { id, session: { id, header: { cwd: workspace } } }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  await ctx.plugin(Subprocess)
  await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workspace }) }))
  await ctx.plugin({ inject: ['tools'], apply(inner) { mountSessionBash(inner, { publishBashTool: true }, { bash }) } })
  await ctx.serial('agent/created', { agent, source: 'startup' })
  await waitFor(() => ctx.get('tools').get('ops_bash', agent) !== undefined, { what: 'ops_bash publication to the session' })
  return { agent, scope, tool: ctx.get('tools').get('ops_bash', agent) }
}

/** The real-shell check for #237; registered on POSIX only, for the reason at its registration. */
async function relativeWorkdirRunsInTheSession() {
  const { ctx } = await bootHost()
  const previous = process.cwd()
  try {
    await withTempDir('shells-session-workspace', async workspace => {
      const child = path.join(workspace, 'retest-dir')
      fs.mkdirSync(child)
      // The helper directory is deliberately NOT a `withTempDir`. On Windows a directory a process
      // has used as its working directory cannot be removed while the handle is still open, and the
      // fixture's `rmSync` then fails with EPERM before any assertion is reported (windows-latest
      // validate). A scenario directory goes away with the rest of the suite home, after this
      // process has exited, which is when Windows lets it go.
      const helper = scenarioDir('shells-session-helper')
      {
        // The same directory name exists under the helper cwd, so a wrong resolution would succeed
        // in the wrong place: only the resolved path proves which one the command ran in.
        fs.mkdirSync(path.join(helper, 'retest-dir'))
        process.chdir(helper)
        try {
          const { agent, scope, tool } = await publishOpsBash(ctx, 'shells-session-relative', workspace)
          try {
            for (const [workdir, expected] of [
              [undefined, workspace],
              ['', workspace],
              ['.', workspace],
              ['retest-dir', child],
              ['./retest-dir', child],
              ['retest-dir/../retest-dir', child],
              [child, child],
            ]) {
              const value = await tool.execute({ command: 'pwd -P', workdir }, { agent, signal: signal() })
              assert.equal(value.status, 'completed', JSON.stringify(value))
              assert.equal(value.stdout.text.trim(), expected, 'workdir=' + JSON.stringify(workdir))
            }
          } finally { await scope.dispose() }
        } finally { process.chdir(previous) }
      }
    })
  } finally {
    process.chdir(previous)
    await shutdown(ctx)
  }
}

// Registered on POSIX only. The bundled bash on Windows answers `pwd -P` with a POSIX path
// (`/d/a/...`) for the same directory this suite builds as `D:\a\...`, so a comparison there
// would assert the shell's path rendering rather than the anchoring. The Windows resolution rules
// (session-drive relative, cross-drive refusal) are asserted without a shell in
// `test/shells-guards.test.mjs`, which runs everywhere.
if (process.platform !== 'win32') await test('a relative workdir runs in the session workspace, not the helper cwd (#237)', relativeWorkdirRunsInTheSession)

await test('a wrong argument reaches the caller as itself, not as invalid output (#235)', async () => {
  const { ctx } = await bootHost()
  try {
    await withTempDir('shells-session-args', async workspace => {
      const { agent, scope, tool } = await publishOpsBash(ctx, 'shells-session-args', workspace)
      try {
        let call = 0
        for (const [args, pattern, argument] of [
          [{ command: 'echo hi', graceMs: -1 }, /invalid graceMs/, 'graceMs'],
          [{ command: 'echo hi', run_in_background: true }, /unknown key "run_in_background"/, 'run_in_background'],
          [{ command: 'echo hi', script_path: 'x.sh' }, /exactly one of command or script_path/, 'script_path'],
          [{ command: 'echo hi', workdir: path.join(workspace, 'missing') }, /invalid workdir: must be an existing directory/, 'workdir'],
        ]) {
          // The session layer rethrows a caller's refusal instead of folding it into a value.
          await assert.rejects(() => tool.execute(args, { agent, signal: signal() }), error => {
            assert.equal(error.code, BASH_ARGUMENT_ERROR_CODE, error?.message)
            assert.equal(error.argument, argument, error?.message)
            assert.match(error.message, pattern)
            return true
          })
          // Through the real registry the caller reads the refusal itself; the pre-fix path ended
          // in "returned invalid output" and the argument was never named.
          const result = await ctx.get('tools').execute({
            name: 'ops_bash', callId: 'shells-session-args-' + call++, agent, signal: signal(), arguments: args,
          })
          assert.equal(result.isError, true, JSON.stringify(result))
          assert.match(result.error.message, pattern)
          assert.doesNotMatch(result.error.message, /invalid output/)
        }
      } finally { await scope.dispose() }
    })
  } finally { await shutdown(ctx) }
})

await test('a vanished session workspace is named as the missing directory (#180)', async () => {
  const { ctx } = await bootHost()
  try {
    await withTempDir('shells-session-gone', async workspace => {
      const { agent, scope, tool } = await publishOpsBash(ctx, 'shells-session-gone', workspace)
      try {
        fs.rmSync(workspace, { recursive: true, force: true })
        await assert.rejects(() => tool.execute({ command: 'echo hi' }, { agent, signal: signal() }), error => {
          assert.equal(error.code, BASH_ARGUMENT_ERROR_CODE, error?.message)
          assert.match(error.message, /invalid workdir: must be an existing directory/)
          assert.ok(error.message.includes(workspace), error.message)
          assert.doesNotMatch(error.message, /bash executable|provision-shells/)
          return true
        })
        const result = await ctx.get('tools').execute({
          name: 'ops_bash', callId: 'shells-session-gone', agent, signal: signal(), arguments: { command: 'echo hi' },
        })
        assert.equal(result.isError, true, JSON.stringify(result))
        assert.ok(result.error.message.includes(workspace), result.error.message)
      } finally { await scope.dispose() }
    })
  } finally { await shutdown(ctx) }
})

await test('every value the session layer settles on satisfies its registered schema (#235)', async () => {
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  const { ctx } = await bootHost()
  try {
    await withTempDir('shells-session-schema', async workspace => {
      const { agent, scope, tool } = await publishOpsBash(ctx, 'shells-session-schema', workspace)
      try {
        for (const command of ['printf ok', 'exit 7']) {
          const value = await tool.execute({ command }, { agent, signal: signal() })
          assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [], JSON.stringify(value))
        }
        // The refusal shape the session layer folds a runtime failure into: this is the value that
        // must not fail the host's own validation.
        const folded = withBashStatus(bashRefusalValue(new Error('EXECUTOR_UNAVAILABLE: probe')))
        assert.deepEqual(validateJsonSchemaValue(tool.output.schema, folded, 'value'), [])
        assert.equal(folded.status, 'failed')
      } finally { await scope.dispose() }
    })
  } finally { await shutdown(ctx) }
})

report('shells-session')

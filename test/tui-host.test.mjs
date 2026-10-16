/** Optional, real dsh-TUI Loader/admission/headless composition. Never uses a user HOME. */
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Writable, PassThrough } from 'node:stream'
import { assert, report, test, TEST_HOME, PACKAGE_ROOT, waitFor } from './lib/harness.mjs'
import { call, result } from './lib/activity-events.mjs'
import { Context, Loader, React, Terminal, hostRow, TuiPanelRuntime, armAdmissionLoader,
  panelStore, PanelHost, ui, setLang, unregister, createInputRuntime } from './lib/tui-host.mjs'

const composition = join(TEST_HOME, 'composition')
mkdirSync(join(composition, 'node_modules'), { recursive: true })
symlinkSync(PACKAGE_ROOT, join(composition, 'node_modules', 'dsh-ops'), process.platform === 'win32' ? 'junction' : 'dir')
const root = new Context()
root.logger.level = 0
let entry
const id = 'dsh-ops-tui:overview'
try {
  await root.plugin(Loader, { baseUrl: pathToFileURL(join(composition, 'cordis.yml')).href })
  await root.plugin({ name: hostRow.name, apply: hostRow.apply })
  await root.plugin(TuiPanelRuntime)
  armAdmissionLoader(root)
  await test('real Loader admits the exported sidecar with stable identity, without OPS operation grants', async () => {
    await root.loader.create({ id: 'ops-sidebar', name: 'dsh-ops/tui', config: { recentLimit: 3 } })
    await root.loader.await()
    try { await waitFor(() => panelStore.get(id) !== undefined, { timeoutMs: 5000, what: 'admitted OPS sidebar' }) }
    catch (error) { throw new Error(error.message + '; actual panels: ' + JSON.stringify(panelStore.list().map(p => p.definition.id))) }
    entry = root.loader.resolve('ops-sidebar')
    assert.equal(panelStore.get(id).definition.source, 'plugin')
    assert.equal(root.get('tools', false), undefined)
    assert.equal(root.get('systemPrompt', false), undefined)
  })

  if (panelStore.get(id)) for (const fullscreen of [false, true]) for (const width of [28, 38]) {
    await test('real panel renders and follows sessions: ' + (fullscreen ? 'fullscreen' : 'inline') + ', width ' + width, async () => {
      const columns = width + 20, rows = 18
      const chinese = width === 28
      setLang(chinese ? 'zh' : 'en')
      const words = chinese ? { calls: '调用', returned: '已返回', unknown: '副作用未知' } : { calls: 'Calls', returned: 'Returned', unknown: 'Unknown effects' }
      let showPanel = true
      const term = new Terminal({ cols: columns, rows, scrollback: 100, allowProposedApi: true })
      class Output extends Writable {
        columns = columns; rows = rows; isTTY = true
        _write(chunk, encoding, done) { term.write(String(chunk), done) }
      }
      class Input extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
      const screen = () => Array.from({ length: rows }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '').join('\n')
      let session = { sessionId: 'one', version: 0, cwd: TEST_HOME, working: false, spinnerMode: 'idle',
        todos: [], subagents: [], backgroundJobs: [], rows: [], notify() {}, subscribe() { return () => {} } }
      const runtime = createInputRuntime()
      const controller = { enabledPanelIds: [id], activePanelId: id, focus: 'chat', zoom: false, runtime }
      const tree = () => {
        const body = React.createElement(ui.ThemeProvider, { theme: 'dark' }, React.createElement(ui.Box, null,
          React.createElement(ui.Box, { width: 18 }, React.createElement(ui.Text, null, 'chat-ok')),
          showPanel ? React.createElement(PanelHost, { controller, channel: session, width, height: 16 }) : null))
        return fullscreen ? React.createElement(ui.AlternateScreen, null, body) : body
      }
      const app = await ui.render(tree(), { stdout: new Output(), stdin: new Input(),
        stderr: new Writable({ write(_chunk, _encoding, done) { done() } }), patchConsole: false, exitOnCtrlC: false })
      try {
        await waitFor(() => screen().includes(words.calls) && screen().includes('chat-ok'), { what: 'OPS first frame' })
        // Use a new synthetic session per render run; these are NOT native-worker acceptance fixtures.
        const key = 'run-' + fullscreen + '-' + width
        session = { ...session, sessionId: key, version: 1 }; app.rerender(tree())
        root.emit('session/event', { id: key }, call(1))
        root.emit('session/event', { id: key }, result(2))
        await waitFor(() => screen().includes(words.returned + ' 1'), { what: 'live OPS result' })
        root.emit('session/event', { id: key }, call(3, 'denied', 'ops_replace'))
        root.emit('session/event', { id: key }, result(4, 'denied', { status: 'rejected', error: { code: 'POLICY_DENIED', message: 'PRIVATE_ERROR' } }))
        root.emit('session/event', { id: key }, call(5, 'batch', 'ops_batch'))
        root.emit('session/event', { id: key }, result(6, 'batch', { status: 'partial', done: 2, total: 3, unknown: 1, complete: false, omitted: 3 }))
        await waitFor(() => screen().includes(words.unknown + ' 1'), { what: 'business refusal and unknown effects' })
        assert.equal(screen().includes('PRIVATE_ERROR'), false)
        assert.ok(screen().includes('ops_batch'))
        assert.ok(screen().includes('chat-ok'))
        const captured = screen()
        const alertsWord = chinese ? '所有会话' : 'All sessions'
        assert.ok(screen().includes(alertsWord), 'aggregate scope is explicit, not the last viewed session')
        assert.equal(panelStore.get(id).badge.level, 'error')
        assert.equal(runtime.dispatchKey(id, 'a'), false, 'chat focus must not acknowledge alerts')
        controller.focus = 'panel'; app.rerender(tree())
        await waitFor(() => runtime.isEnabled(id), { what: 'focused panel input registration' })
        assert.equal(runtime.dispatchKey(id, 'a', { ctrl: true }), false)
        assert.equal(runtime.dispatchKey(id, 'a'), true)
        await waitFor(() => !screen().includes(alertsWord), { what: 'explicit all-session acknowledgement' })
        assert.equal(panelStore.get(id).badge, null)
        controller.focus = 'chat'; app.rerender(tree())
        session = { ...session, sessionId: key + '-other', version: 2 }; app.rerender(tree())
        await waitFor(() => screen().includes(words.calls + ' 0'), { what: 'session switch isolation' })
        session = { ...session, sessionId: key, version: 3 }; app.rerender(tree())
        await waitFor(() => screen().includes(words.returned + ' 3'), { what: 'session statistics restored' })
        showPanel = false; app.rerender(tree())
        await waitFor(() => !screen().includes(words.calls), { what: 'panel unmounted' })
        root.emit('session/event', { id: key }, call(7, 'hidden', 'ops_glob'))
        root.emit('session/event', { id: key }, result(8, 'hidden', { status: 'completed', complete: true }))
        showPanel = true; app.rerender(tree())
        await waitFor(() => screen().includes(words.returned + ' 4'), { what: 'hidden-panel observation retained' })
        if (fullscreen) console.log('\n--- OPS headless frame (synthetic events) ---\n' + captured + '\n--- end frame ---')
      } finally { await app.unmount(); term.dispose() }
    })
  }
  await test('real activation unload removes its panel and event observer', async () => {
    if (entry) await entry.fiber.dispose()
    await waitFor(() => panelStore.get(id) === undefined, { what: 'OPS panel disposal' })
    root.emit('session/event', { id: 'one' }, call(99))
    assert.equal(panelStore.get(id), undefined)
  })
} finally { await root.fiber.dispose(); unregister?.() }
report('real TUI host')

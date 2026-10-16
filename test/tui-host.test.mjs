/** Optional, real dsh-TUI Loader/admission/headless composition. Never uses a user HOME. */
import { createRequire } from 'node:module'
import { mkdirSync, existsSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Writable, PassThrough } from 'node:stream'
import { assert, report, test, skipSuite, TEST_HOME, PACKAGE_ROOT, waitFor } from './lib/harness.mjs'
import { call, result } from './lib/activity-events.mjs'

const target = process.env.DSH_OPS_TUI_ROOT
if (!target) {
  if (process.env.DSH_OPS_REQUIRE_TUI === '1') throw new Error('DSH_OPS_TUI_ROOT is required for real TUI acceptance.')
  skipSuite('TUI host', 'set DSH_OPS_TUI_ROOT to a dsh-TUI checkout or built package')
}
// TUI preferences and ledger paths are fixed at module import, before any host module may load.
process.env.HOME = TEST_HOME
process.env.USERPROFILE = TEST_HOME
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
const rootPath = resolve(target), require = createRequire(join(rootPath, 'package.json'))
const source = existsSync(join(rootPath, 'src', 'dsh-adapter', 'panels.ts'))
let unregister
if (source) ({ unregister } = { unregister: (await import(pathToFileURL(require.resolve('tsx/esm/api')).href)).register() })
const hostModule = file => import(pathToFileURL(join(rootPath, source ? 'src' : 'lib/types', file + (source ? '.ts' : '.js'))).href)
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { default: Loader } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')).href)
const React = (await import(pathToFileURL(require.resolve('react')).href)).default
const { Terminal } = (await import(pathToFileURL(require.resolve('@xterm/headless')).href)).default
const hostRow = await hostModule('dsh-adapter/plugin-host')
const { TuiPanelRuntime } = await hostModule('dsh-adapter/panels')
const { armAdmissionLoader } = await hostModule('dsh-adapter/admission-loader')
const { panelStore } = await hostModule('components/sidePanel/PanelStore')
const { PanelHost } = await import(pathToFileURL(join(rootPath, source ? 'src/components/sidePanel/PanelHost.tsx' : 'lib/types/components/sidePanel/PanelHost.js')).href)
const ui = await hostModule('ui')
const { setLang } = await hostModule('i18n')
setLang('en')

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
      const term = new Terminal({ cols: columns, rows, scrollback: 100, allowProposedApi: true })
      class Output extends Writable {
        columns = columns; rows = rows; isTTY = true
        _write(chunk, encoding, done) { term.write(String(chunk), done) }
      }
      class Input extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
      const screen = () => Array.from({ length: rows }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '').join('\n')
      let session = { sessionId: 'one', version: 0, cwd: TEST_HOME, working: false, spinnerMode: 'idle',
        todos: [], subagents: [], backgroundJobs: [], rows: [], notify() {}, subscribe() { return () => {} } }
      const controller = { enabledPanelIds: [id], activePanelId: id, focus: 'chat', zoom: false,
        runtime: { registerInput: () => () => {}, dispatchKey: () => false } }
      const tree = () => {
        const body = React.createElement(ui.ThemeProvider, { theme: 'dark' }, React.createElement(ui.Box, null,
          React.createElement(ui.Box, { width: 18 }, React.createElement(ui.Text, null, 'chat-ok')),
          React.createElement(PanelHost, { controller, channel: session, width, height: 16 })))
        return fullscreen ? React.createElement(ui.AlternateScreen, null, body) : body
      }
      const app = await ui.render(tree(), { stdout: new Output(), stdin: new Input(),
        stderr: new Writable({ write(_chunk, _encoding, done) { done() } }), patchConsole: false, exitOnCtrlC: false })
      try {
        await waitFor(() => screen().includes('Calls') && screen().includes('chat-ok'), { what: 'OPS first frame' })
        // Use a new synthetic session per render run; these are NOT native-worker acceptance fixtures.
        const key = 'run-' + fullscreen + '-' + width
        session = { ...session, sessionId: key, version: 1 }; app.rerender(tree())
        root.emit('session/event', { id: key }, call(1))
        root.emit('session/event', { id: key }, result(2))
        await waitFor(() => screen().includes('Returned 1'), { what: 'live OPS result' })
        assert.ok(screen().includes('ops_grep'))
        assert.ok(screen().includes('chat-ok'))
        const captured = screen()
        session = { ...session, sessionId: key + '-other', version: 2 }; app.rerender(tree())
        await waitFor(() => screen().includes('Calls 0'), { what: 'session switch isolation' })
        session = { ...session, sessionId: key, version: 3 }; app.rerender(tree())
        await waitFor(() => screen().includes('Returned 1'), { what: 'session statistics restored' })
        if (fullscreen && width === 38) console.log('\n--- OPS headless frame (synthetic events) ---\n' + captured + '\n--- end frame ---')
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

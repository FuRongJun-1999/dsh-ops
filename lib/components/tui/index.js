/** Optional read-only panel. Missing tuiPanels leaves only this component pending. */
import { createActivityStore, resolveActivityConfig } from '../../tui/activity.js'
import { createOpsPanel } from '../../tui/panel.js'
import { createAttentionStore } from '../../tui/attention.js'

export const name = 'dsh-ops-tui'
export const inject = ['tuiPanels']
export { resolveActivityConfig as resolveTuiConfig }

export function apply(ctx, rawConfig) {
  const config = resolveActivityConfig(rawConfig)
  const panels = ctx.get('tuiPanels')
  const store = createActivityStore(config)
  const attention = createAttentionStore()
  const dispose = panels.register({ apiVersion: 1, id: 'overview', title: 'OPS', minColumns: 28,
    component: createOpsPanel(store, attention) })
  if (typeof dispose !== 'function') {
    attention.dispose(); store.dispose()
    ctx.logger?.warn?.('dsh-ops: TUI panel API v1 registration was declined; OPS tools are unchanged.')
    return
  }
  // list() returns this activation's host-prefixed IDs, unlike register()'s disposer.
  const panelId = panels.list().find(panel => panel.id.endsWith(':overview'))?.id
  const unsubscribe = attention.subscribe(() => {
    const alert = attention.snapshot()
    try { if (panelId) panels.badge(panelId, alert.unread ? { level: alert.level, unread: alert.unread } : null) }
    catch { /* A presentation failure cannot escape into the committed event observer. */ }
  })
  ctx.on('session/event', (session, event) => {
    if (store.observe(session.id, event) && (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch')) {
      attention.observe(store.snapshot(session.id).recent[0])
    }
  })
  ctx.effect(() => () => { unsubscribe(); dispose(); attention.dispose(); store.dispose() })
}

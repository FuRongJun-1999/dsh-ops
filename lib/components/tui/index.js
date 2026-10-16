/** Optional read-only panel. Missing tuiPanels leaves only this component pending. */
import { createActivityStore, resolveActivityConfig } from '../../tui/activity.js'
import { createOpsPanel } from '../../tui/panel.js'

export const name = 'dsh-ops-tui'
export const inject = ['tuiPanels']
export { resolveActivityConfig as resolveTuiConfig }

export function apply(ctx, rawConfig) {
  const config = resolveActivityConfig(rawConfig)
  const panels = ctx.get('tuiPanels')
  const store = createActivityStore(config)
  const dispose = panels.register({ apiVersion: 1, id: 'overview', title: 'OPS', minColumns: 28,
    component: createOpsPanel(store) })
  if (typeof dispose !== 'function') {
    store.dispose()
    ctx.logger?.warn?.('dsh-ops: TUI panel API v1 registration was declined; OPS tools are unchanged.')
    return
  }
  ctx.on('session/event', (session, event) => { store.observe(session.id, event) })
  ctx.effect(() => () => { dispose(); store.dispose() })
}

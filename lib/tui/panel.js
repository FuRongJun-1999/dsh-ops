/** Host React/UI only: no runtime TUI or React imports, timers, commands, or filesystem access. */
const COPY = {
  en: { window: 'This session · since enabled', empty: 'No OPS calls observed yet', noSession: 'No active session',
    calls: 'Calls', running: 'Running', returned: 'Returned', errors: 'Tool errors', limited: 'Tracking limit reached; incomplete',
    current: 'In flight', recent: 'Recent', neutral: 'Returned is not business success', status: { running: 'running', returned: 'returned', error: 'tool error' } },
  zh: { window: '当前会话 · 自启用后', empty: '尚未观察到 OPS 调用', noSession: '尚无活动会话',
    calls: '调用', running: '运行中', returned: '已返回', errors: '执行错误', limited: '观测达到上限，统计不完整',
    current: '正在执行', recent: '最近操作', neutral: '已返回不代表操作成功', status: { running: '运行中', returned: '已返回', error: '执行错误' } },
}

/** Pure bounded rows; tools and identifiers are never re-executed or expanded. */
export function activityLines(snapshot, lang = 'en', height = 24) {
  const text = COPY[lang.startsWith('zh') ? 'zh' : 'en']
  const lines = [text.window]
  if (snapshot.limited) lines.push(text.limited)
  lines.push(text.calls + ' ' + snapshot.total + ' · ' + text.running + ' ' + snapshot.running,
    text.returned + ' ' + snapshot.returned + ' · ' + text.errors + ' ' + snapshot.errors)
  if (snapshot.total === 0) lines.push(text.empty)
  if (snapshot.active.length) {
    lines.push('', text.current)
    for (const row of snapshot.active) lines.push(row.name)
  }
  if (snapshot.recent.length) {
    lines.push('', text.recent)
    for (const row of snapshot.recent) {
      lines.push(row.name, '  ' + text.status[row.status] + ' · ' + row.durationMs + ' ms')
    }
  }
  lines.push('', text.neutral)
  return lines.slice(0, Math.max(0, Math.floor(height)))
}

export function createOpsPanel(store) {
  return function OpsPanel({ React, ui, host, width, height }) {
    const context = host.snapshot()
    const sessionId = context.sessionId
    const snapshot = React.useSyncExternalStore(store.subscribe, () => store.snapshot(sessionId))
    const lang = context.lang ?? 'en'
    const lines = sessionId ? activityLines(snapshot, lang, height)
      : [COPY[lang.startsWith('zh') ? 'zh' : 'en'].noSession].slice(0, Math.max(0, height))
    return React.createElement(ui.Box, { flexDirection: 'column', width, height, overflow: 'hidden' },
      ...lines.map((line, index) => React.createElement(ui.Text, { key: index, wrap: 'truncate-end' }, line)))
  }
}

/** Host React/UI only: no runtime TUI or React imports, timers, commands, or filesystem access. */
const COPY = {
  en: { window: 'This session · since enabled', empty: 'No OPS calls observed yet', noSession: 'No active session',
    calls: 'Calls', running: 'Running', returned: 'Returned', errors: 'Tool errors', limited: 'Tracking limit reached; incomplete',
    current: 'In flight', recent: 'Recent', neutral: 'Returned is not business success',
    alerts: 'All sessions · alerts', ack: 'a: ack all alerts',
    rejected: 'Rejected', unknown: 'Unknown effects', businessError: 'Operation errors', partial: 'Partial',
    omitted: 'Details omitted', more: 'Result has undisplayed details', inspect: 'Inspect effects; do not retry blindly', done: 'Done',
    status: { running: 'running', returned: 'returned', error: 'operation error', completed: 'completed', planned: 'preview/plan',
      rejected: 'rejected', partial: 'partial', unknown: 'unknown effects', unconfirmed: 'business unconfirmed' } },
  zh: { window: '当前会话 · 自启用后', empty: '尚未观察到 OPS 调用', noSession: '尚无活动会话',
    calls: '调用', running: '运行中', returned: '已返回', errors: '执行错误', limited: '观测达到上限，统计不完整',
    current: '正在执行', recent: '最近操作', neutral: '已返回不代表操作成功',
    alerts: '所有会话 · 累计提醒', ack: 'a：确认所有提醒',
    rejected: '拒绝', unknown: '副作用未知', businessError: '业务失败', partial: '部分失败',
    omitted: '未展示明细', more: '结果含未展示明细', inspect: '请检查副作用，不要盲目重试', done: '完成',
    status: { running: '运行中', returned: '已返回', error: '业务/执行错误', completed: '完成', planned: '预览/计划',
      rejected: '拒绝', partial: '部分失败', unknown: '副作用未知', unconfirmed: '业务状态未确认' } },
}

/** Pure bounded rows; tools and identifiers are never re-executed or expanded. */
export function activityLines(snapshot, lang = 'en', height = 24) {
  const text = COPY[lang.startsWith('zh') ? 'zh' : 'en']
  const lines = [text.window]
  if (snapshot.limited) lines.push(text.limited)
  const outcomes = snapshot.business
  if (outcomes.rejected || outcomes.unknown) lines.push(text.rejected + ' ' + outcomes.rejected + ' · ' + text.unknown + ' ' + outcomes.unknown)
  if (outcomes.error || outcomes.partial) lines.push(text.businessError + ' ' + outcomes.error + ' · ' + text.partial + ' ' + outcomes.partial)
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
      const outcome = row.status === 'error' && row.outcome !== 'unknown' ? 'error' : row.outcome ?? row.status
      lines.push(row.name, '  ' + text.status[outcome] + ' · ' + row.durationMs + ' ms')
      if (row.errorCode) lines.push('  ' + row.errorCode)
      if (row.outcome === 'unknown') lines.push('  ' + text.inspect)
      if (row.done !== undefined && row.total !== undefined) lines.push('  ' + text.done + ' ' + row.done + '/' + row.total)
      if ((row.omitted ?? 0) > 0) lines.push('  ' + text.omitted + ' ' + row.omitted)
      else if (row.complete === false) lines.push('  ' + text.more)
    }
  }
  lines.push('', text.neutral)
  return lines.slice(0, Math.max(0, Math.floor(height)))
}

export function createOpsPanel(store, attention) {
  return function OpsPanel({ React, ui, host, width, height }) {
    const context = host.snapshot()
    const sessionId = context.sessionId
    const snapshot = React.useSyncExternalStore(store.subscribe, () => store.snapshot(sessionId))
    const alert = React.useSyncExternalStore(attention.subscribe, attention.snapshot)
    React.useEffect(() => {
      if (!host.focused) return
      return host.onKey(event => {
        if (event.input === 'a' && !event.key.ctrl && !event.key.meta && !event.key.shift && attention.acknowledge()) event.preventDefault()
      })
    }, [host])
    const lang = context.lang ?? 'en', text = COPY[lang.startsWith('zh') ? 'zh' : 'en']
    const notes = alert.unread ? [text.alerts + ' ' + alert.unread + (alert.capped ? '+' : ''), text.ack] : []
    const body = sessionId ? activityLines(snapshot, lang, height - notes.length) : [text.noSession]
    const lines = [...notes, ...body].slice(0, Math.max(0, Math.floor(height)))
    return React.createElement(ui.Box, { flexDirection: 'column', width, height, overflow: 'hidden' },
      ...lines.map((line, index) => React.createElement(ui.Text, { key: index, wrap: 'truncate-end' }, line)))
  }
}

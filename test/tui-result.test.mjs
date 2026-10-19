import { createActivityStore } from '../lib/tui/activity.js'
import { resultDetails } from '../lib/tui/result.js'
import { activityLines } from '../lib/tui/panel.js'
import { call, result, dispatch } from './lib/activity-events.mjs'
import { assert, report, test } from './lib/harness.mjs'
const inspect = value => resultDetails('ops_grep', result(2, 'a', value).data, false)

await test('normal transport returns distinguish native success, refusal and operation failure', () => {
  assert.equal(inspect({ status: 'completed' }).outcome, 'completed')
  assert.equal(inspect({ status: 'rejected', error: { code: 'POLICY_DENIED' } }).outcome, 'rejected')
  assert.equal(inspect({ status: 'error' }).outcome, 'error')
  const blocked = result(2, 'a', { status: 'completed' }).data
  blocked.message.isError = true
  assert.equal(resultDetails('ops_grep', blocked, false).outcome, 'unconfirmed')
  const store = createActivityStore()
  store.observe('one', call(1)); store.observe('one', result(2, 'a', { status: 'rejected' }))
  assert.equal(store.snapshot('one').returned, 1)
  assert.equal(store.snapshot('one').errors, 0)
  assert.equal(store.snapshot('one').business.rejected, 1)
})
await test('unknown effects outrank other outcomes and never imply safe automatic retry', () => {
  assert.equal(inspect({ status: 'completed', unknown: 1 }).outcome, 'unknown')
  assert.equal(inspect({ status: 'error', error: { effectState: 'unknown' } }).outcome, 'unknown')
  const store = createActivityStore()
  store.observe('one', dispatch(1, 'batch', 'ops_batch'))
  store.observe('one', dispatch(2, 'batch', 'ops_batch', { status: 'partial', done: 2, total: 3, unknown: 1 }))
  const lines = activityLines(store.snapshot('one'), 'zh', 30).join('\n')
  assert.match(lines, /副作用未知 1/); assert.match(lines, /不要盲目重试/)
  assert.ok(lines.includes('完成 2/3'))
})
await test('dry runs and plans are not counted as completed writes', () => {
  assert.equal(inspect({ status: 'completed', dryRun: true }).outcome, 'planned')
  assert.equal(inspect({ status: 'planned' }).outcome, 'planned')
  assert.equal(inspect({ status: 'completed', failed: 1 }).outcome, 'partial')
})
await test('pagination and audit omissions stay observations, not new tool requests', () => {
  const store = createActivityStore()
  store.observe('one', call(1))
  store.observe('one', result(2, 'a', { status: 'completed', complete: false, omitted: 18, nextOffset: 20 }))
  const row = store.snapshot('one').recent[0]
  assert.equal(row.omitted, 18); assert.equal(row.nextOffset, 20)
  const text = activityLines(store.snapshot('one'), 'en', 30).join('\n')
  assert.match(text, /Details omitted 18/)
  assert.equal(store.snapshot('one').total, 1)
})
await test('shell stdout, foreign tools and spill previews cannot fabricate native business success', () => {
  const data = result(2, 'a', { status: 'completed' }).data
  for (const tool of ['ops_bash', 'ops_run', 'ops_job_output', 'other']) assert.equal(resultDetails(tool, data, false).outcome, 'unconfirmed')
  data.message.content.push({ type: 'text', text: 'spill locator' })
  assert.equal(resultDetails('ops_grep', data, false).outcome, 'unconfirmed')
  for (const text of ['not JSON', 'null', '[]', '123']) {
    assert.equal(resultDetails('ops_grep', { content: [{ type: 'text', text }] }, true).outcome, 'unconfirmed')
  }
})
await test('parsing enforces serialized UTF-8 bytes, including exact-limit and multibyte cases', () => {
  const base = JSON.stringify({ status: 'completed', padding: '' })
  const exact = base.replace('"padding":""', '"padding":"' + 'x'.repeat(65536 - Buffer.byteLength(base)) + '"')
  assert.equal(Buffer.byteLength(exact), 65536)
  const parse = text => resultDetails('ops_glob', { content: [{ type: 'text', text }] }, true)
  assert.equal(parse(exact).outcome, 'completed')
  assert.equal(parse(exact + ' ').outcome, 'unconfirmed')
  assert.equal(parse(exact.replace('x', '汉')).outcome, 'unconfirmed')
})
await test('only bounded codes, booleans and safe nonnegative counters survive projection', () => {
  const detail = inspect({ status: 'error', total: -1, failed: 1.5, done: 2, omitted: Number.MAX_VALUE,
    error: { code: 'POLICY_DENIED', message: 'PRIVATE_ERROR', nextAction: 'PRIVATE_ACTION' },
    items: [{ path: 'PRIVATE_PATH', content: 'PRIVATE_FILE' }], raw: 'PRIVATE_TEXT' })
  assert.equal(detail.total, undefined); assert.equal(detail.failed, undefined)
  assert.equal(detail.omitted, undefined); assert.equal(detail.done, 2)
  assert.equal(detail.errorCode, 'POLICY_DENIED')
  assert.equal(JSON.stringify(detail).includes('PRIVATE'), false)
  assert.ok(Object.isFrozen(detail))
  assert.equal(inspect({ error: { code: 'bad\ncode' } }).errorCode, undefined)
})
report('TUI result diagnostics')

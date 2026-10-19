/** File schemas and model rendering use the actual pinned host contract. */
import fs from 'node:fs'
import { assertSupportedJsonSchema, jsonSchemaToTs } from '@deepseek-ai/dsh-tools'
import { FILE_TOOLS, PARAMETERS, definition, DESCRIPTIONS } from '../lib/file/contract.js'
import { renderToolingPolicy, publicToolName } from '../lib/policy.js'
import { assert, test, report } from './lib/harness.mjs'

await test('all eleven file argument schemas remain discoverable without unknown types', () => {
  assert.equal(FILE_TOOLS.length, 11)
  for (const tool of FILE_TOOLS) {
    const schema = PARAMETERS[tool]
    assertSupportedJsonSchema(schema)
    const sdk = jsonSchemaToTs(schema)
    assert.doesNotMatch(sdk, /\bunknown\b/, tool)
    assert.equal(schema.additionalProperties, false)
    for (const field of Object.keys(schema.properties)) assert.ok(sdk.includes(`${field}`), `${tool}.${field}`)
    for (const required of schema.required) assert.ok(!sdk.includes(`${required}?:`), `${tool}.${required} remains required`)
  }
  assert.match(PARAMETERS.edit_file.properties.edits.description, /1-100/)
  assert.match(PARAMETERS.edit_file.properties.edits.items.properties.oldText.description, /Nonempty/)
  assert.match(PARAMETERS.grep.properties.beforeContext.description, /0-32/)
  assert.match(PARAMETERS.inspect_local_file.properties.offset.description, /1-based/)
  assert.match(PARAMETERS.copy.properties.expectedRevision.description, /absent is not accepted/)
})

const render = (tool, value) => JSON.parse(definition(tool, async () => value).output.render({}, value)[0].text)
await test('inspect shares a path only in model rendering, retaining all other fields', () => {
  const path = `D:/${'long-directory/'.repeat(7)}source.txt`
  const value = { status: 'completed', complete: false, revision: 'a'.repeat(64), nextOffset: 201,
    truncated: true, omitted: 1, items: Array.from({ length: 200 }, (_, i) => ({ path, line: i + 1, text: '\"\\中\n' })) }
  value.items[199].truncatedInLine = true
  value.items[199].bytesTotal = 200000
  const original = JSON.stringify(value)
  const view = render('inspect_local_file', value)
  assert.equal(view.path, path)
  assert.deepEqual({ ...view, path: undefined, items: view.items.map(item => ({ path, ...item })) }, { ...value, path: undefined })
  assert.equal(JSON.stringify(value), original, 'raw PTC/execute data is not mutated')
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < Buffer.byteLength(original) / 2)
  assert.equal(view.items[199].truncatedInLine, true)
  assert.equal(view.nextOffset, 201)
})

await test('render leaves empty, failed, mixed-path and other tool results untouched', () => {
  for (const value of [null, { status: 'error', error: { code: 'IO_ERROR' } },
    { status: 'completed', items: [] }, { status: 'completed', items: [{ text: 'no path' }] },
    { status: 'completed', items: [{ path: '/a', text: 'a' }, { path: '/b', text: 'b' }] }]) {
    assert.deepEqual(render('inspect_local_file', value), value)
  }
  const hex = { status: 'completed', items: [{ path: '/a', view: 'hex', offset: 0, text: '00 ff' }] }
  assert.deepEqual(render('inspect_local_file', hex).items, [{ view: 'hex', offset: 0, text: '00 ff' }])
  assert.deepEqual(render('grep', hex), hex)
})

await test('routing and native guide distinguish aggregate totals and errors-as-values', () => {
  const policy = renderToolingPolicy({ published: FILE_TOOLS.map(publicToolName) })
  assert.match(policy, /summary for aggregate file\/match totals; count for per-file counts/)
  assert.doesNotMatch(policy, /use count for totals/)
  assert.equal(renderToolingPolicy({ published: ['ops_stat'] }).includes('ops_grep:'), false)
  assert.match(DESCRIPTIONS.grep, /summary for aggregate file\/match totals, count for per-file counts/)
  const guide = fs.readFileSync(new URL('../docs/native-ptc.md', import.meta.url), 'utf8')
  assert.doesNotMatch(guide, /exactly one of `file_path` or `files`|safeLegacy|Malformed arguments from these legacy MCP tools/)
  assert.match(guide, /check `status`/)
  assert.match(guide, /summary.*aggregate/)
  assert.equal(typeof policy, 'string')
})
report('file-sdk-render')

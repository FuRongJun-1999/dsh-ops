/** Shipped bundle + representative standard-preset fs/search plugins, real DSH registry/prompt/services. */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, waitFor, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
import { resolveWorker } from '../lib/ptc/runtime.js'

const { parse } = YAML
resolveWorker({})
// Parse the shipped data-only bundle; executable YAML tags are not supported.
const rows = parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'))[0].insert
assert.equal(rows.find(row => row.id === 'dsh-ops-hide-official').disabled, true)
assert.equal(rows.find(row => row.id === 'dsh-ops-tui').disabled, true)

for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
  await test(`default bundle starts with standard fs/search in native/PTC/both under ${mode}`, async () => {
    await withTempDir('bundle-startup', async root => {
      const { ctx } = await bootHost()
      try {
        await ctx.plugin(Subprocess)
        await ctx.plugin(Sandbox, {})
        await ctx.plugin(FileSystem, {})
        await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: root, sessionId: session.id }) }))
        await ctx.plugin(NodePtc, {})
        for (const row of rows.filter(row => !row.disabled)) {
          const component = row.name.split('/')[1]
          const module = await import(`../lib/components/${component}/index.js`)
          await ctx.plugin(module, row.config)
        }
        for (const presentation of ['native', 'ptc', 'both']) {
          const agent = { id: `${mode}-${presentation}`, session: { id: `${mode}-${presentation}`, mode, header: { cwd: root } } }
          agent.ctx = createScope(ctx, agent).ctx
          await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(presentation) } })
          // These are the real standard-preset tool-fs and tool-fs-search rows,
          // not fake official schema fixtures. No unrelated full-preset services.
          await agent.ctx.plugin(FsTools, {})
          await agent.ctx.plugin(SearchTools, { sampleOverCapGlobResults: false })
          await ctx.serial('agent/created', { agent, source: 'startup' })
          const names = () => ctx.get('tools').schemas(agent).map(tool => tool.name)
          await waitFor(() => names().includes('ops_stat') && names().includes('read') && names().includes('grep') &&
            names().includes('ops_batch') === (presentation === 'ptc') &&
            names().includes('ops_bash'), { what: `${mode}/${presentation} default publication` })
          const assembled = await ctx.get('systemPrompt').assemble({ scope: agent, signal: new AbortController().signal })
          assert.equal(assembled.tools.some(tool => tool.name === 'run_code'), presentation !== 'native')
          assert.ok(assembled.sections.length > 0)
          assert.ok(names().includes('write'), 'defaults must not mask standard-preset mutation tools')
          const result = await ctx.get('tools').get('ops_stat', agent).execute({ path: path.join(root, 'absent') }, { agent, signal: new AbortController().signal })
          assert.equal(result.status, 'completed', JSON.stringify(result))
          assert.equal(result.exists, false)
          console.log(`    startup ${mode}/${presentation}: ${assembled.tools.length} wire tools; official + OPS intact`)
        }
      } finally { await shutdown(ctx) }
    })
  })
}
report('bundle-startup')

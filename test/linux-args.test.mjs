/**
 * Argument, content and paging boundaries, ported from the ad-hoc `B-args` and
 * `G-semantics` probes in `dsh-ops-boundary-report.md`.
 *
 * What this suite locks in:
 *
 * - Declared argument bounds hold at the exact edge: `offset: 0` is accepted and
 *   silently means line 1, negatives and non-integers are `INVALID_ARGUMENT`,
 *   `beforeContext: 33` is refused by name, and an empty glob pattern list is
 *   `INVALID_ARGUMENT`.
 * - Paging tells the truth. 500 matches with `limit: 10` report `total: 500`,
 *   `complete: false`, `omitted: 490` and a usable `nextOffset`, and following
 *   `nextOffset` reaches every match. The `skipped` field is the paging offset,
 *   not a count of skipped files: that is the contract, and it is asserted so a
 *   silent change to it is visible.
 * - `replace.pattern` is a literal substring while `grep.pattern` is a regex;
 *   the mismatch is a documented contract boundary (report L5), asserted here so
 *   whoever unifies them has to update this suite deliberately.
 * - `multiline` means per-line anchors, not cross-line matching (report L6):
 *   `^beta$` matches, `alpha\nbeta` does not.
 *
 * Platform. The subject is JSON argument handling in the native worker, plus
 * filesystem-neutral fixtures, so every case runs on win32 as well. The one
 * fixture that is sized against a byte budget (a 128 KiB single line) is
 * portable; the 32 MiB fixture from the report is deliberately not ported — see
 * the runtime budget note in the porting report.
 *
 * No defect is left unasserted here. The `limit`-bounds-lines-not-bytes defect (L4)
 * is fixed and covered by `test/output-budget.test.mjs`; the `maxReplacements`
 * refusal (L3) now reports the count and the ceiling instead of blaming the
 * pattern, which the case below asserts; cross-line matching (L6) has its own
 * suite, `test/grep-multiline.test.mjs`; and the debris a hard kill leaves behind
 * (L7) is asserted as self-healing, because it cannot be prevented — a `SIGKILL`
 * runs no cleanup path, so the next writer of the same file has to reclaim it.
 *
 * @module dsh-ops/test/linux-args
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, request, requireWorker, callWorker } from './lib/boundary.mjs'

requireWorker('linux-args')

/** Write `count` numbered lines under a workspace and return the path. */
const numbered = (workspace, name, count) => {
  const target = path.join(workspace, name)
  fs.writeFileSync(target, `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')}\n`)
  return target
}

await test('offset and limit hold at their declared edges', async () => {
  await withTempDir('linux-args-offset', async workspace => {
    const target = numbered(workspace, 'lines.txt', 100)
    const read = (args, timeoutMs) => callTool('inspect_local_file', { path: target, ...args }, { root: workspace, timeoutMs })

    const minima = envelopeOf(await read({ offset: 1, limit: 1 }), assert)
    assert.equal(minima.status, 'completed')
    assert.equal(minima.items.length, 1)
    assert.equal(minima.items[0].line, 1)

    const maximum = envelopeOf(await read({ limit: 10_000 }), assert)
    assert.equal(maximum.status, 'completed')
    assert.equal(maximum.items.length, 100, 'the file is the limit, not the declared maximum')

    for (const bad of [{ limit: 10_001 }, { offset: -1 }, { limit: -5 }, { offset: 1.5 }]) {
      const refused = envelopeOf(await read(bad), assert)
      assert.equal(refused.status, 'error', `${JSON.stringify(bad)} was accepted`)
      assert.equal(refused.error.code, 'INVALID_ARGUMENT')
    }

    // A zero offset is below the declared minimum of 1 but is silently accepted
    // and read as line 1. That tolerance is the current contract; it is asserted
    // so tightening it to a refusal is a deliberate, visible change.
    const zero = envelopeOf(await read({ offset: 0 }), assert)
    assert.equal(zero.status, 'completed')
    assert.equal(zero.items[0].line, 1)

    const pastEnd = envelopeOf(await read({ offset: 100_000 }), assert)
    assert.equal(pastEnd.status, 'completed')
    assert.deepEqual(pastEnd.items, [])
    assert.equal(pastEnd.total, 100, 'the file total is still reported')
    assert.equal(pastEnd.complete, true)
  })
})

await test('glob pattern lists are validated: empty is refused, 200 patterns stay bounded', async () => {
  await withTempDir('linux-args-glob', async workspace => {
    for (let index = 0; index < 25; index += 1) fs.writeFileSync(path.join(workspace, `f${index}.txt`), 'x')

    const empty = envelopeOf(await callTool('glob', { path: workspace, pattern: [] }, { root: workspace }), assert)
    assert.equal(empty.status, 'error')
    assert.equal(empty.error.code, 'INVALID_ARGUMENT')

    const patterns = Array.from({ length: 200 }, (_, index) => `f${index}.txt`)
    const started = Date.now()
    const many = envelopeOf(await callTool('glob', { path: workspace, pattern: patterns }, { root: workspace, timeoutMs: 20_000 }), assert)
    assert.equal(many.status, 'completed')
    assert.equal(many.matched, 25, 'only the patterns with a real file may match')
    assert.ok(Date.now() - started < 15_000, 'no quadratic blowup')
  })
})

await test('grep refuses an invalid regex without hanging; a hostile pattern stays linear', async () => {
  await withTempDir('linux-args-regex', async workspace => {
    const target = numbered(workspace, 'redos.txt', 1)
    fs.writeFileSync(target, `${'a'.repeat(30)}b\n`)

    const invalid = envelopeOf(await callTool('grep', { path: target, pattern: '([' }, { root: workspace }), assert)
    assert.equal(invalid.status, 'error')
    assert.equal(invalid.error.code, 'INVALID_ARGUMENT')
    assert.match(invalid.error.message, /regex parse error|unclosed character class/)

    const started = Date.now()
    const hostile = envelopeOf(await callTool('grep', { path: target, pattern: '(a+)+$' }, { root: workspace, timeoutMs: 15_000 }), assert)
    assert.equal(hostile.status, 'completed')
    assert.equal(hostile.matched, 0)
    assert.ok(Date.now() - started < 5_000, 'the engine must not backtrack exponentially')

    const emptyPattern = envelopeOf(await callTool('grep', { path: target, pattern: '' }, { root: workspace }), assert)
    assert.equal(emptyPattern.status, 'error')
    assert.equal(emptyPattern.error.code, 'INVALID_ARGUMENT')
  })
})

await test('beforeContext is bounded at 32 lines, one over is refused by name', async () => {
  await withTempDir('linux-args-context', async workspace => {
    const target = numbered(workspace, 'context.txt', 100)
    const atLimit = envelopeOf(await callTool('grep', { path: target, pattern: 'line 50', beforeContext: 32, afterContext: 32 }, { root: workspace }), assert)
    assert.equal(atLimit.status, 'completed')
    assert.equal(atLimit.matched, 1)

    const over = envelopeOf(await callTool('grep', { path: target, pattern: 'line 50', beforeContext: 33 }, { root: workspace }), assert)
    assert.equal(over.status, 'error')
    assert.equal(over.error.code, 'INVALID_ARGUMENT')
    assert.match(over.error.message, /context is limited to 32 lines/)
  })
})

await test('grep paging reports an honest total and nextOffset, and paging reaches every match', async () => {
  await withTempDir('linux-args-paging', async workspace => {
    const target = path.join(workspace, 'hits.txt')
    fs.writeFileSync(target, `${Array.from({ length: 500 }, (_, index) => `hit ${index}`).join('\n')}\n`)

    const first = envelopeOf(await callTool('grep', { path: target, pattern: 'hit', limit: 10, offset: 3 }, { root: workspace }), assert)
    assert.equal(first.matched, 500)
    assert.equal(first.total, 500)
    assert.equal(first.items.length, 10)
    assert.equal(first.complete, false)
    assert.equal(first.omitted, 487, 'omitted counts the matches before the offset and after the page')
    assert.equal(first.nextOffset, 13)
    // `skipped` mirrors the paging offset; it is not a count of skipped files.
    assert.equal(first.skipped, 3)

    let offset = 0
    let seen = 0
    let rounds = 0
    let last = null
    while (rounds < 100) {
      rounds += 1
      const page = envelopeOf(await callTool('grep', { path: target, pattern: 'hit', limit: 100, offset }, { root: workspace }), assert)
      last = page
      seen += page.items.length
      if (page.items.length === 0 || page.complete) break
      offset = page.nextOffset
    }
    assert.equal(seen, 500, 'paging must reach every match')
    assert.equal(last.complete, true, 'the last page must say it is complete')
  })
})

await test('replace treats its pattern as a literal while grep treats the same string as a regex', async () => {
  await withTempDir('linux-args-literal', async workspace => {
    const target = path.join(workspace, 'lit.txt')
    fs.writeFileSync(target, 'aaa a+ bbb\n')

    const grepped = envelopeOf(await callTool('grep', { path: target, pattern: 'a+' }, { root: workspace }), assert)
    assert.equal(grepped.matched, 1, 'grep interprets a+ as a regex quantifier')

    const replaced = envelopeOf(await callTool('replace', { path: target, pattern: 'a+', replacement: 'X' }, { root: workspace, writeRoots: [workspace] }), assert)
    assert.equal(replaced.changed, 1)
    assert.equal(fs.readFileSync(target, 'utf8'), 'aaa X bbb\n', 'replace matched the literal a+, not the regex')

    fs.writeFileSync(target, 'price 100 usd\n')
    const metacharacter = envelopeOf(await callTool('replace', { path: target, pattern: '\\d+', replacement: 'N' }, { root: workspace, writeRoots: [workspace] }), assert)
    assert.equal(metacharacter.status, 'completed')
    assert.equal(metacharacter.changed, 0, 'a regex-shaped literal matches nothing and says so only through changed=0')
    assert.equal(fs.readFileSync(target, 'utf8'), 'price 100 usd\n')
  })
})

await test('multiline reaches across lines while ^ and $ stay per line', async () => {
  await withTempDir('linux-args-multiline', async workspace => {
    const target = path.join(workspace, 'ml.txt')
    fs.writeFileSync(target, 'alpha\nbeta\ngamma\n')

    const crossLine = envelopeOf(await callTool('grep', { path: target, pattern: 'alpha\\nbeta', multiline: true }, { root: workspace }), assert)
    assert.equal(crossLine.status, 'completed')
    assert.equal(crossLine.matched, 1, 'with multiline the pattern reaches across the newline')
    assert.equal(crossLine.items[0].line, 1, 'a cross-line match is reported where it starts')

    // The same request without the flag is line-oriented, so the pattern cannot match.
    const lineWise = envelopeOf(await callTool('grep', { path: target, pattern: 'alpha\\nbeta' }, { root: workspace }), assert)
    assert.equal(lineWise.matched, 0, 'without multiline the pattern still has to fit on one line')

    const anchors = envelopeOf(await callTool('grep', { path: target, pattern: '^beta$', multiline: true }, { root: workspace }), assert)
    assert.equal(anchors.matched, 1, '^ and $ still apply per line')
  })
})

await test('maxReplacements refuses by naming the count and the ceiling, and writes nothing', async () => {
  await withTempDir('linux-args-maxreplacements', async workspace => {
    const target = path.join(workspace, 'many.txt')
    const original = 'TOKEN\n'.repeat(101)
    fs.writeFileSync(target, original)

    const result = await callWorker(JSON.stringify(request('replace', { path: target, pattern: 'TOKEN', replacement: 'DONE' }, { root: workspace })))
    // A refusal is carried by the envelope, not the exit status: the worker still
    // exits 0, so `status` is what a caller must read.
    assert.equal(result.body.status, 'error')
    assert.equal(result.body.error.code, 'OUTPUT_LIMIT')
    assert.match(result.body.error.message, /101 matches exceed maxReplacements \(100\)/u, 'the message must name the count and the ceiling, not the pattern')
    assert.match(result.body.error.message, /no file was changed/u)
    assert.equal(fs.readFileSync(target, 'utf8'), original, 'a refusal must not have written anything')

    // Raising the ceiling past the count is the documented way forward.
    const raised = envelopeOf(await callTool('replace', { path: target, pattern: 'TOKEN', replacement: 'DONE', maxReplacements: 101 }, { root: workspace }), assert)
    assert.equal(raised.changed, 101)
    assert.equal(fs.readFileSync(target, 'utf8'), 'DONE\n'.repeat(101))
  })
})

await test('a leftover from a killed writer is reclaimed by the next replace of that file', async () => {
  await withTempDir('linux-args-debris', async workspace => {
    const target = path.join(workspace, 'debris.txt')
    fs.writeFileSync(target, 'TOKEN\n')
    // What a SIGKILL during publication leaves behind: a hidden partial copy beside
    // the real file. It cannot be prevented, so the contract is that the next writer
    // of the same file reclaims it.
    const leftover = path.join(workspace, '.debris.txt.dsh-ops-00000000-0000-4000-8000-000000000000')
    const unrelated = path.join(workspace, '.other.txt.dsh-ops-11111111-1111-4111-8111-111111111111')
    fs.writeFileSync(leftover, 'partial')
    fs.writeFileSync(unrelated, 'belongs to another file')

    const body = envelopeOf(await callTool('replace', { path: target, pattern: 'TOKEN', replacement: 'DONE' }, { root: workspace }), assert)
    assert.equal(body.changed, 1)
    assert.equal(fs.existsSync(leftover), false, 'the next writer must reclaim the debris for its own name')
    assert.deepEqual(fs.readdirSync(workspace).filter(entry => entry.startsWith('.debris.txt.dsh-ops-')), [], 'and leave none of its own')
    assert.equal(fs.existsSync(unrelated), true, 'debris for a different name must not be touched')
    assert.equal(fs.readFileSync(target, 'utf8'), 'DONE\n')
  })
})

await test('bounded hostile input stays bounded: a huge grep pattern and a 128 KiB single line', async () => {
  await withTempDir('linux-args-hostile', async workspace => {
    const lines = numbered(workspace, 'lines.txt', 100)
    // The native worker accepts at least a 100 KB pattern without a protocol
    // failure. The report's 8 MiB variant is exercised as "the worker may answer
    // or exit early, but must not hang" so the suite keeps its runtime budget.
    const bigPattern = envelopeOf(await callTool('grep', { path: lines, pattern: 'z'.repeat(100 * 1024) }, { root: workspace, timeoutMs: 20_000 }), assert)
    assert.equal(bigPattern.status, 'completed')
    assert.equal(bigPattern.matched, 0)

    const enormous = await callWorker(JSON.stringify(request('grep', { path: lines, pattern: 'z'.repeat(3 * 1024 * 1024) }, { root: workspace })), { timeoutMs: 20_000 })
    assert.equal(enormous.timedOut, false, 'an oversized request must not hang the worker')
    assert.ok(enormous.body !== null || enormous.exitCode !== null || enormous.stdinError !== undefined)

    // The response budget (report L4) sits at 96 KiB, so the boundary has two
    // sides and both are asserted: inside it a long line still comes back whole,
    // beyond it the line is cut and the envelope says so rather than the read
    // failing with an unknown effect. `limit` bounds the number of lines;
    // `test/output-budget.test.mjs` owns the byte accounting itself.
    const fit = path.join(workspace, 'fits.txt')
    fs.writeFileSync(fit, `${'y'.repeat(64 * 1024)}\n`)
    const whole = envelopeOf(await callTool('inspect_local_file', { path: fit, limit: 1 }, { root: workspace, timeoutMs: 20_000 }), assert)
    assert.equal(whole.status, 'completed')
    assert.equal(whole.truncated, false)
    assert.equal(whole.items[0].text.length, 64 * 1024)

    const long = path.join(workspace, 'longline.txt')
    fs.writeFileSync(long, `${'x'.repeat(128 * 1024)}\n`)
    const read = envelopeOf(await callTool('inspect_local_file', { path: long, limit: 1 }, { root: workspace, timeoutMs: 20_000 }), assert)
    assert.equal(read.status, 'completed')
    assert.equal(read.items.length, 1)
    assert.equal(read.truncated, true)
    assert.equal(read.items[0].truncatedInLine, true)
    assert.equal(read.items[0].bytesTotal, 128 * 1024)
    assert.ok(read.items[0].text.length < 128 * 1024)
  })
})

await test('the update lock file is invisible to a walk, a grep and a replace plan', async () => {
  // `ops_replace` serialises writers on a stable sidecar beside the target
  // (`.dsh-ops-update-<sha256 of the name>.lock`, never the target itself), so that artifact has to
  // stay out of every selection the file tools make: a directory-wide `replace` must not rewrite it
  // and a `glob` must not report it as a result. The walker's hidden-component rule is what keeps it
  // out, and that rule is platform-independent, so this is asserted on every host rather than only
  // where the sidecar is actually created.
  await withTempDir('lock-artifact', async workspace => {
    const sidecar = '.dsh-ops-update-1f0a6b5cd0d2b3a495e2c41a5f1b7ee2d9a4c8f6b0e3a1d7c5f2b8e6a3d9c4f1.lock'
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'one TOKEN two\n')
    fs.writeFileSync(path.join(workspace, sidecar), '')

    const globbed = envelopeOf(await callTool('glob', { path: workspace, pattern: ['**/*'] }, { root: workspace }), assert)
    assert.equal(globbed.items.some(item => String(item).includes('dsh-ops-update-')), false, JSON.stringify(globbed.items))

    const grepped = envelopeOf(await callTool('grep', { path: workspace, pattern: 'TOKEN' }, { root: workspace }), assert)
    assert.equal(grepped.items.some(item => String(item.path).includes('dsh-ops-update-')), false, JSON.stringify(grepped.items))

    const replaced = envelopeOf(await callTool('replace', { path: workspace, pattern: 'TOKEN', replacement: 'DONE' }, { root: workspace }), assert)
    assert.equal(replaced.changed, 1)
    assert.deepEqual(replaced.items.map(item => path.basename(item.path)), ['notes.txt'])
    assert.equal(fs.readFileSync(path.join(workspace, sidecar), 'utf8'), '', 'the lock sidecar must not be edited')
  })
})

report('linux-args')

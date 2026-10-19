/**
 * The persistent update sidecar is created for writes that publish — not for requests that are
 * refused, and not for a dry run.
 *
 * `ops_replace` and the single-file tools serialize cooperating writers on a hidden
 * `.dsh-ops-update-<sha256 of the name>.lock` beside the target. It is created on first use and
 * never unlinked (the lock must keep its identity across an atomic rename), so a *refused* request
 * that took the lock would leave a trace in a directory it never changed. The pure snapshot
 * validations therefore run before the lock: a stale revision, an edit conflict, an existing copy
 * destination or a dry run must leave the directory exactly as it was.
 *
 * What this suite locks in:
 *
 * - Every single-file tool refuses a stale `expectedRevision` **before** the sidecar exists, and the
 *   target keeps its bytes.
 * - `EDIT_CONFLICT` — a pure function of the current bytes — also leaves no sidecar.
 * - A `copy`/`move` whose destination already exists leaves no destination sidecar.
 * - A dry run creates nothing: `write_file` and `edit_file` answer without a lock.
 * - A successful write **does** create the sidecar: the lock contract is unchanged, so this is an
 *   assertion, not a leftover.
 *
 * Not asserted, and why: a request that fails *after* the lock (a concurrent writer winning the
 * race, publication failure) can still leave a sidecar, and a `replace` refused by
 * `maxReplacements` can leave one per matched file. Those are the documented residual cases; the
 * safety property asserted there is that no file content changes, not that the directory stays
 * identical.
 *
 * @module dsh-ops/test/lock-sidecar
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('lock-sidecar')

/** The revision form the worker accepts: a lowercase SHA-256 of the bytes. */
const revisionOf = value => crypto.createHash('sha256').update(value).digest('hex')
/** The persistent sidecar name for a target's base name. */
const sidecarOf = name => `.dsh-ops-update-${revisionOf(name.toLowerCase())}.lock`
/** The sidecars currently in a directory, sorted so a comparison is stable. */
const sidecars = directory => fs.readdirSync(directory).filter(entry => entry.endsWith('.lock')).sort()
/** A fixture written outside the worker, so the target starts without a sidecar. */
const fixture = (directory, name, content) => {
  const file = path.join(directory, name)
  fs.writeFileSync(file, content)
  return file
}

await test('a refused single-file request leaves no update sidecar', async () => {
  await withTempDir('lock-refused', async workspace => {
    const options = { root: workspace, writeRoots: [workspace] }
    const stale = revisionOf('not-the-current-bytes')
    const call = (tool, args) => callTool(tool, args, options)
    const assertRefused = (result, code, label) => {
      const body = envelopeOf(result, assert)
      assert.equal(body.status, 'error', `${label}: ${JSON.stringify(body)}`)
      assert.equal(body.error.code, code, `${label}: ${JSON.stringify(body)}`)
      return body
    }
    const assertNoNewSidecar = (name, before, label) => {
      assert.deepEqual(sidecars(workspace), before, `${label} must not create ${sidecarOf(name)}`)
      assert.equal(fs.existsSync(path.join(workspace, sidecarOf(name))), false, `${label} left a sidecar`)
    }

    // write_file: a stale revision is decided from the snapshot alone.
    const writeTarget = fixture(workspace, 'write.txt', 'original')
    assert.deepEqual(sidecars(workspace), [], 'the fixtures must start without a sidecar')
    assertRefused(await call('write_file', { path: writeTarget, content: 'next', expectedRevision: stale }), 'REVISION_CONFLICT', 'write stale revision')
    assert.equal(fs.readFileSync(writeTarget, 'utf8'), 'original', 'a refused write must keep the bytes')
    assertNoNewSidecar('write.txt', [], 'a refused write')

    // edit_file: the same pre-lock revision validation, then a pre-lock edit plan.
    const editTarget = fixture(workspace, 'edit.txt', 'alpha')
    assertRefused(await call('edit_file', { path: editTarget, edits: [{ oldText: 'alpha', newText: 'beta' }], expectedRevision: stale }), 'REVISION_CONFLICT', 'edit stale revision')
    assertNoNewSidecar('edit.txt', [], 'a refused edit')
    assertRefused(await call('edit_file', { path: editTarget, edits: [{ oldText: 'absent', newText: 'beta' }], expectedRevision: revisionOf('alpha') }), 'EDIT_CONFLICT', 'edit conflict')
    assertNoNewSidecar('edit.txt', [], 'an edit conflict')

    // copy: a stale source revision and an existing destination are both decided before the lock.
    const copySource = fixture(workspace, 'source.txt', 'payload')
    assertRefused(await call('copy', { path: copySource, to: path.join(workspace, 'copy.txt'), expectedRevision: stale }), 'REVISION_CONFLICT', 'copy stale revision')
    assertNoNewSidecar('copy.txt', [], 'a refused copy')
    fixture(workspace, 'existing.txt', 'already here')
    assertRefused(await call('copy', { path: copySource, to: path.join(workspace, 'existing.txt'), expectedRevision: revisionOf('payload') }), 'REVISION_CONFLICT', 'copy onto an existing destination')
    assertNoNewSidecar('existing.txt', [], 'a no-clobber copy')

    // move: a stale revision is refused before either sidecar (source or destination) exists.
    const moveSource = fixture(workspace, 'move-source.txt', 'payload')
    assertRefused(await call('move', { path: moveSource, to: path.join(workspace, 'move-dest.txt'), expectedRevision: stale }), 'REVISION_CONFLICT', 'move stale revision')
    assert.deepEqual(sidecars(workspace), [], 'a refused move must not create a source or destination sidecar')
    assert.equal(fs.existsSync(moveSource), true, 'a refused move must keep the source')

    // remove: a stale revision is refused before the lock and the file survives.
    const removeTarget = fixture(workspace, 'remove.txt', 'keep')
    assertRefused(await call('remove', { path: removeTarget, expectedRevision: stale }), 'REVISION_CONFLICT', 'remove stale revision')
    assert.deepEqual(sidecars(workspace), [], 'a refused remove must not create a sidecar')
    assert.equal(fs.existsSync(removeTarget), true, 'a refused remove must keep the file')
  })
})

await test('a dry run answers without creating the update sidecar', async () => {
  await withTempDir('lock-dry-run', async workspace => {
    const options = { root: workspace, writeRoots: [workspace] }
    const target = fixture(workspace, 'dry.txt', 'original')

    const written = envelopeOf(await callTool('write_file', { path: target, content: 'next', expectedRevision: revisionOf('original'), dryRun: true }, options), assert)
    assert.equal(written.dryRun, true, JSON.stringify(written))
    assert.equal(written.changed, 0, JSON.stringify(written))

    const edited = envelopeOf(await callTool('edit_file', { path: target, edits: [{ oldText: 'original', newText: 'next' }], expectedRevision: revisionOf('original'), dryRun: true }, options), assert)
    assert.equal(edited.dryRun, true, JSON.stringify(edited))

    assert.deepEqual(sidecars(workspace), [], 'a dry run changes nothing on disk, including the lock sidecar')
    assert.equal(fs.readFileSync(target, 'utf8'), 'original')
  })
})

await test('a write that publishes still creates the sidecar', async () => {
  await withTempDir('lock-success', async workspace => {
    const target = fixture(workspace, 'publish.txt', 'original')
    const done = envelopeOf(await callTool('write_file', { path: target, content: 'next', expectedRevision: revisionOf('original') }, { root: workspace, writeRoots: [workspace] }), assert)
    assert.equal(done.status, 'completed', JSON.stringify(done))
    assert.equal(fs.readFileSync(target, 'utf8'), 'next')
    assert.equal(fs.existsSync(path.join(workspace, sidecarOf('publish.txt'))), true, 'the persistent lock contract is unchanged')
  })
})

report('lock-sidecar')

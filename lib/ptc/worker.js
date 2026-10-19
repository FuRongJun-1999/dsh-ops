/** Native worker bridge. Every execution uses DSH policy, confinement and process governance. */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { credentialPath, credentialRefusal, credentialRoots } from '../credential-policy.js'
import { sessionTempDir } from '../session-temp.js'
import { denied, authorityChanged, executionRestriction, normalizeNativeDenial, credentialDenied } from '../permissions.js'
import { inside, canonicalAnchor } from '../authority-paths.js'
import { prepareWorkspace } from '../workspace-preparation.js'
export { resolveWorker } from './runtime.js'
export function failure(code, message, effectState = 'none') {
  return { status: 'error', error: { code, phase: effectState === 'none' ? 'preflight' : 'execute', retryable: false, effectState,
    nextAction: effectState === 'none' ? 'Correct the request or restore host authority.' : 'Inspect the persistent job manifest; never blindly rerun an interrupted batch.', message } }
}
export async function invoke(ctx, file, tool, args, exec, signal, config) {
  try { return await invokeTrusted(ctx, file, tool, args, exec, signal, config) }
  catch { return failure('EXECUTOR_UNAVAILABLE', 'DSH authority or execution services are unavailable; no unrestricted fallback was attempted.') }
}
async function invokeTrusted(ctx, file, tool, args, exec, signal, config) {
  const session = exec?.agent?.session
  if (!session?.id) return failure('EXECUTOR_UNAVAILABLE', 'An authoritative session identity is required.')
  const policyService = ctx.get('sandboxPolicy'), subprocess = ctx.get('subprocess')
  if (!policyService?.resolve || !subprocess?.spawn) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy and subprocess services are required.')
  const jobId = tool === 'batch' ? (args?.action === 'run' || args?.action === 'plan' ? `j-${randomUUID()}` : args?.id) : undefined
  const errorResult = (code, message, effect = 'none') => ({ ...failure(code, message, effect), ...(jobId ? { detailsRef: jobId } : {}) })
  let policy, confined, spawned = false
  try {
    policy = policyService.resolve({ session })
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode)
      || !path.isAbsolute(policy?.workspaceRoot ?? '')) return failure('EXECUTOR_UNAVAILABLE', 'Invalid authoritative DSH policy; no worker was started.')
    // Model root is a selection, never an authority override. The DSH sandbox
    // retains the original workspaceRoot even when operations select another root.
    if (args?.root !== undefined && (typeof args.root !== 'string' || !path.isAbsolute(args.root))) return failure('INVALID_ARGUMENT', 'root must be an absolute path.')
    const operationRoot = args?.root ?? policy.workspaceRoot
    const { root: _selectedRoot, ...workerArgs } = args ?? {}
    const readOnly = policy.mode === 'read-only'
    if (readOnly && !(tool === 'result' && args?.action === 'page')) return denied(policy, `${tool} ${args?.action ?? ''}`, 'workspace-write', 'The user selected read-only. Only existing result pages are permitted; no audit or business data was written.')
    // A batch root can reach a credential file through a copy, a move or a result snapshot, so the
    // credential fence covers the root as well as a read path (report: credential fence).
    if ((config?.denyCredentialReads ?? true) !== false) {
      const verdict = credentialPath(operationRoot)
      if (verdict.denied) return credentialDenied(credentialRefusal(operationRoot, verdict.matched).message)
    }
    // Comparison only: never rewrite the selected root passed to the native worker.
    const requiredMode = current => [current.workspaceRoot, sessionTempDir(session.id)]
      .some(root => inside(canonicalAnchor(root), fs.realpathSync.native(operationRoot))) ? 'workspace-write' : 'danger-full-access'
    if (policy.mode === 'workspace-write' && requiredMode(policy) === 'danger-full-access') {
      return denied(policy, `${tool} outside the workspace and session temporary directory`, 'danger-full-access', 'The selected root is outside the user-authorized workspace.')
    }
    const input = JSON.stringify({ root: operationRoot, scope: String(session.id), tool, args: workerArgs, read_only: readOnly, deny_roots: (config?.denyCredentialReads ?? true) !== false ? credentialRoots() : [], deny_credential_names: (config?.denyCredentialReads ?? true) !== false, ...(jobId ? { job_id: jobId } : {}) })
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')
    let argv = [file]
    if (policy.mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox')
      if (!sandbox?.confine) return failure('EXECUTOR_UNAVAILABLE', 'No DSH process confinement provider; refusing unconfined execution.')
      await prepareWorkspace(policy)
      confined = await sandbox.confine(argv, policy, signal)
      if (!['full', 'partial'].includes(confined?.enforcement) || !Array.isArray(confined.argv) || !confined.argv.length) {
        return failure('EXECUTOR_UNAVAILABLE', 'Invalid DSH confinement result; refusing unconfined execution.')
      }
      argv = confined.argv
    }
    signal?.throwIfAborted?.()
    // Authority may change during asynchronous sandbox preparation.
    const current = policyService.resolve({ session })
    if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(current?.mode) || !path.isAbsolute(current?.workspaceRoot ?? '')) return failure('EXECUTOR_UNAVAILABLE', 'Invalid authoritative DSH policy after preparation.')
      const operation = `${tool} ${args?.action ?? ''}`.trim()
      const required = requiredMode(current)
      if ((current.mode === 'read-only' && !(tool === 'result' && args?.action === 'page')) || (current.mode === 'workspace-write' && required === 'danger-full-access')) return denied(current, operation, required)
      return authorityChanged(current, operation)
    }
    const handle = subprocess.spawn({ argv, cwd: policy.workspaceRoot,
      stdio: { stdin: { data: input }, stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
      graceMs: 1000, signal })
    spawned = true
    const outcome = await handle.done
    const stdout = handle.collected.stdout.readFrom(0), stderr = handle.collected.stderr.readFrom(0)
    if (signal?.aborted || outcome.signal) return errorResult('RESULT_UNKNOWN', 'Worker interrupted; durable write-ahead records preserve possible effects.', 'unknown')
    if (confined && runnerFailure(outcome.exitCode, stderr.text, confined.runnerFailureRules ?? [])) {
      return failure('EXECUTOR_UNAVAILABLE', 'DSH confinement runner failed before executing the worker.')
    }
    if (stdout.lossy) return errorResult('OUTPUT_LIMIT', 'Worker output exceeded the byte budget; operation facts remain in the audit store.', 'unknown')
    if (outcome.exitCode !== 0) {
      const denied = confined?.denialSignatures?.some(s => stderr.text.toLowerCase().includes(s.toLowerCase()))
      if (denied) {
        const value = { status: 'error', error: executionRestriction(`${tool} ${args?.action ?? ''} file effects`) }
        return { ...value, ...(jobId ? { detailsRef: jobId } : {}) }
      }
      return errorResult('RESULT_UNKNOWN', 'Worker did not return a settled result; inspect audit records.', 'unknown')
    }
    let value
    try { value = JSON.parse(stdout.text) } catch { return errorResult('RESULT_UNKNOWN', 'Worker returned invalid JSON; inspect audit records.', 'unknown') }
    value = normalizeNativeDenial(value, policy, `${tool} ${args?.action ?? ''}`.trim(), 'workspace-write')
    return { ...value, ...(tool === 'batch' ? { root: operationRoot } : {}), ...(value.status === 'error' && jobId ? { detailsRef: jobId } : {}), sandbox: { mode: policy.mode, ...(confined ? { enforcement: confined.enforcement } : {}) } }
  } catch (error) {
    return errorResult(spawned ? 'RESULT_UNKNOWN' : 'EXECUTOR_UNAVAILABLE',
      `DSH execution infrastructure failed, not a user authorization denial: ${String(error?.message ?? error)}`, spawned ? 'unknown' : 'none')
  }
}
function runnerFailure(exitCode, stderr, rules) {
  if (exitCode === 0 || exitCode == null) return false
  return rules.some(rule => (!rule.allowedExitCodes || rule.allowedExitCodes.includes(exitCode))
    && stderr.split(/\r?\n/).some(line => !(rule.informationalLines ?? []).some(s => s.toLowerCase() === line.toLowerCase())
      && (rule.fatalSignatures ?? []).some(s => line.toLowerCase().includes(s.toLowerCase()))))
}

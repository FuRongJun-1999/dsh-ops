/** Shared DSH permission vocabulary. Model inputs never select an authority mode. */
export const MODES = ['read-only', 'workspace-write', 'danger-full-access']
export function permissionError(policy, operation, required = 'workspace-write', message = '', nextAction) {
  return {
    code: 'POLICY_DENIED', phase: 'preflight', retryable: false, effectState: 'none',
    permission: { current: policy.mode, required, operation, workspaceRoot: policy.workspaceRoot },
    message: `User authorization does not permit ${operation} in DSH mode ${policy.mode}. ${message}`.trim(),
    nextAction: nextAction ?? `Ask the user to change the DSH permission selector to ${required}. Do not retry, change directories, or bypass the sandbox.`,
  }
}
export function denied(policy, operation, required, message, nextAction) {
  return { status: 'rejected', error: permissionError(policy, operation, required, message, nextAction), sandbox: { mode: policy.mode } }
}

/** A changed snapshot is not proof that the current authorization is insufficient. */
export function authorityChanged(policy, operation) {
  return { status: 'error', error: {
    code: 'AUTHORITY_CHANGED', phase: 'preflight', retryable: false, effectState: 'none',
    message: `DSH authority changed while preparing ${operation}; no operation was started.`,
    nextAction: 'Confirm the current session authority before making a new request. Do not blindly retry or bypass confinement.',
  }, sandbox: { mode: policy?.mode } }
}

export function executionRestriction(operation) {
  return { code: 'EXECUTION_RESTRICTED', phase: 'execute', retryable: false, effectState: 'unknown',
    message: `${operation} encountered an execution restriction; stderr alone does not establish a DSH user authorization denial.`,
    nextAction: 'Inspect postconditions and host path, platform and OS permissions. Do not blindly retry or bypass confinement; changing the DSH selector may not resolve this restriction.' }
}

/** Only additive, recognized native reasons prove a selector denial; legacy codes alone do not. */
export function normalizeNativeDenial(value, policy, operation, required) {
  if (value?.error?.code !== 'POLICY_DENIED' || !['read-only', 'write-roots'].includes(value.error.reason)) return value
  const permission = permissionError(policy, operation, value.error.reason === 'write-roots' ? 'danger-full-access' : required)
  return { ...value, status: 'rejected', error: { ...value.error, ...permission,
    phase: value.error.phase ?? permission.phase, effectState: value.error.effectState ?? permission.effectState,
    nextAction: `${permission.nextAction} Inspect any reported effects before a new attempt.` } }
}

export function credentialDenied(message) {
  return { status: 'rejected', error: { code: 'CREDENTIAL_DENIED', phase: 'preflight', retryable: false, effectState: 'none', message,
    nextAction: 'Choose a non-credential path. Do not retry or bypass the credential fence; changing the DSH permission selector does not remove it.' } }
}

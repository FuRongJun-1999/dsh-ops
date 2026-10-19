/** Single native contract drives host schemas, SDK types and callable names. */
import { publicToolName } from '../policy.js'
const string = { type: 'string' }
const integer = { type: 'integer' }
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
export const PTC_TOOLS = ['batch', 'result']
export const PTC_SECTION = 'dsh-ops:repository-tooling:ptc'
export const PARAMETERS = {
  batch: object({
    root: string,
    action: { type: 'string', enum: ['plan', 'run', 'resume'] },
    operations: { type: 'array', description: '1-512 operations; enforced by the native worker.', items: object({ op: { type: 'string', enum: ['copy', 'move', 'remove'] }, path: string, to: string }, ['op', 'path']) },
    operationsRef: string,
    protect: { type: 'array', description: 'At most 128 protected relative paths.', items: string },
    id: string,
  }, ['action']),
  result: object({
    action: { type: 'string', enum: ['put', 'page', 'release'] }, root: string, id: string,
    items: { type: 'array', description: 'At most 10000 object rows; 2 MiB request/store cap.', items: { type: 'object' } },
    offset: { ...integer, description: 'Nonnegative filtered-row offset; default 0.' },
    limit: { ...integer, description: '1-512 rows; default 64.' },
    maxBytes: { ...integer, description: '512-65536 serialized bytes; default 16384.' },
    fields: { type: 'array', description: 'At most 32 top-level field names, each at most 128 bytes.', items: string },
    equals: { type: 'object' },
  }, ['action']),
}
// Open JSON values exist only in the data plane (caller-owned rows), not in operation inputs.
export const OUTPUT = {
  type: 'object', properties: {
    id: string, root: string, status: string, phase: string, done: integer, total: integer,
    failed: integer, unknown: integer, logicalBytes: integer, byteSemantics: string,
    detailsRef: string, complete: { type: 'boolean' }, omitted: integer, nextAction: string,
    sourceTotal: integer, contentHash: string,
    expires: { oneOf: [integer, { type: 'null' }] }, items: { type: 'array', items: { type: 'object' } }, nextOffset: integer,
    sandbox: object({ mode: string, enforcement: string }, ['mode']),
    error: object({ code: string, phase: string, retryable: { type: 'boolean' }, effectState: string, nextAction: string, message: string,
      permission: object({ current: string, required: string, operation: string, workspaceRoot: string }),
    }, ['code', 'phase', 'retryable', 'effectState', 'nextAction', 'message']),
  },
}
export const DESCRIPTIONS = {
  batch: 'Preflight and verify copy/move/remove. action=plan requires operations and creates a no-effect audit plan; execute that exact plan with action=resume plus id (do not change it to run). action=run requires operations and executes immediately. root, when supplied, must be an absolute path: a relative root is rejected at preflight with INVALID_ARGUMENT. Omit root to use the session workspace root; an absolute root follows DSH permissions (unrestricted in full access). Operations use relative / paths, no overwrite or link traversal. Page detailsRef with ops_result, passing the same root whenever the plan root differs from the session workspace root. Parameter errors return structured error objects.',
  result: 'Session-owned object rows: put items (up to 10000; 2 MiB request/store cap), page, release. Pages default to offset=0, limit=64, maxBytes=16384; follow nextOffset until complete. equals filters top-level exact values before fields projection; offset/total/omitted count filtered rows. sourceTotal/contentHash identify all ordered rows before filtering/projection (SHA-256 of worker compact JSON with sorted object keys); compare hashes across pages to detect changed audits, never as authority. An oversized row returns OUTPUT_LIMIT: project fewer fields or raise maxBytes (max 65536). Result expiry is 24h, returned as Unix seconds; audit pages have expires=null and cannot be released. operationsRef in ops_batch accepts only owned unexpired result rows. Pass the same root as the batch when paging detailsRef, or expect NOT_FOUND. Failures are structured values, not thrown errors. In run_code, process pages locally and return only needed summaries.',
}
export function definition(tool, execute) {
  return { name: publicToolName(tool), description: DESCRIPTIONS[tool], parameters: PARAMETERS[tool],
    timeoutMs: 300000,
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
  }
}

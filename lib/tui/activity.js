/** Read-only projection of live DSH tool events; never executes or retains tool input/output. */
import { FILE_TOOLS, IN_PROCESS_TOOLS, publicToolName } from '../policy.js'
import { PTC_TOOLS } from '../ptc/contract.js'
import { BUSINESS_OUTCOMES, resultDetails } from './result.js'

const OWN_TOOLS = new Set([...FILE_TOOLS, ...IN_PROCESS_TOOLS, ...PTC_TOOLS].map(publicToolName))
export const ACTIVITY_DEFAULTS = Object.freeze({ maxSessions: 32, maxActive: 128, recentLimit: 8 })
const emptyBusiness = () => Object.fromEntries(BUSINESS_OUTCOMES.map(key => [key, 0]))
const EMPTY = Object.freeze({ business: Object.freeze(emptyBusiness()), total: 0, running: 0, returned: 0, errors: 0, limited: false,
  since: undefined, active: Object.freeze([]), recent: Object.freeze([]) })

function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 1024 }
function validTime(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }

/** Native and PTC results share transport facts, but a normal return is NOT business success. */
function transportFailed(data, nested) {
  if (data.error !== undefined) return true
  if (nested) return data.isError === true
  return data.message?.isError === true
}

/** Validate retention settings shared by the optional observer and its bundle row. */
export function resolveActivityConfig(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new Error('TUI activity config must be an object')
  for (const key of Object.keys(options)) if (!Object.hasOwn(ACTIVITY_DEFAULTS, key)) throw new Error('Unknown TUI activity config key: ' + key)
  const config = { ...ACTIVITY_DEFAULTS, ...options }
  for (const [key, ceiling] of [['maxSessions', 256], ['maxActive', 1024], ['recentLimit', 64]]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > ceiling) {
      throw new Error(key + ' must be an integer from 1 to ' + ceiling)
    }
  }
  return Object.freeze(config)
}

/**
 * Bounded, instance-owned activity for events observed after mounting, not session-history replay.
 * At capacity, new active calls are omitted and limited is set; existing calls still settle.
 * Session LRU eviction drops statistics only, never running work. Call IDs are opaque.
 */
export function createActivityStore(options = {}) {
  const config = resolveActivityConfig(options)
  const sessions = new Map(), listeners = new Set()
  let disposed = false

  function publish(state) {
    state.snapshot = Object.freeze({ business: Object.freeze({ ...state.business }), total: state.total, running: state.active.size,
      returned: state.returned, errors: state.errors, limited: state.limited, since: state.since,
      active: Object.freeze([...state.active.values()]), recent: Object.freeze([...state.recent]) })
    for (const listener of [...listeners]) {
      try { listener() } catch { /* Observers cannot affect a committed tool result or one another. */ }
    }
  }

  function observe(sessionId, event) {
    if (disposed || !validId(sessionId) || !event || !Number.isSafeInteger(event.seq) || event.seq < 0 || !validTime(event.time)) return false
    const data = event.data
    if (!data || typeof data !== 'object') return false
    const start = event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start'
    const settle = event.type === 'tool/result' || event.type === 'tool/ptc-dispatch'
    if (!start && !settle) return false
    const nested = event.type.startsWith('tool/ptc-')
    const id = nested ? data.subCallId : start ? data.callId : data.message?.source?.callId
    if (!validId(id)) return false
    let state = sessions.get(sessionId)
    // Only tracked native results belong to us; do not allocate state for arbitrary tools.
    if ((start || nested) && !OWN_TOOLS.has(data.name)) return false
    if (!start && !state?.active.has(id)) {
      if (state && event.seq > state.seq && (nested && OWN_TOOLS.has(data.name))) {
        state.seq = event.seq; state.limited = true; publish(state)
      }
      return false
    }
    if (!state) {
      if (sessions.size >= config.maxSessions) sessions.delete(sessions.keys().next().value)
      state = { seq: -1, since: event.time, total: 0, returned: 0, errors: 0, limited: false,
        active: new Map(), recent: [], snapshot: EMPTY, business: emptyBusiness() }
      sessions.set(sessionId, state)
    }
    if (event.seq <= state.seq) return false
    state.seq = event.seq
    sessions.delete(sessionId); sessions.set(sessionId, state)
    if (start) {
      if (state.active.has(id)) return false
      if (state.active.size >= config.maxActive) { state.limited = true; publish(state); return false }
      state.active.set(id, Object.freeze({ id, name: data.name, startedAt: event.time, status: 'running' }))
      state.total += 1
    } else {
      const call = state.active.get(id)
      if (nested && call.name !== data.name) return false
      state.active.delete(id)
      const failed = transportFailed(data, nested)
      state[failed ? 'errors' : 'returned'] += 1
      const details = resultDetails(call.name, data, nested)
      state.business[details.outcome] += 1
      state.recent.unshift(Object.freeze({ ...call, ...details, status: failed ? 'error' : 'returned',
        durationMs: Math.max(0, event.time - call.startedAt) }))
      state.recent.length = Math.min(state.recent.length, config.recentLimit)
    }
    publish(state)
    return true
  }

  return Object.freeze({
    observe,
    snapshot: sessionId => sessions.get(sessionId)?.snapshot ?? EMPTY,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true; sessions.clear()
      for (const listener of [...listeners]) {
        try { listener() } catch { /* Disposal remains best effort for observers. */ }
      }
      listeners.clear()
    },
  })
}

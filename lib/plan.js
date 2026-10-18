// Agent execution plan and task state.
//
// Plan is captured DIRECTLY via native tool rather than parsing chat messages:
// message parsing is heuristic, and external todo tools introduce fragile dependencies.
//
// State is an explicit fact rather than timeout inference.

/** Maximum plan items retained: plan is not a log history. */
export const MAX_ITEMS = 50

/** Truncate items longer than this: displayed in card single-line view. */
export const MAX_ITEM_LENGTH = 120

const EMPTY = { items: [], current: 0 }

/** Coerce item to string of reasonable length. */
function cleanItem(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > MAX_ITEM_LENGTH ? text.slice(0, MAX_ITEM_LENGTH - 1) + '…' : text
}

/**
 * Parse plan from storage.
 *
 * Corrupted field must not break board loading; errors return empty plan.
 */
export function parsePlan(raw) {
  if (typeof raw !== 'string' || raw === '') return EMPTY
  try {
    const value = JSON.parse(raw)
    const items = Array.isArray(value?.items)
      ? value.items.map(cleanItem).filter((t) => t !== '').slice(0, MAX_ITEMS)
      : []
    return { items, current: clampCurrent(value?.current, items.length) }
  } catch {
    return EMPTY
  }
}

export function serializePlan(plan) {
  return JSON.stringify({ items: plan.items, current: plan.current })
}

/**
 * Pointer to active plan item.
 *
 */
function clampCurrent(value, total) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.floor(n), total + 1)
}

/**
 * Apply tool update to existing plan.
 *
 */
export function applyPlan(previous, patch) {
  const prev = previous ?? EMPTY
  const items = Array.isArray(patch?.items)
    ? patch.items.map(cleanItem).filter((t) => t !== '').slice(0, MAX_ITEMS)
    : prev.items
  const current = patch?.current === undefined || patch?.current === null
    ? clampCurrent(prev.current, items.length)
    : clampCurrent(patch.current, items.length)
  return { items, current }
}

/**
 * Plan display metadata.
 *
 *
 * @returns {{total: number, done: number, current: number, text: string}|undefined}
 */
export function planProgress(plan) {
  const items = plan?.items ?? []
  if (items.length === 0) return undefined
  const current = clampCurrent(plan?.current, items.length)
  // Items before active pointer are considered completed.
  // Items before active pointer are considered completed.
  const done = current === 0 ? 0 : Math.min(current - 1, items.length)
  const text = current >= 1 && current <= items.length ? items[current - 1] : ''
  return { total: items.length, done, current, text }
}

/** Plan item checklist state. */
export function planItems(plan) {
  const items = plan?.items ?? []
  const current = clampCurrent(plan?.current, items.length)
  return items.map((text, i) => ({
    text,
    done: current > i + 1,
    active: current === i + 1,
  }))
}

/**
 * Task state resolution.
 *
 *
 *
 * @param {{task: object, live: 'running'|'idle'|undefined}} args
 */
export function taskState({ task, live }) {
  const sessionId = typeof task?.sessionId === 'string' ? task.sessionId : ''
  if (sessionId === '') return 'none'
  // Task queued for agent session.
  // Task queued for agent session.
  // Task queued for agent session.
  if (typeof task?.queuedAt === 'number' && task.queuedAt > 0) return 'queued'
  // Human waiting takes precedence over running status.
  // Human waiting takes precedence over running status.
  if (task?.waiting === true) return 'waiting'
  if (live === undefined) return 'stopped'
  return live === 'running' ? 'running' : 'idle'
}

/**
 * Task index in session queue.
 *
 *
 *
 * @returns {number|undefined} 1-based index in queue
 */
export function queuePosition(task, sameSession) {
  const at = task?.queuedAt
  if (typeof at !== 'number' || at <= 0) return undefined
  const ahead = (sameSession ?? [])
    .filter((x) => typeof x?.queuedAt === 'number' && x.queuedAt > 0 && x.queuedAt < at)
  return ahead.length + 1
}

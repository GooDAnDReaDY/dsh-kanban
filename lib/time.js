// Relative time formatting for board.
// Returns duration values; frontend translates and renders them.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago the timestamp occurred.
 *
 * Future timestamps are clamped to present moment.
 * Board does not project future timestamps.
 *
 * @returns {{unit: 'now'|'min'|'hour'|'day', value: number}|undefined}
 *   `undefined` - no timestamp.
 */
export function relativeParts(now, then) {
  if (typeof then !== 'number' || !Number.isFinite(then) || then <= 0) return undefined
  const delta = Math.max(0, now - then)
  if (delta < MINUTE) return { unit: 'now', value: 0 }
  if (delta < HOUR) return { unit: 'min', value: Math.floor(delta / MINUTE) }
  if (delta < DAY) return { unit: 'hour', value: Math.floor(delta / HOUR) }
  return { unit: 'day', value: Math.floor(delta / DAY) }
}

/**
 * Whether task has been idle past threshold.
 * Relies on last activity timestamp rather than active pinging.
 */
export function isStale({ now, updatedAt, sessionId, afterMinutes }) {
  const limit = Number(afterMinutes)
  if (!Number.isFinite(limit) || limit <= 0) return false
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const parts = relativeParts(now, updatedAt)
  if (!parts) return false
  return now - updatedAt >= limit * MINUTE
}

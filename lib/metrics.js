// Board metrics: view over transition history, not new mutable state.
//
// History accumulates from day one, but was previously queried per-task.
// Questions like 'where is bottleneck', 'task lifetime', 'stale tasks'
// can all be answered from transition records.
//
// Read-only calculation: metrics do not write state to avoid becoming an
// unaligned second source of truth.

/**
 * Time spent by task in each column.
 *
 * Transition closes previous time slice and opens next.
 * Final slice closes at present moment.
 *
 * @param {Array<{toCol: string, at: number}>} moves task transitions, oldest first
 * @param {number} bornAt task creation timestamp
 * @param {number} now
 * @returns {Object<string, number>} column -> milliseconds
 */
export function timeInColumns(moves, bornAt, now) {
  const rows = (moves ?? [])
    .filter((m) => typeof m?.at === 'number' && typeof m?.toCol === 'string')
    .slice()
    .sort((a, b) => a.at - b.at)

  const out = {}
  // Prior to first transition, task resides in initial column.
  // Derived from `fromCol` of first transition.
  let col = rows.length > 0 && typeof rows[0].fromCol === 'string' ? rows[0].fromCol : 'backlog'
  let since = typeof bornAt === 'number' ? bornAt : (rows[0]?.at ?? now)

  const add = (where, ms) => {
    if (ms <= 0) return
    out[where] = (out[where] ?? 0) + ms
  }

  for (const move of rows) {
    add(col, move.at - since)
    col = move.toCol
    since = move.at
  }
  add(col, now - since)
  return out
}

/** Median calculation. */
export function median(values) {
  const rows = (values ?? []).filter((x) => typeof x === 'number').slice().sort((a, b) => a - b)
  if (rows.length === 0) return 0
  const mid = Math.floor(rows.length / 2)
  return rows.length % 2 === 1 ? rows[mid] : Math.round((rows[mid - 1] + rows[mid]) / 2)
}

/** Mean average; empty set returns zero without dividing by zero. */
export function mean(values) {
  const rows = (values ?? []).filter((x) => typeof x === 'number')
  if (rows.length === 0) return 0
  return Math.round(rows.reduce((sum, x) => sum + x, 0) / rows.length)
}

/**
 * Column summary: average and median time spent in each column.
 *
 * Median is preferred over average: a single forgotten task can skew
 * the average heavily.
 *
 * @param {Array<{task: object, moves: object[]}>} rows
 * @returns {Array<{column: string, mean: number, median: number, tasks: number}>}
 */
export function columnStats(rows, now) {
  const byColumn = new Map()
  for (const row of rows ?? []) {
    const spent = timeInColumns(row.moves, row.task?.createdAt, now)
    for (const [column, ms] of Object.entries(spent)) {
      if (!byColumn.has(column)) byColumn.set(column, [])
      byColumn.get(column).push(ms)
    }
  }
  return [...byColumn.entries()]
    .map(([column, values]) => ({
      column,
      mean: mean(values),
      median: median(values),
      tasks: values.length,
    }))
    .sort((a, b) => b.median - a.median)
}

/**
 * Tasks that stayed in their current column longer than threshold.
 *
 * Measured from column entry timestamp rather than creation date.
 *
 * @returns {Array<{id: string, title: string, column: string, since: number}>}
 */
export function stale(tasks, now, thresholdMs) {
  if (!(thresholdMs > 0)) return []
  return (tasks ?? [])
    .filter((task) => {
      const at = typeof task?.columnAt === 'number' && task.columnAt > 0 ? task.columnAt : task?.createdAt
      return typeof at === 'number' && now - at >= thresholdMs
    })
    .map((task) => ({
      id: task.id,
      title: task.title,
      column: task.column,
      since: (typeof task.columnAt === 'number' && task.columnAt > 0 ? task.columnAt : task.createdAt),
    }))
    .sort((a, b) => a.since - b.since)
}

/**
 * How many tasks reached 'done' within given time period.
 *
 * Computed from transitions rather than current column to account for archived tasks.
 */
export function doneWithin(rows, from, to) {
  let count = 0
  for (const row of rows ?? []) {
    const hit = (row.moves ?? []).some((m) => m?.toCol === 'done' && m.at >= from && m.at <= to)
    if (hit) count += 1
  }
  return count
}

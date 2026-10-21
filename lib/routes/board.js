import { COLUMN_ORDER, columnsOf, wipLimitField, columnNamesOf } from '../config.js'
import { parsePlan, planItems, planProgress, taskState, queuePosition } from '../plan.js'
import { columnStats, doneWithin, stale } from '../metrics.js'
import { isStale } from '../time.js'
import { facetsOf, facetsOfTask, groupByRepo, sortByLife } from '../filters.js'
import { computeNextRun } from '../cron.js'

export function withPlan(task, liveOf, config, now, sameSession) {
  const plan = parsePlan(task.plan)
  // Registry error implies agent unavailable; do not fail whole board render.
  let live
  try {
    if (typeof liveOf === 'function' && task.sessionId) live = liveOf(task.sessionId)
  } catch { live = undefined }
  const liveStatus = typeof live === 'object' && live !== null ? live.status : live
  const liveStep = typeof live === 'object' && live !== null
    ? (live.step || live.activity || live.stateDetail || '')
    : ''

  const costMetrics = task.costMetrics || null
  const costLimitExceeded = (config?.costMeterEnabled !== false && Number(config?.taskCostLimit) > 0 && costMetrics?.costUsd)
    ? costMetrics.costUsd >= Number(config.taskCostLimit)
    : Boolean(task.costLimitExceeded)

  return {
    ...task,
    plan: { items: planItems(plan), progress: planProgress(plan) },
    state: taskState({ task, live: liveStatus }),
    liveStep: liveStep || task.liveStep || '',
    costMetrics,
    costLimitExceeded,
    // Queue position calculated dynamically across active tasks in same session.
    queuePos: queuePosition(task, sameSession),
    // Label facets extracted on server for consistent client filtering.
    facets: facetsOfTask(task),
    // Stale calculation performed on host where configuration resides.
    stale: isStale({
      now,
      updatedAt: task.updatedAt,
      sessionId: task.sessionId,
      afterMinutes: config?.staleAfterMin,
    }),
    // Overdue calculated on host using server clock.
    overdue: typeof task.dueAt === 'number' && task.dueAt > 0 && task.dueAt < now,
  }
}

/** Order tasks: by column, grouped by repository, with active tasks on top. */
function orderForBoard(tasks, columns) {
  const out = []
  for (const column of columns) {
    const inColumn = tasks.filter((t) => t.column === column)
    for (const group of groupByRepo(sortByLife(inColumn))) out.push(...group.tasks)
  }
  // Retain tasks in columns not visible on current board to prevent data loss.
  const seen = new Set(out.map((t) => t.id))
  for (const task of tasks) if (!seen.has(task.id)) out.push(task)
  return out
}

/**
 * Build board response payload: columns in canonical order, tasks, and limits.
 */
export function buildBoard({ store, config, board = 'main', repo, liveOf, sync, projectRoot, costMeterAvailable = false }) {
  // Uniform timestamp across snapshot calculation.
  const now = Date.now()
  // Tasks are sorted and grouped on server: repo grouping with active items first.
  const raw = store.listTasks({ board, repo })
  // Queue position scoped per session.
  const bySession = new Map()
  for (const task of raw) {
    const id = typeof task.sessionId === 'string' ? task.sessionId : ''
    if (id === '') continue
    if (!bySession.has(id)) bySession.set(id, [])
    bySession.get(id).push(task)
  }
  const tasks = orderForBoard(
    raw.map((task) => {
      const enriched = withPlan(task, liveOf, config, now, bySession.get(task.sessionId) ?? [])
      if (task.isEpic) {
        enriched.subtasksCount = store.countSubtasks(task.id)
      }
      return enriched
    }),
    columnsOf(store.boardKind(board)),
  )
  const kind = store.boardKind(board)
  // Column custom names sent from server; locale translation handled by client.
  const names = columnNamesOf(config)
  const columns = columnsOf(kind).map((id) => {
    const count = tasks.filter((t) => t.column === id).length
    const limit = wipLimitField(config, id)
    return { id, name: names[id], count, limit, overLimit: limit !== undefined && count > limit }
  })
  // Filter counts calculated over all tasks on board.
  return {
    board, kind, now, boards: store.listBoards(), columns, tasks,
    // Resolved project root {path, set} computed on host.
    projectRoot: projectRoot ?? { path: '', set: false },

    facets: facetsOf(tasks),
    // Sync telemetry state attached directly to board snapshot.
    sync: sync ?? { state: 'never' },
    costMeterAvailable: Boolean(costMeterAvailable),
    remoteMode: Boolean(config?.remoteMode),
  }
}

/**
 * Card move transition. WIP limit is advisory: move executes, and exceeded status
 * is returned for UI highlighting.
 */

export function boardMetrics({ store, board = 'main', now = Date.now(), staleDays = 14 }) {
  const tasks = store.listTasks({ board })
  const byTask = new Map()
  for (const row of store.listAllTransitions()) {
    if (!byTask.has(row.taskId)) byTask.set(row.taskId, [])
    byTask.get(row.taskId).push(row)
  }
  const rows = tasks.map((task) => ({ task, moves: byTask.get(task.id) ?? [] }))
  const day = 24 * 60 * 60 * 1000

  return {
    tasks: tasks.length,
    columns: columnStats(rows, now),
    done: {
      week: doneWithin(rows, now - 7 * day, now),
      month: doneWithin(rows, now - 30 * day, now),
    },
    staleDays,
    stale: stale(tasks, now, staleDays * day).slice(0, 50),
  }
}

/**
 * Check whether a task can be resumed.
 * Eligible when task has recorded sessionId but no active agent is running.
 */

export function exportBoard({ store }) {
  return store.exportAll()
}

/**
 * Restore board from backup snapshot (idempotent; skips existing IDs).
 *
 * @returns {{imported: number, skipped: number, error?: string}}
 */
export function importBoard({ store, input }) {
  let backupMeta = undefined
  if (typeof store.backupDatabase === 'function') {
    try {
      backupMeta = store.backupDatabase()
    } catch { /* backup best effort */ }
  }
  if (input === null || typeof input !== 'object') return { error: 'bad-import', status: 400 }
  if (input.version !== 1) return { error: 'bad-import-version', status: 400 }
  if (!Array.isArray(input.tasks)) return { error: 'bad-import', status: 400 }

  let imported = 0
  let skipped = 0

  const doImport = () => {
    for (const board of Array.isArray(input.boards) ? input.boards : []) {
      if (typeof board?.id !== 'string' || board.id === '') continue
      store.createBoard({
        id: board.id,
        title: board.title,
        kind: board.kind,
        position: board.position,
        createdAt: board.createdAt,
      })
    }

    for (const task of input.tasks) {
      if (typeof task?.id !== 'string' || task.id === '') continue
      if (store.getTask(task.id) !== undefined) { skipped += 1; continue }
      if (typeof store.restoreTask === 'function') {
        store.restoreTask(task)
      } else {
        store.createTask(task)
      }
      imported += 1
    }

    for (const trans of Array.isArray(input.transitions) ? input.transitions : []) {
      if (typeof trans?.taskId !== 'string' || trans.taskId === '') continue
      if (typeof store.restoreTransition === 'function') {
        store.restoreTransition(trans)
      } else if (typeof store.addTransition === 'function') {
        store.addTransition(trans)
      }
    }
  }

  if (typeof store.withTransaction === 'function') {
    store.withTransaction(doImport)
  } else {
    doImport()
  }

  return { imported, skipped, backup: backupMeta?.backup }
}

/**
 * Export tasks to Excel-compatible CSV with UTF-8 BOM (#223).
 *
 * @param {{store: object, board?: string}} options
 * @returns {string} CSV string with UTF-8 BOM prefix
 */
export function exportTasksCsv({ store, board = 'main' }) {
  const tasks = store.listTasks({ board })
  const headers = [
    'ID',
    'Title',
    'Column',
    'Priority',
    'Repository',
    'Issue #',
    'Assignee',
    'Model',
    'Provider',
    'Reasoning Effort',
    'Workspace',
    'Branch',
    'Created',
    'Updated',
  ]

  function escapeCsv(val) {
    if (val === null || val === undefined) return ''
    let str = String(val)
    // OWASP CSV Injection mitigation (#340)
    const trimmed = str.replace(/^[\s\t\r\n]+/, '')
    if (/^[=+\-@\t\r]/.test(str) || (trimmed.length > 0 && /^[=+\-@]/.test(trimmed))) {
      str = `'${str}`
    }
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  function formatDate(ts) {
    if (!ts || typeof ts !== 'number') return ''
    try {
      return new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
    } catch {
      return ''
    }
  }

  const rows = [headers.join(',')]
  for (const t of tasks) {
    const row = [
      escapeCsv(t.id),
      escapeCsv(t.title),
      escapeCsv(t.column),
      escapeCsv(t.priority),
      escapeCsv(t.repo),
      escapeCsv(t.issueNumber ?? ''),
      escapeCsv(t.assignee),
      escapeCsv(t.model),
      escapeCsv(t.provider),
      escapeCsv(t.reasoningEffort ?? ''),
      escapeCsv(t.workspaceId),
      escapeCsv(t.branch),
      escapeCsv(formatDate(t.createdAt)),
      escapeCsv(formatDate(t.updatedAt)),
    ]
    rows.push(row.join(','))
  }

  // UTF-8 BOM prefix for Microsoft Excel
  return '\uFEFF' + rows.join('\r\n')
}


/**
 * Clean up task worktree.
 */
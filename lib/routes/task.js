import { parseBody } from '../markdown.js'
import { columnsOf, wipLimitField } from '../config.js'
import { withPlan } from './board.js'

export function parseTaskPath(pathname) {
  const m = /^\/dsh-kanban\/task\/([^/]+)(?:\/([a-z-]+))?\/?$/.exec(pathname ?? '')
  if (m === null) return undefined
  return { id: decodeURIComponent(m[1]), action: m[2] }
}

/**
 * Enrich task with parsed plan, state, and filters.
 *
 * Plan is pre-parsed on server because client bundle cannot import `lib/plan.js`.
 * `liveOf` returns active agent state or undefined if session is inactive.
 */

export function applyMove({ store, config, id, column, beforeId, afterId, source = 'manual', detail = '' }) {
  const before = store.getTask(id)
  if (before === undefined) return { error: 'task-not-found', status: 404 }
  if (column !== undefined && column !== null) {
    const allowed = columnsOf(store.boardKind(before.board))
    if (!allowed.includes(column)) {
      return { error: 'invalid-column', status: 400 }
    }
  }
  const task = store.moveTask(id, { column, beforeId, afterId })
  if (task.column !== before.column) {
    store.addTransition({
      taskId: id, fromCol: before.column, toCol: task.column, source, detail,
    })
  }
  const limit = wipLimitField(config, task.column)
  const count = store.countInColumn(task.board, task.column)
  return { task, overLimit: limit !== undefined && count > limit }
}

/** Create local board task (not linked to Gitea). */
export function createTask({ store, input }) {
  const title = typeof input?.title === 'string' ? input.title.trim() : ''
  if (title === '') return { error: 'title-required', status: 400 }
  const board = input?.board ?? 'main'
  // Validate column against board kind; simple boards do not have deploy/cleanup.
  const allowed = columnsOf(store.boardKind(board))
  const column = allowed.includes(input?.column) ? input.column : 'backlog'
  const task = store.createTask({
    board,
    column,
    title,
    body: typeof input?.body === 'string' ? input.body : '',
    labels: Array.isArray(input?.labels) ? input.labels.filter((l) => typeof l === 'string') : [],
  })
  return { task }
}

/** Update card fields. Column transitions are handled via applyMove. */
export function updateTask({ store, id, input }) {
  const current = store.getTask(id)
  if (current === undefined) return { error: 'task-not-found', status: 404 }
  const patch = {}
  if (typeof input?.title === 'string' && input.title.trim() !== '') patch.title = input.title.trim()
  if (typeof input?.body === 'string') patch.body = input.body
  if (Array.isArray(input?.labels)) patch.labels = input.labels.filter((l) => typeof l === 'string')
  // Priority is local to board and not synced back to Gitea.
  if (PRIORITIES.includes(input?.priority)) patch.priority = input.priority
  // Deadline is local. 0 clears deadline; positive value sets it.
  if (typeof input?.dueAt === 'number' && Number.isFinite(input.dueAt) && input.dueAt >= 0) {
    patch.dueAt = Math.floor(input.dueAt)
  }
  if (typeof input?.cron === 'string') {
    patch.cron = input.cron.trim()
    patch.nextRunAt = patch.cron ? (computeNextRun(patch.cron) || 0) : 0
  }
  if (Array.isArray(input?.checklist)) patch.checklist = input.checklist
  if (input?.report && typeof input.report === 'object') patch.report = input.report
  if (Array.isArray(input?.comments)) patch.comments = input.comments
  if (typeof input?.rejectReason === 'string') patch.rejectReason = input.rejectReason
  if (typeof input?.progressDump === 'string') {
    patch.progressDump = input.progressDump
  }
  if (typeof input?.permission === 'string') {
    patch.permission = input.permission
    if (input.permission !== current.permission) {
      patch.permissionConfirmedAt = 0
      patch.permissionConfirmedTier = ''
    }
  }

  if (typeof input?.reasoningEffort === 'string') {
    const val = input.reasoningEffort.trim().toLowerCase()
    if (['', 'low', 'medium', 'high', 'default', 'none', 'minimal', 'thorough'].includes(val)) {
      patch.reasoningEffort = val
    }
  }
  if (typeof input?.forge === 'string') {
    const val = input.forge.trim().toLowerCase()
    if (val === 'github' || val === 'gitea') patch.forge = val
  }
  return { task: store.updateTask(id, patch) }
}

export function confirmPermission({ store, id, tier }) {
  const task = store.getTask(id)
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  const effectiveTier = typeof tier === 'string' && tier ? tier : (task.permission || 'default')
  return { task: store.updateTask(id, { permissionConfirmedAt: Date.now(), permissionConfirmedTier: effectiveTier }) }
}

/** Known priority values. Empty string indicates unprioritized. */
const PRIORITIES = ['', 'high', 'medium', 'low']

/**
 * Append note to task body.
 * Handled on server to prevent overwriting edits made elsewhere.
 */
export function appendNote({ store, id, input }) {
  const task = store.getTask(id)
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  const note = typeof input?.text === 'string' ? input.text.trim() : ''
  if (note === '') return { error: 'note-required', status: 400 }
  const body = typeof task.body === 'string' ? task.body : ''
  return { task: store.updateTask(id, { body: body === '' ? note : `${body}\n\n${note}` }) }
}

/**
 * Archive or unarchive card.
 * Unarchiving restores card to its original column and position.
 */
export function setArchived({ store, id, archived, now = Date.now() }) {
  const task = store.getTask(id)
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  return { task: store.setArchived(id, archived ? now : 0) }
}

/** Query archived tasks list. */
export function listArchive({ store }) {
  return { tasks: store.listArchived() }
}

/**
 * Assign task or clear assignment.
 * Empty login unassigns the task.
 *
 * @returns {{task: object}|{error: string, status: number}}
 */
export function assignTask({ store, id, login }) {
  const task = store.getTask(id)
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  const who = typeof login === 'string' ? login.trim() : ''
  if (who === (task.assignee ?? '')) return { task }
  store.updateTask(id, { assignee: who })
  store.addTransition({
    taskId: id,
    fromCol: task.column,
    toCol: task.column,
    source: 'manual',
    detail: who === '' ? 'unassigned' : `assigned: ${who}`,
  })
  return { task: store.getTask(id) }
}

export function deleteTask({ store, id }) {
  if (store.getTask(id) === undefined) return { error: 'task-not-found', status: 404 }
  store.deleteTask(id)
  return { ok: true }
}

/**
 * Parse task markdown body into structured block elements.
 * Done on server so client bundle does not need markdown parser.
 */
/**
 * Board metrics: WIP distribution and stale tasks.
 *
 * @returns {{columns: object[], done: object, stale: object[], tasks: number}}
 */

export function canRevive(task, live) {
  if (task?.stalled) return true
  const has = typeof task?.sessionId === 'string' && task.sessionId !== ''
  return has && (live === undefined || live === null)
}

export function taskBody({ store, id }) {
  const task = store.getTask(id)
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  return { blocks: parseBody(task.body) }
}

export function taskLog({ store, id }) {
  if (store.getTask(id) === undefined) return { error: 'task-not-found', status: 404 }
  return { transitions: store.listTransitions(id) }
}

/** Find task associated with session; absence is normal response. */
export function taskBySession({ store, sessionId, agents }) {
  const task = store.findTaskBySession(sessionId)
  if (task === undefined) return { task: null }
  let live
  try { live = agents?.get?.(sessionId) } catch { live = undefined }
  // Board kind returned with task so UI displays matching column choices.
  return {
    task,
    columns: columnsOf(store.boardKind(task.board)),
    canRevive: canRevive(task, live),
  }
}

/**
 * Export full board snapshot for backup or migration.
 */
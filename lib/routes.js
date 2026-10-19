import crypto from 'node:crypto'
// HTTP route handlers for the board.
//
// The client bundle runs in the browser without direct access to SQLite or host services;
// it interacts with these handlers. Handlers accept parsed inputs and the store instance,
// returning response objects to facilitate testing without full HTTP server setups.
// Request/response wrapper integration lives in `lib/index.js`.

import { COLUMN_ORDER, columnsOf, wipLimitField, columnNamesOf } from './config.js'
import { parsePlan, planItems, planProgress, taskState, queuePosition } from './plan.js'
import { columnStats, doneWithin, stale } from './metrics.js'
import { isStale } from './time.js'
import { facetsOf, facetsOfTask, groupByRepo, sortByLife } from './filters.js'
import { parseBody } from './markdown.js'
import { computeNextRun } from './cron.js'

/** Maximum request payload size to prevent denial of service. */
export const MAX_BODY_BYTES = 256 * 1024

export function isLoopbackAddress(addr) {
  if (!addr || typeof addr !== 'string') return false
  const clean = addr.toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
  return (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === 'localhost' ||
    clean === 'localhost.' ||
    clean.startsWith('127.')
  )
}

export function isLanAddress(addr) {
  if (!addr || typeof addr !== 'string') return false
  const clean = addr.toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
  if (isLoopbackAddress(clean)) return true
  if (clean.startsWith('10.') || clean.startsWith('192.168.')) return true
  const m = clean.match(/^172\.(\d+)\./)
  if (m) {
    const octet = parseInt(m[1], 10)
    if (octet >= 16 && octet <= 31) return true
  }
  return false
}

export function isTrustedHost(host) {
  if (!host || typeof host !== 'string') return false
  let hostname = host.trim()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    if (end > 0) hostname = hostname.slice(1, end)
  } else {
    hostname = hostname.split(':')[0]
  }
  hostname = hostname.toLowerCase()
  if (!hostname) return false
  if (hostname === 'localhost' || hostname === 'localhost.' || hostname.endsWith('.local')) return true
  if (isLoopbackAddress(hostname) || isLanAddress(hostname)) return true
  return false
}

export function normalizeIp(addr) {
  if (!addr || typeof addr !== 'string') return ''
  return addr.toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
}

export function cookieNameForAuthority(authority) {
  if (!authority || typeof authority !== 'string') return ''
  const hash = crypto.createHash('sha256').update(authority.trim()).digest('base64url')
  return 'dsh-auth-' + hash
}

export function isLoopbackCookieName(name, host = '') {
  if (!name || typeof name !== 'string' || !name.startsWith('dsh-auth-')) return false
  const authorities = [
    host,
    '127.0.0.1:3000',
    '127.0.0.1:3080',
    '127.0.0.1:3082',
    '127.0.0.1',
    'localhost:3000',
    'localhost:3080',
    'localhost:3082',
    'localhost',
    '[::1]:3000',
    '[::1]',
  ]
  for (const auth of authorities) {
    if (auth && isLoopbackAddress(auth.split(':')[0])) {
      if (cookieNameForAuthority(auth) === name) return true
    }
  }
  return false
}

export function hasClientCredentials(req) {
  if (!req || !req.headers) return false
  if (req.headers.authorization) return true
  if (req.headers['x-dsh-lan-pin']) return true
  const cookie = req.headers.cookie
  if (!cookie || typeof cookie !== 'string') return false
  if (cookie.includes('dsh_token=') || cookie.includes('dsh_lan_pin=')) return true

  const parts = cookie.split(';')
  for (const part of parts) {
    const trimmed = part.trim()
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const name = trimmed.slice(0, eqIdx).trim()
    if (name.startsWith('dsh-auth-')) {
      if (!isLoopbackCookieName(name, req.headers.host)) {
        return true
      }
    }
  }
  return false
}

export function getClientIp(req) {
  const socketAddress =
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    req?.info?.remoteAddress ||
    ''
  const socketIp = normalizeIp(socketAddress)
  const xff = req?.headers?.['x-forwarded-for']
  if (xff && typeof xff === 'string' && (isLoopbackAddress(socketIp) || !socketIp)) {
    const first = xff.split(',')[0].trim()
    if (first) {
      return normalizeIp(first)
    }
  }
  return socketIp
}

/**
 * Cross-site request, DNS rebinding, and authentication validation (#261, #369, #384).
 *
 * Requirements:
 * 1. If DSH connection service is available (options.connection), requestRejection(req)
 *    is the authoritative gate for browser session authentication and trusted network access.
 *    If rejection is returned, the numeric status (e.g. 401 or 403) is returned.
 * 2. Host header is required and must target a trusted host (loopback, LAN, .local).
 * 3. Cross-site requests ('sec-fetch-site: cross-site' or origin mismatch) are rejected with 403.
 * 4. Origin & Referer headers (if present) must match Host or a trusted host.
 * 5. Network boundary validation:
 *    - Loopback callers (127.0.0.1, ::1) are allowed.
 *    - Non-loopback / LAN callers require valid connection authentication (fail-closed, return 401).
 *    - Unknown remote address (socket present but empty remoteAddress) fails closed with 403.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ connection?: { requestRejection?: (req: any) => number | undefined } }} [options]
 * @returns {number|undefined} Rejection HTTP status code (401, 403), or undefined if allowed.
 */
export function getRejectionStatus(req, options = {}) {
  const connection = options?.connection
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        if (typeof rejection === 'number' && Number.isInteger(rejection) && rejection >= 400 && rejection < 600) {
          return rejection
        }
        return rejection === 401 ? 401 : 403
      }
    } catch {
      // Fail closed if connection service throws
      return 403
    }
  }

  if (!req || !req.headers) return 403

  const host = req.headers.host
  if (!host || !isTrustedHost(host)) {
    return 403
  }

  const site = req.headers['sec-fetch-site']

  // 1. Explicit cross-site or same-site requests are rejected
  if (site === 'cross-site' || site === 'same-site') {
    return 403
  }

  // 2. Validate origin against trusted hosts and host header
  const origin = req.headers.origin
  if (origin !== undefined) {
    if (origin === 'null' || !origin) return 403
    try {
      const parsed = new URL(origin)
      if (!isTrustedHost(parsed.hostname)) return 403
      if (parsed.host && parsed.host !== host) return 403
    } catch {
      return 403
    }
  }

  // 3. Validate referer against trusted hosts and host header if present
  const referer = req.headers.referer
  if (referer !== undefined && referer) {
    try {
      const parsedRef = new URL(referer)
      if (!isTrustedHost(parsedRef.hostname)) return 403
      if (parsedRef.host && parsedRef.host !== host) return 403
    } catch {
      return 403
    }
  }

  // 4. Validate remote address and network boundary
  const hasSocket = !!(req.socket || req.connection)
  const remote = getClientIp(req)

  if (hasSocket) {
    if (!remote) {
      return 403
    }
    if (!isLoopbackAddress(remote) && !isLanAddress(remote)) {
      return 403
    }
    // Remote / LAN callers without connection authentication are rejected (#384)
    if (!isLoopbackAddress(remote)) {
      if (!connection) {
        return 401
      }
      // If request was forwarded through a reverse proxy (x-forwarded-for),
      // the proxy may have injected loopback credentials. Validate that the client
      // itself supplied authentic credentials (bearer token, PIN, or client session cookie).
      const xff = req.headers['x-forwarded-for']
      if (xff && !hasClientCredentials(req)) {
        return 401
      }
    }
  } else {
    // Synthetic mock request without socket
    const xff = req.headers['x-forwarded-for']
    if (xff) {
      const first = xff.split(',')[0].trim()
      if (first && !isLoopbackAddress(normalizeIp(first))) {
        if (!connection || !hasClientCredentials(req)) {
          return 401
        }
      }
    } else if (!connection) {
      const hostname = String(host).split(':')[0].toLowerCase()
      if (!isLoopbackAddress(hostname) && hostname !== 'localhost') {
        return 401
      }
    }
  }

  // 5. Browser request with declared site:
  // Must be same-origin or none
  if (site && site !== 'same-origin' && site !== 'none') {
    return 403
  }

  // 6. Request without declared site from non-loopback requires connection
  if (!site && remote && !isLoopbackAddress(remote) && !connection) {
    return 401
  }

  return undefined
}

export function isTrustedRequest(req, options = {}) {
  return getRejectionStatus(req, options) === undefined
}

export function rejectUntrustedRequest(req, res, options = {}) {
  const status = getRejectionStatus(req, options)
  if (status !== undefined) {
    try {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(
        JSON.stringify({
          error: status === 401 ? 'unauthorized' : 'cross-site',
        })
      )
    } catch {
      /* socket closed */
    }
    return true
  }
  return false
}

/** Parse `/dsh-kanban/task/<id>[/<action>]`; returns undefined if non-matching. */
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
function withPlan(task, liveOf, config, now, sameSession) {
  const plan = parsePlan(task.plan)
  // Registry error implies agent unavailable; do not fail whole board render.
  let live
  try {
    if (typeof liveOf === 'function' && task.sessionId) live = liveOf(task.sessionId)
  } catch { live = undefined }
  return {
    ...task,
    plan: { items: planItems(plan), progress: planProgress(plan) },
    state: taskState({ task, live }),
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
export function buildBoard({ store, config, board = 'main', repo, liveOf, sync, projectRoot }) {
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
  }
}

/**
 * Card move transition. WIP limit is advisory: move executes, and exceeded status
 * is returned for UI highlighting.
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
export function canRevive(task, live) {
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
export async function handleCleanupWorktree({
  store, task, workspaceRegistry, force, cleanupTaskWorktree,
  config, repoDir, cwdOf, env,
}) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const out = await cleanupTaskWorktree({
    store,
    task,
    workspaceRegistry,
    force: force === true,
    config,
    repoDir,
    cwdOf,
    env,
  })
  const status = out.status || (out.error ? (out.error === 'unfenced-worktree-path' ? 403 : 500) : 200)
  return { status, body: out }
}

/**
 * Get working copy diff for task.
 */
export async function handleTaskDiff({ task, getTaskDiff, getTaskDiffInspector }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  if (typeof getTaskDiffInspector === 'function') {
    const inspectorResult = await getTaskDiffInspector({ worktreePath: task.worktree })
    return { status: 200, body: inspectorResult }
  }
  const diffResult = await getTaskDiff({ worktreePath: task.worktree })
  return { status: 200, body: diffResult }
}

/**
 * Discard file changes in task worktree (#371).
 */
export async function handleTaskDiscard({ task, file, discardTaskFile }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  if (!file || typeof file !== 'string') return { status: 400, body: { error: 'file-required' } }
  if (!task.worktree) return { status: 400, body: { error: 'no-worktree' } }
  const result = await discardTaskFile({ worktreePath: task.worktree, file })
  return { status: result.success ? 200 : 400, body: result }
}

/**
 * Get commit list for task.
 */
export async function handleTaskCommits({ task, getTaskCommits }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const commits = await getTaskCommits({ worktreePath: task.worktree })
  return { status: 200, body: { commits } }
}

/**
 * Merge task worktree branch and transition to done.
 */
export async function handleTaskMerge({ store, task, targetBranch, workspaceRegistry, mergeTaskWorktree }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const mergeResult = await mergeTaskWorktree({
    task,
    targetBranch: typeof targetBranch === 'string' ? targetBranch.trim() : undefined,
    workspaceRegistry,
  })
  if (!mergeResult.success) {
    return {
      status: 400,
      body: { error: mergeResult.error, detail: mergeResult.detail, files: mergeResult.files },
    }
  }
  const updated = store.acceptTask(task.id)
  store.addTransition({
    taskId: task.id,
    fromCol: task.column,
    toCol: 'done',
    source: 'manual',
    detail: `accepted and merged branch ${task.branch} into ${mergeResult.targetBranch}`,
  })
  return { status: 200, body: { task: updated, merged: true, targetBranch: mergeResult.targetBranch } }
}

/**
 * Check task worktree status (branch, dirty files, workspace).
 */
export async function handleTaskWorktreeStatus({ task, checkWorktreeDirty }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const dirtyCheck = await checkWorktreeDirty({ worktreePath: task.worktree })
  return {
    status: 200,
    body: {
      worktree: task.worktree || '',
      branch: task.branch || '',
      workspaceId: task.workspaceId || '',
      dirty: dirtyCheck.dirty,
      files: dirtyCheck.files,
    },
  }
}

/**
 * Update Definition of Done checklist for task.
 */
export function handleTaskChecklist({ store, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const list = Array.isArray(input?.checklist) ? input.checklist : Array.isArray(input) ? input : []
  const updated = store.updateChecklist(task.id, list)
  return { status: 200, body: { task: updated } }
}

/**
 * Set completion report for task.
 */
export function handleTaskReport({ store, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const updated = store.setReport(task.id, input)
  return { status: 200, body: { task: updated } }
}

/**
 * Get comments for task.
 */
export function handleGetTaskComments({ task }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  return { status: 200, body: { comments: task.comments || [] } }
}

/**
 * Add comment to task.
 */
export function handleAddTaskComment({ store, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const author = input?.author || 'user'
  const role = input?.role || 'user'
  const text = input?.text || ''
  const updated = store.addComment(task.id, { author, role, text })
  return { status: 200, body: { task: updated } }
}

/**
 * Accept task review (transition to done).
 */
export function handleAcceptTask({ store, task }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const updated = store.acceptTask(task.id)
  return { status: 200, body: { task: updated } }
}

/**
 * Reject task review (return to in_progress).
 */
export function handleRejectTask({ store, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const reason = String(input?.reason || '').trim()
  if (!reason) return { status: 400, body: { error: 'reason-required' } }
  const updated = store.rejectTask(task.id, reason)
  return { status: 200, body: { task: updated } }
}

/**
 * Save task progress dump snapshot.
 */
export function handleProgressDump({ store, task, input, formatProgressDump }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const formatted = typeof input === 'string' ? input : formatProgressDump(input)
  const updated = store.updateTask(task.id, { progressDump: formatted })
  return { status: 200, body: { task: updated } }
}

/**
 * Decompose a task into subtasks and make the parent an Epic.
 */
export async function handleTriageTask({ store, gitea, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const subtasksInput = Array.isArray(input?.subtasks) ? input.subtasks : []
  if (subtasksInput.length === 0) {
    return { status: 400, body: { error: 'subtasks-required' } }
  }
  const createGitea = input?.createGiteaIssues === true && Boolean(task.owner && task.repo && gitea)

  // Convert parent into Epic
  store.updateTask(task.id, { isEpic: true })

  const created = []
  for (const item of subtasksInput) {
    const title = String(item?.title ?? '').trim()
    if (!title) continue
    const body = String(item?.body ?? '').trim()
    let issueNumber = null
    let issueUrl = null

    if (createGitea) {
      try {
        const issueBody = body ? `${body}\n\nParent epic: #${task.issueNumber || task.id}` : `Parent epic: #${task.issueNumber || task.id}`
        const giteaIssue = await gitea.createIssue({
          owner: task.owner,
          repo: task.repo,
          title,
          body: issueBody,
        })
        if (giteaIssue?.number) {
          issueNumber = giteaIssue.number
          issueUrl = giteaIssue.html_url || null
        }
      } catch { /* ignore gitea subtask creation failure */ }
    }

    const sub = store.createTask({
      board: task.board || 'main',
      column: 'backlog',
      title,
      body,
      parentId: task.id,
      owner: task.owner || null,
      repo: task.repo || null,
      issueNumber,
      issueUrl,
      labels: Array.isArray(item?.labels) ? item.labels : [],
      workspaceId: task.workspaceId || '',
    })
    created.push(sub)
  }

  store.addTransition({
    taskId: task.id,
    fromCol: task.column,
    toCol: task.column,
    source: 'manual',
    detail: `decomposed into ${created.length} subtasks (epic triage)`,
  })

  return {
    status: 200,
    body: {
      epic: store.getTask(task.id),
      subtasks: store.listSubtasks(task.id),
      counts: store.countSubtasks(task.id),
      createdCount: created.length,
    },
  }
}

/**
 * Get subtasks of a task.
 */
export function handleGetSubtasks({ store, task }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  return {
    status: 200,
    body: {
      subtasks: store.listSubtasks(task.id),
      counts: store.countSubtasks(task.id),
    },
  }
}

/**
 * Create a single subtask linked to a parent task.
 */
export async function handleCreateSubtask({ store, gitea, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const title = String(input?.title ?? '').trim()
  if (!title) return { status: 400, body: { error: 'title-required' } }
  const body = String(input?.body ?? '').trim()
  let issueNumber = null
  let issueUrl = null

  if (input?.createGiteaIssue === true && task.owner && task.repo && gitea) {
    try {
      const issueBody = body ? `${body}\n\nParent epic: #${task.issueNumber || task.id}` : `Parent epic: #${task.issueNumber || task.id}`
      const giteaIssue = await gitea.createIssue({
        owner: task.owner,
        repo: task.repo,
        title,
        body: issueBody,
      })
      if (giteaIssue?.number) {
        issueNumber = giteaIssue.number
        issueUrl = giteaIssue.html_url || null
      }
    } catch { /* ignore gitea subtask creation failure */ }
  }

  store.updateTask(task.id, { isEpic: true })
  const sub = store.createTask({
    board: task.board || 'main',
    column: input?.column || 'backlog',
    title,
    body,
    parentId: task.id,
    owner: task.owner || null,
    repo: task.repo || null,
    issueNumber,
    issueUrl,
    labels: Array.isArray(input?.labels) ? input.labels : [],
    workspaceId: task.workspaceId || '',
  })
  return { status: 200, body: { subtask: sub, counts: store.countSubtasks(task.id) } }
}

/**
 * Toggle a checklist item atomically by index or text.
 */
export function handleToggleChecklistItem({ store, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const current = Array.isArray(task.checklist) ? [...task.checklist] : []
  let targetIndex = -1

  if (typeof input?.index === 'number' && input.index >= 0 && input.index < current.length) {
    targetIndex = input.index
  } else if (typeof input?.text === 'string' && input.text.trim()) {
    const q = input.text.trim().toLowerCase()
    targetIndex = current.findIndex((item) => {
      const t = typeof item === 'string' ? item : item?.text
      return typeof t === 'string' && t.toLowerCase().includes(q)
    })
  }

  if (targetIndex === -1) {
    return { status: 404, body: { error: 'checklist-item-not-found' } }
  }

  const item = current[targetIndex]
  let updatedItem
  if (typeof item === 'string') {
    const checked = input?.checked !== undefined ? Boolean(input.checked) : true
    updatedItem = { text: item, completed: checked, done: checked }
  } else {
    const isCurrentlyDone = item.completed !== undefined ? Boolean(item.completed) : Boolean(item.done)
    const checked = input?.checked !== undefined ? Boolean(input.checked) : !isCurrentlyDone
    updatedItem = { ...item, completed: checked, done: checked }
  }
  current[targetIndex] = updatedItem
  const updated = store.updateChecklist(task.id, current)
  return { status: 200, body: { task: updated, item: updatedItem, index: targetIndex } }
}

/**
 * Create a Gitea Pull Request for a task.
 */
export async function handleCreateTaskPr({ store, gitea, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  if (!task.owner || !task.repo) {
    return { status: 400, body: { error: 'task-no-repo' } }
  }
  const head = String(input?.head || task.branch || '').trim()
  if (!head) return { status: 400, body: { error: 'branch-required' } }
  const base = String(input?.base || 'main').trim()
  const title = String(input?.title || task.title || `PR: ${task.title}`).trim()
  const body = String(input?.body || (task.issueNumber ? `Closes #${task.issueNumber}` : '')).trim()

  try {
    const pr = await gitea.createPullRequest({
      owner: task.owner,
      repo: task.repo,
      title,
      body,
      head,
      base,
    })
    store.addTransition({
      taskId: task.id,
      fromCol: task.column,
      toCol: task.column,
      source: 'manual',
      detail: `Created PR #${pr?.number || ''}: ${head} -> ${base}`,
    })
    return { status: 200, body: { pr, prUrl: pr?.html_url } }
  } catch (err) {
    return { status: 502, body: { error: 'gitea-pr-failed', detail: err?.message } }
  }
}
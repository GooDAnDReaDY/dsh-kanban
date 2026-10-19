// Board task storage.
//
// Kanban maintains its own fields and history not tracked in Gitea: session,
// model, transition log, and card ordering. Tasks therefore persist here in SQLite.
//
// Column is named `col` in the schema because `column` is a reserved SQL keyword.
// Externally, the field remains named `column`.
//
// Fields `branch` and `worktree` are observed from issues and Gitea events rather
// than driven locally: this plugin does not create branches.

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, copyFileSync, readdirSync, unlinkSync, statSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { keyBetween, generateNKeysBetween, isValidOrderKey } from './order.js'
import { DEFAULT_BOARDS, normalizeKind } from './config.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'project',
  position  TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  board        TEXT NOT NULL,
  col          TEXT NOT NULL,
  position     TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  owner        TEXT,
  repo         TEXT,
  issueNumber  INTEGER,
  issueUrl     TEXT,
  externalRef  TEXT,
  labels       TEXT NOT NULL DEFAULT '[]',
  branch       TEXT,
  worktree     TEXT,
  workspaceId           TEXT NOT NULL DEFAULT '',
  cron                  TEXT NOT NULL DEFAULT '',
  nextRunAt             INTEGER NOT NULL DEFAULT 0,
  lastRunAt             INTEGER NOT NULL DEFAULT 0,
  progressDump          TEXT NOT NULL DEFAULT '',
  permission            TEXT NOT NULL DEFAULT '',
  permissionConfirmedAt INTEGER NOT NULL DEFAULT 0,
  runs                  TEXT NOT NULL DEFAULT '[]',
  reasoningEffort       TEXT NOT NULL DEFAULT '',
  sessionId    TEXT,
  model        TEXT,
  provider     TEXT,
  waiting      INTEGER NOT NULL DEFAULT 0,
  plan         TEXT NOT NULL DEFAULT '',
  columnAt     INTEGER NOT NULL DEFAULT 0,
  archivedAt   INTEGER NOT NULL DEFAULT 0,
  queuedAt     INTEGER NOT NULL DEFAULT 0,
  labelColors  TEXT NOT NULL DEFAULT '{}',
  author       TEXT NOT NULL DEFAULT '',
  assignee     TEXT NOT NULL DEFAULT '',
  milestone    TEXT NOT NULL DEFAULT '',
  priority     TEXT NOT NULL DEFAULT '',
  dueAt        INTEGER NOT NULL DEFAULT 0,
  syncedAt     INTEGER NOT NULL DEFAULT 0,
  createdAt    INTEGER NOT NULL,
  checklist             TEXT NOT NULL DEFAULT '[]',
  report                TEXT NOT NULL DEFAULT '{}',
  comments              TEXT NOT NULL DEFAULT '[]',
  rejectReason          TEXT NOT NULL DEFAULT '',
  rejectedAt            INTEGER NOT NULL DEFAULT 0,
  parentId              TEXT NOT NULL DEFAULT '',
  isEpic                INTEGER NOT NULL DEFAULT 0,
  workflowRunId         TEXT NOT NULL DEFAULT '',
  workflowStatus        TEXT NOT NULL DEFAULT '',
  forge                 TEXT NOT NULL DEFAULT '',
  permissionConfirmedTier TEXT NOT NULL DEFAULT '',
  queuedRequest         TEXT NOT NULL DEFAULT '',
  updatedAt    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_board_col ON tasks(board, col, position);
CREATE INDEX IF NOT EXISTS tasks_session ON tasks(sessionId);
CREATE TABLE IF NOT EXISTS transitions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId  TEXT NOT NULL,
  fromCol TEXT,
  toCol   TEXT NOT NULL,
  source  TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT '',
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transitions_task ON transitions(taskId, at);
CREATE TABLE IF NOT EXISTS dismissed (
  owner       TEXT NOT NULL,
  repo        TEXT NOT NULL,
  issueNumber INTEGER NOT NULL,
  forge       TEXT NOT NULL DEFAULT '',
  at          INTEGER NOT NULL,
  PRIMARY KEY (owner, repo, issueNumber, forge)
);
`

/** Task fields allowed to be modified via updateTask. */
const WRITABLE = [
  'title', 'body', 'owner', 'repo', 'issueNumber', 'issueUrl', 'externalRef', 'labels',
  'branch', 'worktree', 'workspaceId', 'sessionId', 'model', 'provider', 'waiting', 'syncedAt', 'plan',
  'labelColors', 'queuedAt', 'createdAt', 'author', 'assignee', 'milestone', 'priority', 'dueAt',
  'cron', 'nextRunAt', 'lastRunAt', 'progressDump', 'permission', 'reasoningEffort', 'permissionConfirmedAt',
  'runs', 'checklist', 'report', 'comments', 'rejectReason', 'rejectedAt', 'parentId', 'isEpic',
  'workflowRunId', 'workflowStatus', 'permissionConfirmedTier', 'forge', 'queuedRequest',
  'verificationCommand', 'verificationStatus',
]

/** Valid transition sources; unexpected values are rejected to preserve log integrity. */
const SOURCES = new Set(['manual', 'session', 'gitea', 'github', 'tool', 'workflow'])

function rowToTask(row) {
  if (row === undefined) return undefined
  const { col, labels, waiting, labelColors, runs, checklist, report, comments, rejectReason, rejectedAt, isEpic, parentId, ...rest } = row
  let parsedChecklist = []
  try {
    const value = JSON.parse(checklist ?? '[]')
    if (Array.isArray(value)) parsedChecklist = value
  } catch { /* ignore malformed json */ }
  let parsedReport = {}
  try {
    const value = JSON.parse(report ?? '{}')
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsedReport = value
  } catch { /* ignore malformed json */ }
  let parsedComments = []
  try {
    const value = JSON.parse(comments ?? '[]')
    if (Array.isArray(value)) parsedComments = value
  } catch { /* ignore malformed json */ }
  let parsed = []
  try {
    const value = JSON.parse(labels)
    if (Array.isArray(value)) parsed = value.filter((l) => typeof l === 'string')
  } catch { /* corrupted field must not fail board read */ }
  let colors = {}
  try {
    const value = JSON.parse(labelColors ?? '{}')
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) colors = value
  } catch { /* corrupted field must not fail board read */ }
  let parsedRuns = []
  try {
    const value = JSON.parse(runs ?? '[]')
    if (Array.isArray(value)) parsedRuns = value
  } catch { /* corrupted field must not fail board read */ }
  return {
    ...rest,
    column: col,
    labels: parsed,
    labelColors: colors,
    waiting: waiting === 1,
    runs: parsedRuns,
    checklist: parsedChecklist,
    report: parsedReport,
    comments: parsedComments,
    rejectReason: rejectReason ?? '',
    rejectedAt: Number(rejectedAt) || 0,
    reasoningEffort: rest.reasoningEffort ?? '',
    isEpic: isEpic === 1,
    parentId: parentId ?? '',
  }
}

/**
 * Ensure secure file permissions for the storage directory and database files.
 * Directory and backups subdirectory: 0700 (rwx------)
 * Database, WAL, SHM, and backup files: 0600 (rw-------)
 *
 * @param {string} dir storage directory path
 */
export function secureStorePermissions(dir) {
  try {
    if (existsSync(dir)) {
      try { chmodSync(dir, 0o700) } catch { /* best-effort chmod on dir */ }
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isFile()) {
          try { chmodSync(fullPath, 0o600) } catch { /* best-effort chmod on file */ }
        } else if (entry.isDirectory() && entry.name === 'backups') {
          try { chmodSync(fullPath, 0o700) } catch { /* best-effort chmod on backups dir */ }
          try {
            const backupFiles = readdirSync(fullPath, { withFileTypes: true })
            for (const bFile of backupFiles) {
              if (bFile.isFile()) {
                try { chmodSync(join(fullPath, bFile.name), 0o600) } catch { /* best-effort chmod on backup file */ }
              }
            }
          } catch { /* ignore readdir error on backups */ }
        }
      }
    }
  } catch {
    /* best-effort permission hardening */
  }
}

/**
 * Open task database storage.
 * @param {{dir: string}} options directory holding the database file
 * @returns {object} storage interface
 */
export function openStore({ dir }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  secureStorePermissions(dir)
  const db = new DatabaseSync(join(dir, 'kanban.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  // Database might have been created by an older version. Add missing columns
  // individually: duplicate ALTER TABLE errors are safely caught and ignored.
  for (const [column, definition] of [
    ['waiting', 'INTEGER NOT NULL DEFAULT 0'],
    ['syncedAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['plan', "TEXT NOT NULL DEFAULT ''"],
    ['columnAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['archivedAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['queuedAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['labelColors', "TEXT NOT NULL DEFAULT '{}'"],
    ['reasoningEffort', "TEXT NOT NULL DEFAULT ''"],
    ['author', "TEXT NOT NULL DEFAULT ''"],
    ['assignee', "TEXT NOT NULL DEFAULT ''"],
    ['milestone', "TEXT NOT NULL DEFAULT ''"],
    ['priority', "TEXT NOT NULL DEFAULT ''"],
    ['dueAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['workspaceId', "TEXT NOT NULL DEFAULT ''"],
    ['cron', "TEXT NOT NULL DEFAULT ''"],
    ['nextRunAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['lastRunAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['progressDump', "TEXT NOT NULL DEFAULT ''"],
    ['permission', "TEXT NOT NULL DEFAULT ''"],
    ['permissionConfirmedAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['runs', "TEXT NOT NULL DEFAULT '[]'"],
    ['checklist', "TEXT NOT NULL DEFAULT '[]'"],
    ['report', "TEXT NOT NULL DEFAULT '{}'"],
    ['comments', "TEXT NOT NULL DEFAULT '[]'"],
    ['rejectReason', "TEXT NOT NULL DEFAULT ''"],
    ['rejectedAt', "INTEGER NOT NULL DEFAULT 0"],
    ['parentId', "TEXT NOT NULL DEFAULT ''"],
    ['isEpic', "INTEGER NOT NULL DEFAULT 0"],
    ['externalRef', "TEXT"],
    ['provider', "TEXT NOT NULL DEFAULT 'gitea'"],
    ['workflowRunId', "TEXT NOT NULL DEFAULT ''"],
    ['workflowStatus', "TEXT NOT NULL DEFAULT ''"],
    ['forge', "TEXT NOT NULL DEFAULT ''"],
    ['permissionConfirmedTier', "TEXT NOT NULL DEFAULT ''"],
    ['queuedRequest', "TEXT NOT NULL DEFAULT ''"],
    ['verificationCommand', "TEXT NOT NULL DEFAULT ''"],
    ['verificationStatus', "TEXT NOT NULL DEFAULT ''"],
  ]) {
    try { db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`) } catch { /* column already exists */ }
  }
  try { db.exec("ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'") } catch { /* already exists */ }
  // Older cards lack column entry timestamps; default to creation timestamp.
  db.exec('UPDATE tasks SET columnAt = createdAt WHERE columnAt = 0')

  // Indexes for active tasks, Gitea issue lookups, and cron jobs.
  db.exec('CREATE INDEX IF NOT EXISTS tasks_board_active ON tasks(board, archivedAt, col, position)')
  db.exec('CREATE INDEX IF NOT EXISTS tasks_gitea_issue ON tasks(owner, repo, issueNumber)')
  db.exec('CREATE INDEX IF NOT EXISTS tasks_external_ref ON tasks(externalRef)')
  db.exec('CREATE INDEX IF NOT EXISTS tasks_cron_next ON tasks(archivedAt, nextRunAt)')
  db.exec('CREATE INDEX IF NOT EXISTS tasks_queued ON tasks(archivedAt, queuedAt)')
  db.exec('CREATE INDEX IF NOT EXISTS tasks_parent_id ON tasks(parentId)')
  db.exec('CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updatedAt)')
  db.exec('CREATE INDEX IF NOT EXISTS tasks_archivable ON tasks(archivedAt, col, columnAt)')
  try { db.exec("ALTER TABLE dismissed ADD COLUMN forge TEXT NOT NULL DEFAULT ''") } catch { /* already exists */ }
  db.exec("CREATE INDEX IF NOT EXISTS tasks_forge_issue ON tasks(forge, owner, repo, issueNumber)")
  db.exec("UPDATE tasks SET forge = 'github' WHERE (forge = '' OR forge IS NULL) AND issueUrl LIKE '%github.com%'")
  db.exec("UPDATE tasks SET forge = 'gitea' WHERE (forge = '' OR forge IS NULL) AND (issueUrl NOT LIKE '%github.com%' OR issueUrl IS NULL)")
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, val TEXT)")

  // Fractional indexing migration (#345): ensure all existing tasks have compact keys
  const orderMigrated = db.prepare("SELECT val FROM meta WHERE key = 'fractional_indexing_migrated'").get()
  if (!orderMigrated) {
    try {
      db.exec('BEGIN TRANSACTION')
      const groups = db.prepare('SELECT DISTINCT board, col FROM tasks').all()
      const getTasksInCol = db.prepare('SELECT id, position FROM tasks WHERE board = ? AND col = ? ORDER BY position ASC, createdAt ASC')
      const updatePos = db.prepare('UPDATE tasks SET position = ? WHERE id = ?')
      for (const group of groups) {
        const rows = getTasksInCol.all(group.board, group.col)
        if (rows.length > 0) {
          const newKeys = generateNKeysBetween(null, null, rows.length)
          for (let i = 0; i < rows.length; i++) {
            updatePos.run(newKeys[i], rows[i].id)
          }
        }
      }
      const boardRows = db.prepare('SELECT id, position FROM boards ORDER BY position ASC, id ASC').all()
      if (boardRows.length > 0) {
        const updateBoardPos = db.prepare('UPDATE boards SET position = ? WHERE id = ?')
        const newBoardKeys = generateNKeysBetween(null, null, boardRows.length)
        for (let i = 0; i < boardRows.length; i++) {
          updateBoardPos.run(newBoardKeys[i], boardRows[i].id)
        }
      }
      db.prepare("INSERT OR REPLACE INTO meta (key, val) VALUES ('fractional_indexing_migrated', '1')").run()
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
    }
  }
  // Ensure board order keys are valid, even if fractional_indexing_migrated marker already exists (#345)
  const boardRows = db.prepare('SELECT id, position FROM boards ORDER BY position ASC, id ASC').all()
  if (boardRows.length > 0 && boardRows.some((b) => !isValidOrderKey(b.position))) {
    try {
      db.exec('BEGIN TRANSACTION')
      const updateBoardPos = db.prepare('UPDATE boards SET position = ? WHERE id = ?')
      const newBoardKeys = generateNKeysBetween(null, null, boardRows.length)
      for (let i = 0; i < boardRows.length; i++) {
        updateBoardPos.run(newBoardKeys[i], boardRows[i].id)
      }
      db.exec('COMMIT')
    } catch {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
    }
  }
  db.exec('PRAGMA synchronous = NORMAL')
  try { db.exec('PRAGMA optimize') } catch { /* pragma optimize best-effort */ }

  // Enforce secure permissions on newly created or modified DB/WAL/SHM files.
  secureStorePermissions(dir)

  const q = {
    boards: db.prepare('SELECT * FROM boards ORDER BY position'),
    insertTask: db.prepare(`INSERT INTO tasks
      (id, board, col, position, title, body, owner, repo, issueNumber, issueUrl, externalRef,
       labels, branch, worktree, workspaceId, sessionId, model, provider, waiting, syncedAt,
       labelColors, author, assignee, milestone, priority, dueAt, columnAt, createdAt, updatedAt,
       cron, nextRunAt, lastRunAt, progressDump, permission, permissionConfirmedAt, runs,
       checklist, report, comments, rejectReason, rejectedAt, reasoningEffort, parentId, isEpic,
       workflowRunId, workflowStatus, forge, queuedRequest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    restoreTask: db.prepare(`INSERT INTO tasks
      (id, board, col, position, title, body, owner, repo, issueNumber, issueUrl, externalRef,
       labels, branch, worktree, workspaceId, sessionId, model, provider, waiting, syncedAt,
       labelColors, author, assignee, milestone, priority, dueAt, columnAt, createdAt, updatedAt,
       cron, nextRunAt, lastRunAt, progressDump, permission, permissionConfirmedAt, permissionConfirmedTier, runs,
       checklist, report, comments, rejectReason, rejectedAt, reasoningEffort, parentId, isEpic,
       workflowRunId, workflowStatus, archivedAt, queuedAt, plan, forge, queuedRequest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        board=excluded.board, col=excluded.col, position=excluded.position, title=excluded.title,
        body=excluded.body, owner=excluded.owner, repo=excluded.repo, issueNumber=excluded.issueNumber,
        issueUrl=excluded.issueUrl, externalRef=excluded.externalRef, labels=excluded.labels,
        branch=excluded.branch, worktree=excluded.worktree, workspaceId=excluded.workspaceId,
        sessionId=excluded.sessionId, model=excluded.model, provider=excluded.provider,
        waiting=excluded.waiting, syncedAt=excluded.syncedAt, labelColors=excluded.labelColors,
        author=excluded.author, assignee=excluded.assignee, milestone=excluded.milestone,
        priority=excluded.priority, dueAt=excluded.dueAt, columnAt=excluded.columnAt,
        createdAt=excluded.createdAt, updatedAt=excluded.updatedAt, cron=excluded.cron,
        nextRunAt=excluded.nextRunAt, lastRunAt=excluded.lastRunAt, progressDump=excluded.progressDump,
        permission=excluded.permission, permissionConfirmedAt=excluded.permissionConfirmedAt,
        permissionConfirmedTier=excluded.permissionConfirmedTier, runs=excluded.runs,
        checklist=excluded.checklist, report=excluded.report, comments=excluded.comments,
        rejectReason=excluded.rejectReason, rejectedAt=excluded.rejectedAt,
        reasoningEffort=excluded.reasoningEffort, parentId=excluded.parentId, isEpic=excluded.isEpic,
        workflowRunId=excluded.workflowRunId, workflowStatus=excluded.workflowStatus,
        archivedAt=excluded.archivedAt, queuedAt=excluded.queuedAt, plan=excluded.plan, forge=excluded.forge,
        queuedRequest=excluded.queuedRequest`),
    restoreTransition: db.prepare(`INSERT INTO transitions
      (taskId, fromCol, toCol, source, detail, at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    boardById: db.prepare('SELECT * FROM boards WHERE id = ?'),
    insertBoard: db.prepare('INSERT INTO boards (id, title, kind, position, createdAt) VALUES (?, ?, ?, ?, ?)'),
    lastBoard: db.prepare('SELECT position FROM boards ORDER BY position DESC LIMIT 1'),
    taskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    allTasks: db.prepare('SELECT * FROM tasks ORDER BY board, col, position'),
    allTransitions: db.prepare('SELECT * FROM transitions ORDER BY id'),
    tasksByBoard: db.prepare('SELECT * FROM tasks WHERE board = ? AND archivedAt = 0 ORDER BY col, position'),
    archived: db.prepare('SELECT * FROM tasks WHERE archivedAt > 0 ORDER BY archivedAt DESC'),
    archivable: db.prepare(
      "SELECT * FROM tasks WHERE archivedAt = 0 AND col = 'done' AND columnAt > 0 AND columnAt <= ?"),
    dismiss: db.prepare('INSERT OR REPLACE INTO dismissed (owner, repo, issueNumber, forge, at) VALUES (?, ?, ?, ?, ?)'),
    isDismissed: db.prepare('SELECT 1 FROM dismissed WHERE owner = ? AND repo = ? AND issueNumber = ?'),
    isDismissedWithForge: db.prepare(`SELECT 1 FROM dismissed WHERE owner = ? AND repo = ? AND issueNumber = ? AND (forge = ? OR (forge = '' AND ? = 'gitea'))`),
    byIssue: db.prepare('SELECT * FROM tasks WHERE owner = ? AND repo = ? AND issueNumber = ?'),
    byIssueWithForge: db.prepare(`SELECT * FROM tasks WHERE owner = ? AND repo = ? AND issueNumber = ? AND (forge = ? OR (forge = '' AND ? = 'gitea'))`),
    byExternalRef: db.prepare('SELECT * FROM tasks WHERE externalRef = ? ORDER BY createdAt ASC LIMIT 1'),
    tasksBySession: db.prepare('SELECT * FROM tasks WHERE sessionId = ? LIMIT 1'),
    lastInColumn: db.prepare('SELECT position FROM tasks WHERE board = ? AND col = ? ORDER BY position DESC LIMIT 1'),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
    insertTransition: db.prepare('INSERT INTO transitions (taskId, fromCol, toCol, source, detail, at) VALUES (?, ?, ?, ?, ?, ?)'),
    transitionsOf: db.prepare('SELECT * FROM transitions WHERE taskId = ? ORDER BY at, id'),
    countInColumn: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE board = ? AND col = ?'),
    watchable: db.prepare(
      "SELECT * FROM tasks WHERE issueNumber IS NOT NULL AND col NOT IN ('done') ORDER BY updatedAt DESC"),
    scheduledDue: db.prepare(
      "SELECT * FROM tasks WHERE cron != '' AND nextRunAt > 0 AND nextRunAt <= ? AND archivedAt = 0 ORDER BY nextRunAt ASC"),
    subtasksOf: db.prepare('SELECT * FROM tasks WHERE parentId = ? AND archivedAt = 0 ORDER BY createdAt ASC, position ASC'),
    countSubtasks: db.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN col = 'done' THEN 1 ELSE 0 END) AS completed FROM tasks WHERE parentId = ? AND archivedAt = 0"),
  }

  function ensureBoard(id, title, kind, position, createdAt) {
    const found = q.boardById.get(id)
    if (found !== undefined) {
      if (position !== undefined || createdAt !== undefined || title !== undefined || kind !== undefined) {
        db.prepare('UPDATE boards SET title = ?, kind = ?, position = ?, createdAt = ? WHERE id = ?')
          .run(title ?? found.title, normalizeKind(kind ?? found.kind), position ?? found.position, createdAt ?? found.createdAt, id)
      }
      return q.boardById.get(id)
    }
    const last = q.lastBoard.get()
    const pos = isValidOrderKey(position) ? position : keyBetween(last?.position, undefined)
    const created = typeof createdAt === 'number' && createdAt > 0 ? createdAt : Date.now()
    q.insertBoard.run(id, title, normalizeKind(kind), pos, created)
    return q.boardById.get(id)
  }

  // Initialize default boards so an empty store does not render as broken.
  // The original 'main' board becomes project-kind rather than creating a duplicate.
  for (const board of DEFAULT_BOARDS) ensureBoard(board.id, board.title, board.kind)
  // Rename legacy default title to English if it was untouched.
  db.prepare("UPDATE boards SET title = ? WHERE id = 'main' AND (title = 'Main board' OR title = '\u041e\u0441\u043d\u043e\u0432\u043d\u0430\u044f \u0434\u043e\u0441\u043a\u0430')")
    .run(DEFAULT_BOARDS[0].title)

  function positionFor(board, column, beforeId, afterId) {
    const before = beforeId ? q.taskById.get(beforeId) : undefined
    const after = afterId ? q.taskById.get(afterId) : undefined
    if (before === undefined && after === undefined) {
      return keyBetween(q.lastInColumn.get(board, column)?.position, undefined)
    }
    return keyBetween(after?.position, before?.position)
  }

  return {
    withTransaction(fn) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const res = fn()
        db.exec('COMMIT')
        return res
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },

    backupDatabase() {
      const backupsDir = join(dir, 'backups')
      mkdirSync(backupsDir, { recursive: true, mode: 0o700 })
      try { chmodSync(backupsDir, 0o700) } catch { /* ignore */ }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupName = `kanban-backup-${stamp}.db`
      const dest = join(backupsDir, backupName)
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch { /* wal checkpoint may not be strictly required */ }
      copyFileSync(join(dir, 'kanban.db'), dest)
      try { chmodSync(dest, 0o600) } catch { /* ignore */ }

      // Rotation: retain only the 10 most recent backups.
      try {
        const files = readdirSync(backupsDir)
          .filter((f) => f.startsWith('kanban-backup-') && f.endsWith('.db'))
          .map((f) => ({ name: f, path: join(backupsDir, f), time: statSync(join(backupsDir, f)).mtimeMs }))
          .sort((a, b) => b.time - a.time)
        if (files.length > 10) {
          for (const old of files.slice(10)) {
            try { unlinkSync(old.path) } catch { /* unlink old backup best-effort */ }
          }
        }
      } catch { /* backup rotation best-effort */ }
      return { backup: backupName, path: dest }
    },

    listQueuedTasks() {
      const rows = db.prepare('SELECT * FROM tasks WHERE queuedAt > 0 AND archivedAt = 0 ORDER BY queuedAt ASC').all()
      return rows.map(rowToTask)
    },

    listBoards() {
      return q.boards.all()
    },

    createBoard({ id, title, kind, position, createdAt }) {
      return ensureBoard(id, title ?? id, kind, position, createdAt)
    },

    /** Board kind. Unrecognized kinds default to 'project'. */
    boardKind(id) {
      return normalizeKind(q.boardById.get(id)?.kind)
    },

    listTasks({ board = 'main', repo } = {}) {
      const rows = q.tasksByBoard.all(board).map(rowToTask)
      return repo ? rows.filter((t) => t.repo === repo) : rows
    },

    getTask(id) {
      return rowToTask(q.taskById.get(id))
    },

    /** Active tasks linked to a Gitea issue currently in progress. */
    listWatchable() {
      return q.watchable.all().map(rowToTask)
    },

    /**
     * All tasks belonging to a session, ordered by queue time.
     *
     * A single session can manage a batch of tasks, so tools must distinguish
     * single-task from batch workflows.
     */
    listTasksBySession(sessionId) {
      if (!sessionId) return []
      return db.prepare(
        'SELECT * FROM tasks WHERE sessionId = ? AND archivedAt = 0 ORDER BY queuedAt, col, position')
        .all(sessionId).map(rowToTask)
    },

    findTaskBySession(sessionId) {
      if (!sessionId) return undefined
      return rowToTask(q.tasksBySession.get(sessionId))
    },

    countInColumn(board, column) {
      return q.countInColumn.get(board, column).n
    },

    createTask(input) {
      const now = Date.now()
      // Card creation timestamp reflects when the issue was created in Gitea.
      // columnAt reflects when it entered the column.
      const born = Number(input.createdAt) || now
      const board = input.board ?? 'main'
      const column = input.column ?? 'backlog'
      // Import restores existing task ID; new creation generates a random UUID.
      const id = typeof input.id === 'string' && input.id !== '' ? input.id : randomUUID()
      const position = positionFor(board, column, input.beforeId, input.afterId)
      q.insertTask.run(
        id, board, column, position,
        input.title ?? '', input.body ?? '',
        input.owner ?? null, input.repo ?? null,
        input.issueNumber ?? null, input.issueUrl ?? null, input.externalRef ?? null,
        JSON.stringify(input.labels ?? []),
        input.branch ?? null, input.worktree ?? null, input.workspaceId ?? '',
        input.sessionId ?? null, input.model ?? null, input.provider ?? null,
        input.waiting ? 1 : 0,
        Number(input.syncedAt) || 0,
        JSON.stringify(input.labelColors ?? {}),
        input.author ?? '',
        input.assignee ?? '',
        input.milestone ?? '',
        input.priority ?? '',
        Number(input.dueAt) || 0,
        now, born, now,
        input.cron ?? '',
        Number(input.nextRunAt) || 0,
        Number(input.lastRunAt) || 0,
        input.progressDump ?? '',
        input.permission ?? '',
        Number(input.permissionConfirmedAt) || 0,
        typeof input.runs === 'string' ? input.runs : JSON.stringify(input.runs ?? []),
        typeof input.checklist === 'string' ? input.checklist : JSON.stringify(input.checklist ?? []),
        typeof input.report === 'string' ? input.report : JSON.stringify(input.report ?? {}),
        typeof input.comments === 'string' ? input.comments : JSON.stringify(input.comments ?? []),
        input.rejectReason ?? '',
        Number(input.rejectedAt) || 0,
        typeof input.reasoningEffort === 'string' ? input.reasoningEffort : '',
        input.parentId ?? '',
        input.isEpic ? 1 : 0,
        input.workflowRunId ?? '',
        input.workflowStatus ?? '',
        input.forge ?? '',
        input.queuedRequest ?? '',
      )
      return rowToTask(q.taskById.get(id))
    },

    updateTask(id, patch) {
      const current = q.taskById.get(id)
      if (current === undefined) throw new Error(`task ${id} not found`)
      const fields = []
      const values = []
      for (const key of WRITABLE) {
        if (!Object.hasOwn(patch, key)) continue
        fields.push(`${key} = ?`)
        if (key === 'labels') values.push(JSON.stringify(patch[key] ?? []))
        else if (key === 'labelColors') values.push(JSON.stringify(patch[key] ?? {}))
        else if (key === 'runs') values.push(typeof patch[key] === 'string' ? patch[key] : JSON.stringify(patch[key] ?? []))
        else if (key === 'checklist') values.push(typeof patch[key] === 'string' ? patch[key] : JSON.stringify(patch[key] ?? []))
        else if (key === 'report') values.push(typeof patch[key] === 'string' ? patch[key] : JSON.stringify(patch[key] ?? {}))
        else if (key === 'comments') values.push(typeof patch[key] === 'string' ? patch[key] : JSON.stringify(patch[key] ?? []))
        else if (key === 'rejectedAt') values.push(Number(patch[key]) || 0)
        else if (key === 'rejectReason') values.push(String(patch[key] ?? ''))
        else if (key === 'waiting') values.push(patch[key] ? 1 : 0)
        else if (key === 'syncedAt') values.push(Number(patch[key]) || 0)
        else if (key === 'isEpic') values.push(patch[key] ? 1 : 0)
        else if (key === 'parentId') values.push(String(patch[key] ?? ''))
        else values.push(patch[key] ?? null)
      }
      if (fields.length > 0) {
        values.push(Date.now(), id)
        db.prepare(`UPDATE tasks SET ${fields.join(', ')}, updatedAt = ? WHERE id = ?`).run(...values)
      }
      return rowToTask(q.taskById.get(id))
    },

    listDueTasks(now = Date.now()) {
      return q.scheduledDue.all(now).map(rowToTask)
    },

    recordTaskRun(id, run) {
      const task = rowToTask(q.taskById.get(id))
      if (!task) return undefined
      const runs = Array.isArray(task.runs) ? [...task.runs] : []
      runs.unshift(run)
      const trimmed = runs.slice(0, 20)
      this.updateTask(id, { runs: JSON.stringify(trimmed) })
      return rowToTask(q.taskById.get(id))
    },

    updateTaskRun(id, runId, patch) {
      const task = rowToTask(q.taskById.get(id))
      if (!task) return undefined
      const runs = Array.isArray(task.runs) ? [...task.runs] : []
      const idx = runs.findIndex((r) => r.id === runId)
      if (idx === -1) return undefined
      runs[idx] = { ...runs[idx], ...patch }
      this.updateTask(id, { runs: JSON.stringify(runs) })
      return rowToTask(q.taskById.get(id))
    },

    
    addComment(id, { author = 'user', role = 'user', text }) {
      const task = rowToTask(q.taskById.get(id))
      if (!task) return undefined
      const comments = Array.isArray(task.comments) ? [...task.comments] : []
      const item = {
        id: randomUUID(),
        author: String(author || 'user'),
        role: String(role || 'user'),
        text: String(text || '').trim(),
        createdAt: Date.now(),
      }
      comments.push(item)
      return this.updateTask(id, { comments })
    },

    addTaskComment(id, comment) {
      if (!comment || typeof comment !== 'object') return undefined
      return this.addComment(id, {
        author: comment.author,
        role: comment.role,
        text: comment.text || comment.body || '',
      })
    },

    updateChecklist(id, items) {
      const task = rowToTask(q.taskById.get(id))
      if (!task) return undefined
      const list = (Array.isArray(items) ? items : []).map((item) => {
        if (typeof item === 'string') return { text: item, completed: false, done: false }
        const c = item.completed !== undefined ? Boolean(item.completed) : Boolean(item.done)
        return { ...item, completed: c, done: c }
      })
      return this.updateTask(id, { checklist: list })
    },

    restoreTask(task) {
      if (!task || !task.id) return undefined
      const labels = JSON.stringify(Array.isArray(task.labels) ? task.labels : [])
      const colors = JSON.stringify(task.labelColors && typeof task.labelColors === 'object' ? task.labelColors : {})
      const runs = JSON.stringify(Array.isArray(task.runs) ? task.runs : [])
      const checklist = JSON.stringify(Array.isArray(task.checklist) ? task.checklist : [])
      const report = JSON.stringify(task.report && typeof task.report === 'object' ? task.report : {})
      const comments = JSON.stringify(Array.isArray(task.comments) ? task.comments : [])
      const forge = typeof task.forge === 'string'
        ? task.forge
        : (typeof task.issueUrl === 'string' && task.issueUrl.includes('github.com') ? 'github' : (task.owner && task.repo && task.issueNumber ? 'gitea' : ''))
      const targetBoard = task.board || 'main'
      const targetCol = task.column || task.col || 'backlog'
      const position = isValidOrderKey(task.position) ? task.position : positionFor(targetBoard, targetCol, undefined, undefined)
      q.restoreTask.run(
        task.id,
        targetBoard,
        targetCol,
        position,
        task.title || '',
        task.body || '',
        task.owner ?? null,
        task.repo ?? null,
        task.issueNumber ?? null,
        task.issueUrl ?? null,
        task.externalRef ?? null,
        labels,
        task.branch ?? null,
        task.worktree ?? null,
        task.workspaceId || '',
        task.sessionId ?? null,
        task.model ?? null,
        task.provider !== undefined ? task.provider : null,
        task.waiting ? 1 : 0,
        task.syncedAt || 0,
        colors,
        task.author || '',
        task.assignee || '',
        task.milestone || '',
        task.priority || '',
        task.dueAt || 0,
        task.columnAt || task.createdAt || Date.now(),
        task.createdAt || Date.now(),
        task.updatedAt || Date.now(),
        task.cron || '',
        task.nextRunAt || 0,
        task.lastRunAt || 0,
        task.progressDump || '',
        task.permission || '',
        task.permissionConfirmedAt || 0,
        task.permissionConfirmedTier || '',
        runs,
        checklist,
        report,
        comments,
        task.rejectReason || '',
        task.rejectedAt || 0,
        task.reasoningEffort || '',
        task.parentId || '',
        task.isEpic ? 1 : 0,
        task.workflowRunId || '',
        task.workflowStatus || '',
        task.archivedAt || 0,
        task.queuedAt || 0,
        task.plan || '',
        forge,
        task.queuedRequest || '',
      )
      return rowToTask(q.taskById.get(task.id))
    },

    restoreTransition(trans) {
      if (!trans || !trans.taskId) return undefined
      q.restoreTransition.run(
        trans.taskId,
        trans.fromCol ?? null,
        trans.toCol || '',
        trans.source || 'unknown',
        trans.detail || '',
        trans.at || Date.now(),
      )
    },

    setReport(id, reportData) {
      const task = rowToTask(q.taskById.get(id))
      if (!task) return undefined
      const report = (reportData && typeof reportData === 'object') ? reportData : {}
      report.createdAt = report.createdAt || Date.now()
      return this.updateTask(id, { report })
    },

    rejectTask(id, reason) {
      const task = rowToTask(q.taskById.get(id))
      if (!task) return undefined
      const r = String(reason ?? '').trim()
      const commentText = `[Rejection]: ${r}`
      this.addComment(id, { author: 'user', role: 'user', text: commentText })
      this.moveTask(id, { column: 'in-progress' })
      this.addTransition({
        taskId: id,
        fromCol: task.column,
        toCol: 'in-progress',
        source: 'manual',
        detail: `Rejected: ${r}`,
      })
      return this.updateTask(id, { rejectReason: r, rejectedAt: Date.now() })
    },

    acceptTask(id) {
      const task = rowToTask(q.taskById.get(id))
      if (!task) return undefined
      this.moveTask(id, { column: 'done' })
      this.addTransition({
        taskId: id,
        fromCol: task.column,
        toCol: 'done',
        source: 'manual',
        detail: 'Accepted by human',
      })
      return this.updateTask(id, { rejectReason: '', rejectedAt: 0 })
    },
    moveTask(id, { column, beforeId, afterId }) {
      const current = q.taskById.get(id)
      if (current === undefined) throw new Error(`task ${id} not found`)
      const target = column ?? current.col
      const position = positionFor(current.board, target, beforeId, afterId)
      const now = Date.now()
      // Time in column is tracked via timestamp rather than querying transition logs.
      // Reordering within the column preserves columnAt.
      const enteredAt = target === current.col ? current.columnAt : now
      // Moving to in-progress resets queuedAt since the task is no longer waiting.
      const queuedAt = target === 'in-progress' ? 0 : current.queuedAt
      db.prepare('UPDATE tasks SET col = ?, position = ?, columnAt = ?, queuedAt = ?, updatedAt = ? WHERE id = ?')
        .run(target, position, enteredAt, queuedAt, now, id)
      return rowToTask(q.taskById.get(id))
    },

    deleteTask(id) {
      // Record deleted tasks as dismissed to prevent the intake loop from re-importing them.
      const task = q.taskById.get(id)
      if (task?.owner && task?.repo && typeof task.issueNumber === 'number') {
        q.dismiss.run(task.owner, task.repo, task.issueNumber, task.forge || '', Date.now())
      }
      q.deleteTask.run(id)
    },

    /** Whether an issue was previously dismissed. */
    isDismissed({ owner, repo, issueNumber, forge }) {
      if (forge) {
        return q.isDismissedWithForge.get(owner, repo, issueNumber, forge, forge) !== undefined
      }
      return q.isDismissed.get(owner, repo, issueNumber) !== undefined
    },

    /** Find task by issue to prevent duplicate import. */
    findTaskByIssue({ owner, repo, issueNumber, forge }) {
      if (forge) {
        return rowToTask(q.byIssueWithForge.get(owner, repo, issueNumber, forge, forge))
      }
      return rowToTask(q.byIssue.get(owner, repo, issueNumber))
    },

    findTaskByExternalRef(externalRef) {
      const key = typeof externalRef === 'string' ? externalRef.trim() : ''
      if (!key) return undefined
      return rowToTask(q.byExternalRef.get(key))
    },

    listSubtasks(parentId) {
      if (!parentId) return []
      return q.subtasksOf.all(parentId).map(rowToTask)
    },

    countSubtasks(parentId) {
      if (!parentId) return { total: 0, completed: 0 }
      const res = q.countSubtasks.get(parentId)
      return { total: res?.total ?? 0, completed: res?.completed ?? 0 }
    },

    setParent(id, parentId) {
      return this.updateTask(id, { parentId: parentId ?? '' })
    },

    /** Archived tasks list. */
    listArchived() {
      return q.archived.all().map(rowToTask)
    },

    /**
     * Query tasks ready for archiving.
     *
     * Age is calculated based on column entry timestamp rather than updatedAt,
     * as background reconciliation touches updatedAt after completion.
     */
    listArchivable(before) {
      return q.archivable.all(before).map(rowToTask)
    },

    setArchived(id, archivedAt) {
      const at = typeof archivedAt === 'boolean' ? (archivedAt ? Date.now() : 0) : (Number(archivedAt) || 0)
      db.prepare('UPDATE tasks SET archivedAt = ?, updatedAt = ? WHERE id = ?')
        .run(at, Date.now(), id)
      return rowToTask(q.taskById.get(id))
    },

    addTransition({ taskId, fromCol, toCol, source, detail }) {
      if (!SOURCES.has(source)) throw new Error(`unknown transition source: ${source}`)
      q.insertTransition.run(taskId, fromCol ?? null, toCol, source, detail ?? '', Date.now())
    },

    listTransitions(taskId) {
      return q.transitionsOf.all(taskId)
    },

    /** Return all transitions; used by metrics calculator across the entire board. */
    listAllTransitions() {
      return q.allTransitions.all()
    },

    /**
     * Full board snapshot for export: all boards, tasks (including archived),
     * and transition history.
     */
    exportAll() {
      return {
        version: 1,
        boards: q.boards.all(),
        tasks: q.allTasks.all().map(rowToTask),
        transitions: q.allTransitions.all(),
      }
    },

    securePermissions() {
      secureStorePermissions(dir)
    },

    close() {
      try { secureStorePermissions(dir) } catch { /* ignore */ }
      db.close()
      try { secureStorePermissions(dir) } catch { /* ignore */ }
    },
  }
}

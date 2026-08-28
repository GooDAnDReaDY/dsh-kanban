// Хранилище задач доски.
//
// У канбана свои поля и своя история, которых в Gitea нет: сессия, модель,
// журнал переходов, порядок карточек. Поэтому задачи живут здесь, а не только
// в issue.
//
// Колонка в таблице названа `col`, а не `column`: `column` — зарезервированное
// слово SQL, и без экранирования запрос падает. Наружу поле по-прежнему
// называется `column`, переименование спрятано внутри этого модуля.
//
// Поля `branch` и `worktree` — НАБЛЮДЕНИЕ, вычитанное из issue и событий
// Gitea, а не намерение: плагин ветки не создаёт.

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { keyBetween } from './order.js'
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
  labels       TEXT NOT NULL DEFAULT '[]',
  branch       TEXT,
  worktree     TEXT,
  sessionId    TEXT,
  model        TEXT,
  provider     TEXT,
  waiting      INTEGER NOT NULL DEFAULT 0,
  plan         TEXT NOT NULL DEFAULT '',
  columnAt     INTEGER NOT NULL DEFAULT 0,
  archivedAt   INTEGER NOT NULL DEFAULT 0,
  labelColors  TEXT NOT NULL DEFAULT '{}',
  syncedAt     INTEGER NOT NULL DEFAULT 0,
  createdAt    INTEGER NOT NULL,
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
  at          INTEGER NOT NULL,
  PRIMARY KEY (owner, repo, issueNumber)
);
`

/** Поля задачи, которые разрешено править через updateTask. */
const WRITABLE = [
  'title', 'body', 'owner', 'repo', 'issueNumber', 'issueUrl', 'labels',
  'branch', 'worktree', 'sessionId', 'model', 'provider', 'waiting', 'syncedAt', 'plan',
  'labelColors',
]

/** Источники перехода; чужое значение не пишем, чтобы журнал оставался читаемым. */
const SOURCES = new Set(['manual', 'session', 'gitea', 'tool'])

function rowToTask(row) {
  if (row === undefined) return undefined
  const { col, labels, waiting, labelColors, ...rest } = row
  let parsed = []
  try {
    const value = JSON.parse(labels)
    if (Array.isArray(value)) parsed = value.filter((l) => typeof l === 'string')
  } catch { /* испорченное поле не должно ронять чтение всей доски */ }
  let colors = {}
  try {
    const value = JSON.parse(labelColors ?? '{}')
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) colors = value
  } catch { /* испорченное поле не должно ронять чтение всей доски */ }
  return { ...rest, column: col, labels: parsed, labelColors: colors, waiting: waiting === 1 }
}

/**
 * Открыть хранилище задач.
 * @param {{dir: string}} options каталог, в котором лежит файл базы
 * @returns {object} интерфейс хранилища
 */
export function openStore({ dir }) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'kanban.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  // База могла быть создана прежней версией. Добавляем недостающие столбцы
  // поштучно: ALTER на существующий столбец бросает, и это штатный ответ
  // «уже есть», а не поломка.
  for (const [column, definition] of [
    ['waiting', 'INTEGER NOT NULL DEFAULT 0'],
    ['syncedAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['plan', "TEXT NOT NULL DEFAULT ''"],
    ['columnAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['archivedAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['labelColors', "TEXT NOT NULL DEFAULT '{}'"],
  ]) {
    try { db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`) } catch { /* столбец уже есть */ }
  }
  try { db.exec("ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'") } catch { /* уже есть */ }
  // Старые карточки не знают, когда попали в свою колонку. Считаем от
  // заведения: это честнее нуля, который читался бы как «в 1970 году».
  db.exec('UPDATE tasks SET columnAt = createdAt WHERE columnAt = 0')

  const q = {
    boards: db.prepare('SELECT * FROM boards ORDER BY position'),
    boardById: db.prepare('SELECT * FROM boards WHERE id = ?'),
    insertBoard: db.prepare('INSERT INTO boards (id, title, kind, position, createdAt) VALUES (?, ?, ?, ?, ?)'),
    lastBoard: db.prepare('SELECT position FROM boards ORDER BY position DESC LIMIT 1'),
    taskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    tasksByBoard: db.prepare('SELECT * FROM tasks WHERE board = ? AND archivedAt = 0 ORDER BY col, position'),
    archived: db.prepare('SELECT * FROM tasks WHERE archivedAt > 0 ORDER BY archivedAt DESC'),
    archivable: db.prepare(
      "SELECT * FROM tasks WHERE archivedAt = 0 AND col = 'done' AND columnAt > 0 AND columnAt <= ?"),
    dismiss: db.prepare('INSERT OR REPLACE INTO dismissed (owner, repo, issueNumber, at) VALUES (?, ?, ?, ?)'),
    isDismissed: db.prepare('SELECT 1 FROM dismissed WHERE owner = ? AND repo = ? AND issueNumber = ?'),
    byIssue: db.prepare('SELECT * FROM tasks WHERE owner = ? AND repo = ? AND issueNumber = ?'),
    tasksBySession: db.prepare('SELECT * FROM tasks WHERE sessionId = ? LIMIT 1'),
    lastInColumn: db.prepare('SELECT position FROM tasks WHERE board = ? AND col = ? ORDER BY position DESC LIMIT 1'),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
    insertTransition: db.prepare('INSERT INTO transitions (taskId, fromCol, toCol, source, detail, at) VALUES (?, ?, ?, ?, ?, ?)'),
    transitionsOf: db.prepare('SELECT * FROM transitions WHERE taskId = ? ORDER BY at, id'),
    countInColumn: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE board = ? AND col = ?'),
    watchable: db.prepare(
      "SELECT * FROM tasks WHERE issueNumber IS NOT NULL AND col NOT IN ('done') ORDER BY updatedAt DESC"),
  }

  function ensureBoard(id, title, kind) {
    const found = q.boardById.get(id)
    if (found !== undefined) return found
    const last = q.lastBoard.get()
    const position = keyBetween(last?.position, undefined)
    q.insertBoard.run(id, title, normalizeKind(kind), position, Date.now())
    return q.boardById.get(id)
  }

  // Обе доски заводятся сразу: пустое хранилище без единой доски выглядит в
  // интерфейсе как поломка, а не как чистый старт.
  //
  // Прежняя единственная доска `main` СТАНОВИТСЯ проектной, а не заводится
  // рядом с новой: заведи мы вторую, задачи остались бы на осиротевшей.
  for (const board of DEFAULT_BOARDS) ensureBoard(board.id, board.title, board.kind)
  // Прежняя доска называлась «Основная», и рядом с «Простой» это читается как
  // разница в важности, а не в виде. Переименовываем только нетронутое
  // название: если его меняли, значит оно чьё-то.
  db.prepare("UPDATE boards SET title = ? WHERE id = 'main' AND title = 'Основная доска'")
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
    listBoards() {
      return q.boards.all()
    },

    createBoard({ id, title, kind }) {
      return ensureBoard(id, title ?? id, kind)
    },

    /** Вид доски. Неизвестная доска — проектная: пустого набора колонок нет. */
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

    /** Задачи, за которыми стоит issue и по которым работа ещё идёт. */
    listWatchable() {
      return q.watchable.all().map(rowToTask)
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
      const board = input.board ?? 'main'
      const column = input.column ?? 'backlog'
      const id = randomUUID()
      const position = positionFor(board, column, input.beforeId, input.afterId)
      db.prepare(`INSERT INTO tasks
        (id, board, col, position, title, body, owner, repo, issueNumber, issueUrl,
         labels, branch, worktree, sessionId, model, provider, waiting, syncedAt,
         labelColors, columnAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, board, column, position,
        input.title ?? '', input.body ?? '',
        input.owner ?? null, input.repo ?? null,
        input.issueNumber ?? null, input.issueUrl ?? null,
        JSON.stringify(input.labels ?? []),
        input.branch ?? null, input.worktree ?? null,
        input.sessionId ?? null, input.model ?? null, input.provider ?? null,
        input.waiting ? 1 : 0,
        Number(input.syncedAt) || 0,
        JSON.stringify(input.labelColors ?? {}),
        now, now, now,
      )
      return rowToTask(q.taskById.get(id))
    },

    updateTask(id, patch) {
      const current = q.taskById.get(id)
      if (current === undefined) throw new Error(`задача ${id} не найдена`)
      const fields = []
      const values = []
      for (const key of WRITABLE) {
        if (!Object.hasOwn(patch, key)) continue
        fields.push(`${key} = ?`)
        if (key === 'labels') values.push(JSON.stringify(patch[key] ?? []))
        else if (key === 'labelColors') values.push(JSON.stringify(patch[key] ?? {}))
        else if (key === 'waiting') values.push(patch[key] ? 1 : 0)
        else if (key === 'syncedAt') values.push(Number(patch[key]) || 0)
        else values.push(patch[key] ?? null)
      }
      if (fields.length > 0) {
        values.push(Date.now(), id)
        db.prepare(`UPDATE tasks SET ${fields.join(', ')}, updatedAt = ? WHERE id = ?`).run(...values)
      }
      return rowToTask(q.taskById.get(id))
    },

    moveTask(id, { column, beforeId, afterId }) {
      const current = q.taskById.get(id)
      if (current === undefined) throw new Error(`задача ${id} не найдена`)
      const target = column ?? current.col
      const position = positionFor(current.board, target, beforeId, afterId)
      const now = Date.now()
      // Время в колонке считаем по отметке, а не по журналу переходов: журнал
      // пришлось бы читать на каждую карточку при каждой сборке доски.
      // Перестановка внутри колонки отметку НЕ сбрасывает — задача в ревью
      // третий день там и остаётся, как бы её ни двигали вверх-вниз.
      const enteredAt = target === current.col ? current.columnAt : now
      db.prepare('UPDATE tasks SET col = ?, position = ?, columnAt = ?, updatedAt = ? WHERE id = ?')
        .run(target, position, enteredAt, now, id)
      return rowToTask(q.taskById.get(id))
    },

    deleteTask(id) {
      // Удалённая карточка задачи из Gitea запоминается как отказанная: иначе
      // подхват вернул бы её на доску следующим же проходом, и доска спорила
      // бы с человеком каждые две минуты.
      const task = q.taskById.get(id)
      if (task?.owner && task?.repo && typeof task.issueNumber === 'number') {
        q.dismiss.run(task.owner, task.repo, task.issueNumber, Date.now())
      }
      q.deleteTask.run(id)
    },

    /** Отказывались ли уже от этого issue. */
    isDismissed({ owner, repo, issueNumber }) {
      return q.isDismissed.get(owner, repo, issueNumber) !== undefined
    },

    /** Задача по issue — чтобы подхват не заводил второй раз то же самое. */
    findTaskByIssue({ owner, repo, issueNumber }) {
      return rowToTask(q.byIssue.get(owner, repo, issueNumber))
    },

    /** Задачи в архиве: свой список, а не колонка. */
    listArchived() {
      return q.archived.all().map(rowToTask)
    },

    /**
     * Что пора убрать в архив.
     *
     * Возраст считаем по отметке входа в колонку, а не по `updatedAt`: сверка
     * трогает задачу и после завершения, и по `updatedAt` архив откладывался
     * бы бесконечно.
     */
    listArchivable(before) {
      return q.archivable.all(before).map(rowToTask)
    },

    setArchived(id, archivedAt) {
      db.prepare('UPDATE tasks SET archivedAt = ?, updatedAt = ? WHERE id = ?')
        .run(archivedAt, Date.now(), id)
      return rowToTask(q.taskById.get(id))
    },

    addTransition({ taskId, fromCol, toCol, source, detail }) {
      if (!SOURCES.has(source)) throw new Error(`неизвестный источник перехода: ${source}`)
      q.insertTransition.run(taskId, fromCol ?? null, toCol, source, detail ?? '', Date.now())
    },

    listTransitions(taskId) {
      return q.transitionsOf.all(taskId)
    },

    close() {
      db.close()
    },
  }
}

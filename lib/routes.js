// Обработчики HTTP доски.
//
// Браузерная половина не имеет доступа ни к хранилищу, ни к службам хоста —
// она ходит сюда. Обработчики написаны так, чтобы проверяться без HTTP:
// принимают разобранный вход и хранилище, возвращают объект ответа. Обвязка
// вокруг req/res живёт в `lib/index.js`.
//
// Перехвата чужих маршрутов и промежуточных обработчиков в DSH нет:
// `ctx.webServer.register` — единственный способ.

import { COLUMN_ORDER, columnsOf, wipLimitField } from './config.js'
import { parsePlan, planItems, planProgress, taskState } from './plan.js'

/** Больше этого тело запроса не читаем: без предела один запрос кладёт хост. */
export const MAX_BODY_BYTES = 256 * 1024

/**
 * Запрос с чужого сайта. Изменяющие маршруты правят локальное состояние, и
 * пускать в них кросс-сайтовый запрос нельзя.
 */
export function isTrustedRequest(req) {
  return req?.headers?.['sec-fetch-site'] !== 'cross-site'
}

/** Разобрать `/dsh-kanban/task/<id>[/<action>]`; иначе undefined. */
export function parseTaskPath(pathname) {
  const m = /^\/dsh-kanban\/task\/([^/]+)(?:\/([a-z]+))?\/?$/.exec(pathname ?? '')
  if (m === null) return undefined
  return { id: decodeURIComponent(m[1]), action: m[2] }
}

/**
 * Задача с разобранным планом и состоянием.
 *
 * Сырую строку плана наружу не отдаём: браузерная половина — отдельный бандл,
 * она не может позвать `lib/plan.js`, и разбор пришлось бы писать второй раз.
 *
 * `liveOf` возвращает состояние живого агента сессии либо `undefined`, если
 * агента нет. Без него состояние не вычислить: «остановился» — это факт об
 * отсутствии агента, а не догадка по тишине.
 */
function withPlan(task, liveOf) {
  const plan = parsePlan(task.plan)
  // Отказ реестра — это «агента нет», а не повод не собрать доску: одна
  // непрочитанная сессия не должна прятать от человека все задачи.
  let live
  try {
    if (typeof liveOf === 'function' && task.sessionId) live = liveOf(task.sessionId)
  } catch { live = undefined }
  return {
    ...task,
    plan: { items: planItems(plan), progress: planProgress(plan) },
    state: taskState({ task, live }),
  }
}

/**
 * Ответ доски: колонки в фиксированном порядке, задачи и пределы.
 * Порядок колонок задан кодом, а не настройками: он повторяет воркфлоу, и
 * переставлять его местами незачем.
 */
export function buildBoard({ store, config, board = 'main', repo, liveOf }) {
  const tasks = store.listTasks({ board, repo }).map((task) => withPlan(task, liveOf))
  const kind = store.boardKind(board)
  const columns = columnsOf(kind).map((id) => {
    const count = tasks.filter((t) => t.column === id).length
    const limit = wipLimitField(config, id)
    return { id, count, limit, overLimit: limit !== undefined && count > limit }
  })
  return { board, kind, boards: store.listBoards(), columns, tasks }
}

/**
 * Перенос карточки. Предел колонки — предупреждение, а не запрет: перенос
 * выполняется, а признак превышения уезжает в ответ, и доска подсветит
 * колонку. Запрет здесь превратил бы предел из ориентира в преграду.
 */
export function applyMove({ store, config, id, column, beforeId, afterId, source = 'manual', detail = '' }) {
  const before = store.getTask(id)
  if (before === undefined) return { error: 'task-not-found', status: 404 }
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

/** Создание своей задачи (не из Gitea). */
export function createTask({ store, input }) {
  const title = typeof input?.title === 'string' ? input.title.trim() : ''
  if (title === '') return { error: 'title-required', status: 400 }
  const board = input?.board ?? 'main'
  // Колонка проверяется по ВИДУ доски, а не по общему списку: положить задачу
  // в `deploy` на простой доске значило бы спрятать её в колонке, которой там
  // нет.
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

/** Правка полей карточки. Колонку и порядок правит только перенос. */
export function updateTask({ store, id, input }) {
  if (store.getTask(id) === undefined) return { error: 'task-not-found', status: 404 }
  const patch = {}
  if (typeof input?.title === 'string' && input.title.trim() !== '') patch.title = input.title.trim()
  if (typeof input?.body === 'string') patch.body = input.body
  if (Array.isArray(input?.labels)) patch.labels = input.labels.filter((l) => typeof l === 'string')
  return { task: store.updateTask(id, patch) }
}

export function deleteTask({ store, id }) {
  if (store.getTask(id) === undefined) return { error: 'task-not-found', status: 404 }
  store.deleteTask(id)
  return { ok: true }
}

export function taskLog({ store, id }) {
  if (store.getTask(id) === undefined) return { error: 'task-not-found', status: 404 }
  return { transitions: store.listTransitions(id) }
}

/** Задача, привязанная к сессии; отсутствие задачи — штатный ответ. */
export function taskBySession({ store, sessionId }) {
  const task = store.findTaskBySession(sessionId)
  if (task === undefined) return { task: null }
  // Вид доски едет вместе с задачей: чип предлагает колонки, а предлагать
  // `deploy` задаче с простой доски значит звать в колонку, которой нет.
  return { task, columns: columnsOf(store.boardKind(task.board)) }
}

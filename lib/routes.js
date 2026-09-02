// Обработчики HTTP доски.
//
// Браузерная половина не имеет доступа ни к хранилищу, ни к службам хоста —
// она ходит сюда. Обработчики написаны так, чтобы проверяться без HTTP:
// принимают разобранный вход и хранилище, возвращают объект ответа. Обвязка
// вокруг req/res живёт в `lib/index.js`.
//
// Перехвата чужих маршрутов и промежуточных обработчиков в DSH нет:
// `ctx.webServer.register` — единственный способ.

import { COLUMN_ORDER, columnsOf, wipLimitField, columnNamesOf } from './config.js'
import { parsePlan, planItems, planProgress, taskState, queuePosition } from './plan.js'
import { isStale } from './time.js'
import { facetsOf, facetsOfTask, groupByRepo, sortByLife } from './filters.js'
import { parseBody } from './markdown.js'

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
function withPlan(task, liveOf, config, now, sameSession) {
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
    // Номер в очереди считается на лету: агент берёт задачи одну за другой, и
    // у оставшихся третий сам становится вторым.
    queuePos: queuePosition(task, sameSession),
    // Метки разобраны здесь же: браузер сверяет списки, а не разбирает строки.
    facets: facetsOfTask(task),
    // Считаем здесь, а не в браузере: порог живёт в настройках, а настройки —
    // на хосте. Отдавать браузеру ещё и порог значило бы отдавать ему решение.
    stale: isStale({
      now,
      updatedAt: task.updatedAt,
      sessionId: task.sessionId,
      afterMinutes: config?.staleAfterMin,
    }),
    // Просрочено — дедлайн есть и он раньше «сейчас». Считается на хосте,
    // чтобы браузер не зависел от своих часов.
    overdue: typeof task.dueAt === 'number' && task.dueAt > 0 && task.dueAt < now,
  }
}

/** Разложить задачи: по колонкам, внутри — по проектам, внутри — идущее наверх. */
function orderForBoard(tasks, columns) {
  const out = []
  for (const column of columns) {
    const inColumn = tasks.filter((t) => t.column === column)
    for (const group of groupByRepo(sortByLife(inColumn))) out.push(...group.tasks)
  }
  // Задачи в колонке, которой на этой доске нет, не теряем: спрятать их совсем
  // хуже, чем показать в непривычном месте.
  const seen = new Set(out.map((t) => t.id))
  for (const task of tasks) if (!seen.has(task.id)) out.push(task)
  return out
}

/**
 * Ответ доски: колонки в фиксированном порядке, задачи и пределы.
 * Порядок колонок задан кодом, а не настройками: он повторяет воркфлоу, и
 * переставлять его местами незачем.
 */
export function buildBoard({ store, config, board = 'main', repo, liveOf, sync, projectRoot }) {
  // Одно «сейчас» на всю сборку: иначе соседние карточки посчитались бы по
  // разным моментам, и разница вылезла бы ровно на границе минуты.
  const now = Date.now()
  // Порядок задаём здесь, а не в браузере: правила группировки и подъёма
  // повторять во второй раз значило бы завести вторую их редакцию.
  //
  // Отдаём задачи УЖЕ разложенными — сперва по проектам, внутри проекта идущая
  // работа наверх. Браузер рисует заголовок при смене проекта, и после отбора
  // группы остаются целыми, потому что отбор порядка не меняет.
  const raw = store.listTasks({ board, repo })
  // Очередь считается внутри своей сессии, а не по доске целиком: две сессии —
  // две независимые очереди.
  const bySession = new Map()
  for (const task of raw) {
    const id = typeof task.sessionId === 'string' ? task.sessionId : ''
    if (id === '') continue
    if (!bySession.has(id)) bySession.set(id, [])
    bySession.get(id).push(task)
  }
  const tasks = orderForBoard(
    raw.map((task) => withPlan(task, liveOf, config, now, bySession.get(task.sessionId) ?? [])),
    columnsOf(store.boardKind(board)),
  )
  const kind = store.boardKind(board)
  // Своё название приходит с сервера, а перевод остаётся на браузере: конфиг
  // живёт здесь, а языки — там, и смешивать их не надо.
  const names = columnNamesOf(config)
  const columns = columnsOf(kind).map((id) => {
    const count = tasks.filter((t) => t.column === id).length
    const limit = wipLimitField(config, id)
    return { id, name: names[id], count, limit, overLimit: limit !== undefined && count > limit }
  })
  // Отборы считаем по ВСЕМ задачам доски, а не по отобранным: счётчик рядом со
  // значением отвечает «сколько там всего», а не «сколько осталось после моего
  // же выбора».
  return {
    board, kind, now, boards: store.listBoards(), columns, tasks,
    // Фактический корень проектов: {path, set} — путь и признак «задан
    // настройкой». Считается на хосте — браузер не знает ни настройку, ни cwd.
    projectRoot: projectRoot ?? { path: '', set: false },

    facets: facetsOf(tasks),
    // Состояние сверки едет вместе с доской: отдельный опрос ради него был бы
    // вторым источником обращений и вторым местом, где это может отстать.
    sync: sync ?? { state: 'never' },
  }
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
  // Приоритет — локальное свойство доски: в Gitea назад не пишется. Чужие
  // значения отбрасываются: одно испорченное поле не должно ронять правку
  // остальных.
  if (PRIORITIES.includes(input?.priority)) patch.priority = input.priority
  // Дедлайн — тоже локальное свойство. Ноль снимает, положительное число —
  // ставит; отрицательное и мусор отбрасываются.
  if (typeof input?.dueAt === 'number' && Number.isFinite(input.dueAt) && input.dueAt >= 0) {
    patch.dueAt = Math.floor(input.dueAt)
  }
  return { task: store.updateTask(id, patch) }
}

/** Известные приоритеты. Пустой — «без приоритета». */
export const PRIORITIES = ['', 'high', 'medium', 'low']

/**
 * Дописать заметку в тело задачи.
 *
 * Именно в тело, а не в отдельную ленту заметок и не комментарием в Gitea:
 * владелец выбрал самый простой из трёх смыслов, и он же самый дешёвый.
 *
 * Дописываем на сервере, а не в браузере: чип держит копию задачи, и склейка
 * у него потеряла бы всё, что тело нажило с момента её получения.
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
 * Убрать карточку в архив или вернуть на доску.
 *
 * Возврат ставит её ровно туда, где она была: колонка и порядок сохранены, а
 * `archivedAt` — единственное, что менялось.
 */
export function setArchived({ store, id, archived, now = Date.now() }) {
  const task = store.getTask(id)
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  return { task: store.setArchived(id, archived ? now : 0) }
}

/** Архив: свой список, а не колонка — архив стадией работы не является. */
export function listArchive({ store }) {
  return { tasks: store.listArchived() }
}

export function deleteTask({ store, id }) {
  if (store.getTask(id) === undefined) return { error: 'task-not-found', status: 404 }
  store.deleteTask(id)
  return { ok: true }
}

/**
 * Тело задачи, разобранное в дерево блоков.
 *
 * Разбираем здесь, а не в браузере: браузерная половина — отдельный бандл и
 * позвать `lib/markdown.js` не может. Заодно тело не едет в разметку строкой,
 * и подставить туда чужое нечем.
 */
export function taskBody({ store, id }) {
  const task = store.getTask(id)
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  return { blocks: parseBody(task.body) }
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

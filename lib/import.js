// Перенос issue Gitea в задачу доски.
//
// Синхронизация в 0.1 односторонняя: Gitea → канбан, в момент импорта и по
// кнопке обновления. Двусторонняя синхронизация — отдельный выпуск, и тянуть
// её сюда нельзя.
//
// Клиент Gitea приходит параметром — его собирает `lib/gitea.js`. Здесь только
// перенос полей и решение, что делать, когда доступ не настроен.

import { safeSegment } from './gitea.js'

/**
 * Поля задачи из issue.
 *
 * `owner` и `repo` берутся из запроса, а не из issue: API Gitea возвращает их
 * не во всех формах ответа, и полагаться на это нельзя.
 *
 * Поля `branch`, `worktree`, `sessionId`, `model` НЕ заполняются: они
 * наблюдаются позже, когда работа начнётся. Плагин ветки не создаёт.
 */
export function issueToTask(issue, { board = 'main', column = 'backlog', owner, repo }) {
  return {
    board,
    column,
    title: typeof issue?.title === 'string' ? issue.title : '',
    body: typeof issue?.body === 'string' ? issue.body : '',
    labels: Array.isArray(issue?.labels)
      ? issue.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string')
      : [],
    owner,
    repo,
    issueNumber: typeof issue?.number === 'number' ? issue.number : undefined,
    issueUrl: typeof issue?.html_url === 'string' ? issue.html_url : undefined,
  }
}

/**
 * Пометить issue, которые уже лежат на доске.
 *
 * Сравнение идёт по тройке владелец–репозиторий–номер. Сравнение по одному
 * номеру пометило бы задачу №1 из чужого репозитория как уже импортированную.
 *
 * Помеченные не прячутся, а приглушаются: задачу иногда заводят второй раз
 * осознанно.
 */
export function markImported(issues, existing, { owner, repo }) {
  const seen = new Set(
    (existing ?? [])
      .filter((t) => t.owner === owner && t.repo === repo && typeof t.issueNumber === 'number')
      .map((t) => t.issueNumber),
  )
  return (issues ?? []).map((issue) => ({ ...issue, imported: seen.has(issue?.number) }))
}

/**
 * Что переписать в задаче при обновлении из issue.
 *
 * Переписываются только поля, пришедшие из Gitea. Локальные — колонка,
 * позиция, сессия, модель — не трогаются: иначе обновление сбрасывало бы
 * работу, которая уже идёт.
 */
export function refreshPatch(task, issue) {
  const patch = {}
  if (typeof issue?.title === 'string') patch.title = issue.title
  if (typeof issue?.body === 'string') patch.body = issue.body
  if (Array.isArray(issue?.labels)) {
    patch.labels = issue.labels
      .map((l) => (typeof l === 'string' ? l : l?.name))
      .filter((n) => typeof n === 'string')
  }
  if (typeof issue?.html_url === 'string') patch.issueUrl = issue.html_url
  return patch
}

/**
 * Клиент Gitea готов к работе. Отсутствие клиента и ненастроенный доступ —
 * разные беды, и человеку они говорят разное.
 *
 * Проверка асинхронная, потому что готовность включает разрешение учётной
 * записи с токеном, а это обращение к службе учётных данных.
 */
export async function giteaState(gitea) {
  if (gitea === undefined || gitea === null) return 'absent'
  if (typeof gitea.isConfigured !== 'function') return 'ready'
  try {
    return (await gitea.isConfigured()) === true ? 'ready' : 'unconfigured'
  } catch {
    return 'unconfigured'
  }
}

/**
 * Список issue для диалога импорта: открытые, уже импортированные помечены.
 */
export async function listImportable({ gitea, store, owner, repo, board = 'main' }) {
  const state = await giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  const issues = await gitea.listIssues({ owner, repo, state: 'open' })
  const existing = store.listTasks({ board })
  return { issues: markImported(issues, existing, { owner, repo }) }
}

/** Завести задачу из issue. */
export async function importIssue({ gitea, store, owner, repo, issueNumber, board = 'main', column = 'backlog' }) {
  const state = await giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  if (typeof issueNumber !== 'number') return { error: 'issue-number-required', status: 400 }
  // Простая доска — для задач без issue. Импорт на неё привёл бы задачу с
  // веткой и PR в набор колонок, где их некуда показать.
  if (store.boardKind(board) !== 'project') return { error: 'board-not-for-issues', status: 400 }
  const issue = await gitea.getIssue({ owner, repo, index: issueNumber })
  if (issue === undefined || issue === null) return { error: 'issue-not-found', status: 404 }
  return { task: store.createTask(issueToTask(issue, { board, column, owner, repo })) }
}

/** Перечитать issue и обновить задачу, не трогая локальные поля. */
export async function refreshTask({ gitea, store, id }) {
  const state = await giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  const task = store.getTask(id)
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  if (typeof task.issueNumber !== 'number') return { error: 'task-has-no-issue', status: 400 }
  const issue = await gitea.getIssue({ owner: task.owner, repo: task.repo, index: task.issueNumber })
  if (issue === undefined || issue === null) return { error: 'issue-not-found', status: 404 }
  return { task: store.updateTask(id, refreshPatch(task, issue)) }
}

/** Поиск репозиториев для диалога импорта. */
export async function searchRepos({ gitea, query, limit = 20 }) {
  const state = await giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  return { repos: await gitea.searchRepos({ query, limit }) }
}

/**
 * Завести проектную задачу: issue в Gitea плюс карточка, привязанная к нему.
 *
 * Репозиторий либо выбирается из существующих, либо заводится по имени.
 * Заводит его ЧЕЛОВЕК кнопкой: инструмента у агента для этого нет — он
 * пользуется `gitea_issue_create` из соседнего плагина, а карточка приезжает
 * подхватом.
 *
 * Порядок неслучаен: сперва репозиторий, потом issue, потом карточка. Обрыв на
 * середине не должен оставить карточку привязанной к репозиторию без issue —
 * лучше не завести карточку вовсе и сказать об этом, чем завести полупустую.
 */
export async function createProjectTask({
  gitea, store, owner, repo, newRepo, title, body, board = 'main',
}) {
  const state = await giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }

  const name = typeof title === 'string' ? title.trim() : ''
  if (name === '') return { error: 'title-required', status: 400 }

  let targetRepo = typeof repo === 'string' ? repo.trim() : ''
  if (targetRepo === '') {
    const wanted = typeof newRepo === 'string' ? newRepo.trim() : ''
    if (wanted === '') return { error: 'repo-required', status: 400 }
    // Имя проверяем ДО запроса: отказ Gitea пришёл бы позже и невнятнее.
    if (safeSegment(wanted) === undefined) return { error: 'bad-repo-name', status: 400 }
    try {
      await gitea.createRepo({ owner, name: wanted })
    } catch (error) {
      return { error: 'repo-not-created', status: 502, detail: String(error?.message ?? error) }
    }
    targetRepo = wanted
  }

  let issue
  try {
    issue = await gitea.createIssue({ owner, repo: targetRepo, title: name, body })
  } catch (error) {
    // Репозиторий, возможно, уже создан. Не удаляем его: удаление чужого
    // добра из-за своей неудачи хуже лишнего пустого репозитория.
    return { error: 'issue-not-created', status: 502, detail: String(error?.message ?? error) }
  }

  return { task: store.createTask(issueToTask(issue, { board, column: 'backlog', owner, repo: targetRepo })) }
}

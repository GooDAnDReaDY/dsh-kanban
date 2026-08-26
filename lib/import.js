// Перенос issue Gitea в задачу доски.
//
// Синхронизация в 0.1 односторонняя: Gitea → канбан, в момент импорта и по
// кнопке обновления. Двусторонняя синхронизация — отдельный выпуск, и тянуть
// её сюда нельзя.
//
// Свой клиент Gitea здесь не заводится: доступ берётся из службы `gitea`,
// которую отдаёт плагин dsh-gitea. Там уже настроены адрес инстанса и учётная
// запись с токеном, и дублировать их — значит завести второе место правды.

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

/** Служба Gitea готова к работе. Отсутствие службы и ненастроенный адрес — разные беды. */
export function giteaState(gitea) {
  if (gitea === undefined || gitea === null) return 'absent'
  if (typeof gitea.isConfigured === 'function' && gitea.isConfigured() !== true) return 'unconfigured'
  return 'ready'
}

/**
 * Список issue для диалога импорта: открытые, уже импортированные помечены.
 */
export async function listImportable({ gitea, store, owner, repo, board = 'main' }) {
  const state = giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  const issues = await gitea.listIssues({ owner, repo, state: 'open' })
  const existing = store.listTasks({ board })
  return { issues: markImported(issues, existing, { owner, repo }) }
}

/** Завести задачу из issue. */
export async function importIssue({ gitea, store, owner, repo, issueNumber, board = 'main', column = 'backlog' }) {
  const state = giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  if (typeof issueNumber !== 'number') return { error: 'issue-number-required', status: 400 }
  const issue = await gitea.getIssue({ owner, repo, index: issueNumber })
  if (issue === undefined || issue === null) return { error: 'issue-not-found', status: 404 }
  return { task: store.createTask(issueToTask(issue, { board, column, owner, repo })) }
}

/** Перечитать issue и обновить задачу, не трогая локальные поля. */
export async function refreshTask({ gitea, store, id }) {
  const state = giteaState(gitea)
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
  const state = giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  return { repos: await gitea.searchRepos({ query, limit }) }
}

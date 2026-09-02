// Сверка задач с Gitea и применение автопереходов.
//
// Ни таймера, ни планировщика здесь нет: когда сверять — решает `lib/index.js`.
// Здесь только «сверить вот эти задачи и применить, что выведется». Поэтому
// модуль проверяется тестами с заглушкой клиента, без сети и без ожиданий.

import { deriveColumn, resolveTransition, branchOfTask, pullsOfTask, resolveConflict } from './transitions.js'
import { watchedRepos, shouldTake, archiveBefore, isWatched } from './intake.js'
import { colorsOfIssue } from './filters.js'
import { issueToTask, issueBornAt, issueAuthor, issueAssignee, issueMilestone } from './import.js'

/**
 * Наблюдения по одному репозиторию.
 *
 * Читается ОДИН раз на репозиторий, а не на задачу: у десяти задач одного
 * репозитория наблюдения общие, и десять одинаковых запросов — это просто
 * десятикратная нагрузка на инстанс.
 *
 * Ошибка НЕ проглатывается. Неполное наблюдение хуже отсутствующего: не
 * прочитались PR — доска решит, что их нет, и увезёт карточку из ревью назад в
 * работу. Не прочитались ветки — сочтёт, что cleanup сделан, и объявит задачу
 * завершённой. Поэтому репозиторий с неудачным чтением пропускается до
 * следующей сверки целиком.
 */
export async function readRepo({ gitea, owner, repo }) {
  const [pulls, branches] = await Promise.all([
    gitea.listPulls({ owner, repo, state: 'all' }),
    gitea.listBranches({ owner, repo }),
  ])
  return { pulls, branches }
}

/**
 * Что Gitea говорит про одну задачу.
 *
 * @returns {{column: string|undefined, branch: string|undefined, pull: object|undefined}}
 */
export function observeTask(task, repoState, issue) {
  const branch = branchOfTask(task, repoState?.branches)
  const pulls = pullsOfTask(task, repoState?.pulls, branch)
  const column = deriveColumn({ issue, pulls, branchExists: branch !== undefined })
  const pull = pulls.find((p) => p?.merged === true || p?.merged_at)
    ?? pulls.find((p) => p?.state === 'open')
  return { column, branch, pull }
}

/** Пояснение к переходу — чтобы журнал читался, а не расшифровывался. */
export function explain({ column, branch, pull }) {
  switch (column) {
    case 'review': return pull?.number ? `PR #${pull.number} снят с WIP` : 'PR готов к ревью'
    case 'deploy': return pull?.number ? `PR #${pull.number} влит` : 'PR влит'
    case 'cleanup': return branch ? `issue закрыт, ветка ${branch} ещё есть` : 'issue закрыт'
    case 'done': return 'issue закрыт, ветка удалена'
    case 'in-progress': return branch ? `появилась ветка ${branch}` : 'работа началась'
    default: return ''
  }
}

/**
 * Поля, которые доска забирает у Gitea при каждой сверке.
 *
 * Метки и заголовок — источник правды в Gitea: переименовали issue или сменили
 * `priority/high` на `priority/critical` — доска обязана это увидеть, иначе
 * отбор по меткам работает по вчерашней разметке и молча врёт.
 *
 * **Тело НЕ забираем.** Его правит и человек — заметкой из чипа, — и сверка,
 * затирающая тело каждые две минуты, съедала бы заметки. Тело обновляется по
 * кнопке «обновить», где это осознанное решение человека.
 *
 * Возвращаем только изменившееся: лишняя запись поднимает `updatedAt`, а по
 * нему разрешается спор о том, кто двигал задачу позже.
 */
function remoteFields(task, issue) {
  const patch = {}
  if (typeof issue?.title === 'string' && issue.title !== task.title) patch.title = issue.title
  if (Array.isArray(issue?.labels)) {
    const names = issue.labels
      .map((l) => (typeof l === 'string' ? l : l?.name))
      .filter((n) => typeof n === 'string')
    const same = names.length === (task.labels ?? []).length
      && names.every((n) => (task.labels ?? []).includes(n))
    if (!same) patch.labels = names
    // Цвет метки в Gitea меняют реже имени, но меняют: сверка обязана
    // подхватывать и его, иначе карточка красится по позавчерашней палитре.
    const colors = colorsOfIssue(issue.labels)
    const before = task.labelColors ?? {}
    const sameColors = Object.keys(colors).length === Object.keys(before).length
      && Object.entries(colors).every(([k, v]) => before[k] === v)
    if (!sameColors) patch.labelColors = colors
  }
  // Дату заведения тоже подхватываем: карточки, приехавшие до этой правки,
  // помнят день подхвата, и починить их может только сверка.
  const born = issueBornAt(issue)
  if (born !== undefined && born !== task.createdAt) patch.createdAt = born
  const author = issueAuthor(issue)
  if (author !== '' && author !== task.author) patch.author = author
  // Ответственного сверка подхватывает В ОБЕ стороны: назначили в Gitea —
  // видно на доске, сняли — тоже видно.
  if (issue?.assignee !== undefined || Array.isArray(issue?.assignees)) {
    const assignee = issueAssignee(issue)
    if (assignee !== (task.assignee ?? '')) patch.assignee = assignee
  }
  if ('milestone' in (issue ?? {})) {
    const milestone = issueMilestone(issue)
    if (milestone !== (task.milestone ?? '')) patch.milestone = milestone
  }
  return patch
}

/**
 * Свести наблюдения и применить переход, если он нужен.
 *
 * Наблюдённые ветка и PR записываются в карточку независимо от того, случился
 * перевод или нет: это наблюдение о задаче, полезное само по себе.
 *
 * Если обе стороны двигались с последней сверки, побеждает более позднее
 * изменение, а проигравшее ОБЯЗАТЕЛЬНО попадает в журнал задачи. Синхронизация,
 * тихо отменяющая правку человека, хуже отсутствующей: расхождение остаётся, а
 * узнать о нём неоткуда.
 *
 * @returns {object|undefined} применённый переход либо undefined
 */
export function applyObservation({ store, task, observation, issue, remoteUpdatedAt, now = Date.now() }) {
  const patch = { syncedAt: now, ...remoteFields(task, issue) }
  if (observation.branch !== undefined && observation.branch !== task.branch) patch.branch = observation.branch
  store.updateTask(task.id, patch)

  const verdict = resolveConflict({
    localColumn: task.column,
    remoteColumn: observation.column,
    localUpdatedAt: task.updatedAt,
    remoteUpdatedAt: Date.parse(remoteUpdatedAt ?? '') || 0,
    syncedAt: task.syncedAt,
  })

  if (verdict.winner === 'local') {
    // Доска победила, но если Gitea говорил другое — молчать нельзя.
    if (verdict.overridden !== undefined) {
      store.addTransition({
        taskId: task.id,
        fromCol: task.column,
        toCol: task.column,
        source: 'gitea',
        detail: `расхождение: Gitea считает «${verdict.overridden}», доска правилась позже`,
      })
    }
    return undefined
  }
  if (verdict.winner === 'none') return undefined

  const move = resolveTransition(task.column, [
    { column: verdict.column, source: 'gitea', detail: explain(observation) },
  ])
  if (move === undefined) return undefined

  store.moveTask(task.id, { column: move.column })
  store.addTransition({
    taskId: task.id,
    fromCol: task.column,
    toCol: move.column,
    source: move.source,
    detail: verdict.overridden !== undefined
      ? `${move.detail} (перекрыто: на доске было «${verdict.overridden}»)`
      : move.detail,
  })
  return move
}

/**
 * Сверить все задачи, за которыми стоит issue.
 *
 * Ошибка по одной задаче не останавливает остальные: недоступный репозиторий —
 * причина пропустить его до следующей сверки, а не бросить всю доску.
 *
 * Отчёт называет НЕ ТОЛЬКО числа, но и причину первой неудачи: «сверено ноль
 * из пяти» человеку ничего не говорит, а «репозиторий не найден» говорит всё.
 *
 * @returns {{checked: number, moved: number, failed: number,
 *   repos: number, reposFailed: number, problem: {where: string, message: string}|undefined}}
 */
export async function syncAll({ gitea, store, logger, only, now = Date.now() }) {
  const tasks = store.listWatchable().filter((t) => (only ? only(t) : true))
  const byRepo = new Map()
  for (const task of tasks) {
    const key = `${task.owner}/${task.repo}`
    if (!byRepo.has(key)) byRepo.set(key, { owner: task.owner, repo: task.repo, tasks: [] })
    byRepo.get(key).tasks.push(task)
  }

  let checked = 0
  let moved = 0
  let failed = 0
  let reposFailed = 0
  // Первая беда важнее последней: при протухшем токене все репозитории
  // отвалятся одинаково, и показывать надо причину, а не последний по счёту
  // репозиторий.
  let problem
  const note = (where, error) => {
    if (problem === undefined) problem = { where, message: String(error?.message ?? error ?? 'без причины') }
  }

  for (const group of byRepo.values()) {
    let repoState
    try {
      repoState = await readRepo({ gitea, owner: group.owner, repo: group.repo })
    } catch (error) {
      failed += group.tasks.length
      reposFailed += 1
      note(`${group.owner}/${group.repo}`, error)
      logger?.warn?.(`dsh-kanban: репозиторий ${group.owner}/${group.repo} не прочитан: ${error?.message}`)
      continue
    }

    for (const task of group.tasks) {
      checked += 1
      try {
        const issue = await gitea.getIssue({ owner: task.owner, repo: task.repo, index: task.issueNumber })
        const observation = observeTask(task, repoState, issue)
        const applied = applyObservation({
          store, task, observation, issue, remoteUpdatedAt: issue?.updated_at,
        })
        if (applied !== undefined) moved += 1
      } catch (error) {
        failed += 1
        note(`${task.owner}/${task.repo}#${task.issueNumber}`, error)
        logger?.warn?.(`dsh-kanban: задача ${task.id} не сверена: ${error?.message}`)
      }
    }
  }

  return { checked, moved, failed, repos: byRepo.size, reposFailed, problem, at: now }
}

/**
 * Какие репозитории опрашивать.
 *
 * Названные поимённо — их и берём. Пустой список означает ВСЕ репозитории
 * владельца: доска обязана показывать то, что есть в Gitea, а не то, что ей
 * перечислили руками.
 *
 * Из всех берутся только те, где есть открытые задачи. Число приходит в том же
 * ответе, и отсев бесплатен: полсотни запросов впустую каждые две минуты — это
 * не осторожность, а расточительство.
 *
 * @returns {Promise<Array<{owner: string, repo: string}>>}
 */
export async function resolveRepos({ gitea, config, owner }) {
  const named = watchedRepos({ config, owner })
  if (named.length > 0) return named
  if (owner === undefined || owner === '') {
    throw new Error('владелец не определён: назовите организацию в настройках')
  }
  const rows = await gitea.listOrgRepos({ owner })
  return rows
    .filter((r) => r.archived !== true && r.openIssues > 0)
    .map((r) => ({ owner, repo: r.name }))
}

/**
 * Забрать из отслеживаемых репозиториев задачи, которых на доске ещё нет.
 *
 * Отказ по одному репозиторию не останавливает остальные — как и в сверке:
 * недоступный репозиторий это повод пропустить его до следующего прохода, а не
 * бросить всю доску.
 *
 * @returns {{added: number, skipped: number, failed: number, problem: object|undefined}}
 */
export async function intakeAll({ gitea, store, config, owner, logger, only, repos: given }) {
  let added = 0
  let skipped = 0
  let failed = 0
  let problem

  // `only` сужает проход до одного репозитория: событие вебхука говорит про
  // один, и полный обход означал бы обращение ко всем при каждом чихе в любом.
  let repos
  try {
    repos = (given ?? await resolveRepos({ gitea, config, owner }))
      .filter((pair) => (only ? only(pair) : true))
  } catch (error) {
    return {
      added, skipped, failed: 1,
      problem: { where: 'список репозиториев', message: String(error?.message ?? error) },
    }
  }

  for (const pair of repos) {
    let issues
    try {
      issues = await gitea.listIssues({ owner: pair.owner, repo: pair.repo, state: 'open', limit: 50 })
    } catch (error) {
      failed += 1
      if (problem === undefined) {
        problem = { where: `${pair.owner}/${pair.repo}`, message: String(error?.message ?? error) }
      }
      logger?.warn?.(`dsh-kanban: задачи из ${pair.owner}/${pair.repo} не забраны: ${error?.message}`)
      continue
    }

    for (const issue of issues ?? []) {
      const verdict = shouldTake({ store, owner: pair.owner, repo: pair.repo, issue })
      if (!verdict.take) { skipped += 1; continue }
      store.createTask(issueToTask(issue, {
        // Подхват всегда идёт на проектную доску: импорт issue на простую
        // осознанно отвергается (README «Две доски»), и параметра доски здесь
        // нет — он был мёртвым.
        board: 'main', column: 'backlog', owner: pair.owner, repo: pair.repo,
      }))
      added += 1
    }
  }

  return { added, skipped, failed, problem }
}

/**
 * Убрать в архив то, что достояло в «Выполнено» свой срок.
 *
 * Не удаляет: удаление — отдельное решение человека, и оно на доске уже есть.
 * Архив обязан быть обратимым, иначе им не станут пользоваться из страха.
 */
export function archiveOverdue({ store, config, now = Date.now() }) {
  const before = archiveBefore({ now, afterDays: config?.archiveAfterDays })
  if (before === undefined) return { archived: 0 }
  const due = store.listArchivable(before)
  for (const task of due) store.setArchived(task.id, now)
  return { archived: due.length }
}

/**
 * Состояние сверки для показа человеку.
 *
 * Живёт в памяти процесса, а не в базе: это положение текущего запуска, а не
 * свойство задач. После перезапуска честнее сказать «сверки ещё не было», чем
 * показать вчерашний успех как сегодняшний.
 *
 * Неудача НЕ затирает время последнего успеха. Иначе теряется ответ на главный
 * вопрос — когда доска последний раз видела правду.
 */
export function createSyncState() {
  let okAt
  let failedAt
  let problem
  let running = false

  return {
    started() { running = true },

    /** Записать итог прохода. */
    finished(report) {
      running = false
      if (report?.problem === undefined) {
        okAt = report?.at ?? Date.now()
        failedAt = undefined
        problem = undefined
        return
      }
      failedAt = report?.at ?? Date.now()
      problem = report.problem
    },

    /** Сверка не начиналась вовсе — тоже беда, и своя. */
    failedToStart(where, message) {
      running = false
      failedAt = Date.now()
      problem = { where, message: String(message ?? 'без причины') }
    },

    snapshot() {
      return {
        running,
        okAt,
        failedAt,
        problem,
        state: running ? 'running' : problem !== undefined ? 'failed' : okAt !== undefined ? 'ok' : 'never',
      }
    },
  }
}

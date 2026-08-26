// Сверка задач с Gitea и применение автопереходов.
//
// Ни таймера, ни планировщика здесь нет: когда сверять — решает `lib/index.js`.
// Здесь только «сверить вот эти задачи и применить, что выведется». Поэтому
// модуль проверяется тестами с заглушкой клиента, без сети и без ожиданий.

import { deriveColumn, resolveTransition, branchOfTask, pullsOfTask } from './transitions.js'

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
 * Свести наблюдения и применить переход, если он нужен.
 *
 * Наблюдённые ветка и PR записываются в карточку независимо от того, случился
 * перевод или нет: это наблюдение о задаче, полезное само по себе.
 *
 * @returns {object|undefined} применённый переход либо undefined
 */
export function applyObservation({ store, task, observation }) {
  const patch = {}
  if (observation.branch !== undefined && observation.branch !== task.branch) patch.branch = observation.branch
  if (Object.keys(patch).length > 0) store.updateTask(task.id, patch)

  const move = resolveTransition(task.column, [
    { column: observation.column, source: 'gitea', detail: explain(observation) },
  ])
  if (move === undefined) return undefined

  store.moveTask(task.id, { column: move.column })
  store.addTransition({
    taskId: task.id,
    fromCol: task.column,
    toCol: move.column,
    source: move.source,
    detail: move.detail,
  })
  return move
}

/**
 * Сверить все задачи, за которыми стоит issue.
 *
 * Ошибка по одной задаче не останавливает остальные: недоступный репозиторий —
 * причина пропустить его до следующей сверки, а не бросить всю доску.
 *
 * @returns {{checked: number, moved: number, failed: number}}
 */
export async function syncAll({ gitea, store, logger, only }) {
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

  for (const group of byRepo.values()) {
    let repoState
    try {
      repoState = await readRepo({ gitea, owner: group.owner, repo: group.repo })
    } catch (error) {
      failed += group.tasks.length
      logger?.warn?.(`dsh-kanban: репозиторий ${group.owner}/${group.repo} не прочитан: ${error?.message}`)
      continue
    }

    for (const task of group.tasks) {
      checked += 1
      try {
        const issue = await gitea.getIssue({ owner: task.owner, repo: task.repo, index: task.issueNumber })
        const observation = observeTask(task, repoState, issue)
        if (applyObservation({ store, task, observation }) !== undefined) moved += 1
      } catch (error) {
        failed += 1
        logger?.warn?.(`dsh-kanban: задача ${task.id} не сверена: ${error?.message}`)
      }
    }
  }

  return { checked, moved, failed }
}

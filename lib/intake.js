// Архив выполненного и подхват новых задач из Gitea.
//
// Две противоположные заботы в одном месте: одна убирает с доски отработавшее,
// другая приносит новое. Обе решают, ЧТО должно быть на доске, и держать их
// рядом дешевле, чем искать по разным углам, почему карточка появилась или
// пропала.

/** Разбор списка репозиториев из настройки: через запятую, пробелы не в счёт. */
export function parseWatchList(value) {
  return String(value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

/**
 * Репозитории, за которыми следим.
 *
 * Пустая настройка означает «только там, где уже есть задачи» — то самое
 * поведение, что было до подхвата. Это НЕ «следить за всеми»: первый же запуск
 * с незаполненной настройкой залил бы доску всеми открытыми issue организации.
 *
 * @returns {Array<{owner: string, repo: string}>}
 */
export function watchedRepos({ config, owner }) {
  const out = []
  const seen = new Set()
  for (const name of parseWatchList(config?.watchRepos)) {
    // Имя допускается и полное, и короткое: `владелец/репо` либо просто
    // `репо` — тогда владелец берётся общий.
    const at = name.indexOf('/')
    const pair = at > 0
      ? { owner: name.slice(0, at), repo: name.slice(at + 1) }
      : { owner, repo: name }
    if (pair.owner === undefined || pair.owner === '' || pair.repo === '') continue
    const key = `${pair.owner}/${pair.repo}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(pair)
  }
  return out
}

/**
 * Стоит ли заводить карточку под этот issue.
 *
 * @returns {{take: boolean, why: string}} `why` называет причину отказа —
 *   иначе «почему этой задачи нет на доске» превращается в гадание.
 */
export function shouldTake({ store, owner, repo, issue }) {
  const number = issue?.number
  if (typeof number !== 'number') return { take: false, why: 'без номера' }
  // Pull request в Gitea — тоже issue, но работой на доске он не является:
  // он ход работы, а не сама работа.
  if (issue?.pull_request !== undefined && issue?.pull_request !== null) {
    return { take: false, why: 'это pull request' }
  }
  if (issue?.state === 'closed') return { take: false, why: 'issue закрыт' }
  if (store.findTaskByIssue({ owner, repo, issueNumber: number }) !== undefined) {
    return { take: false, why: 'карточка уже есть' }
  }
  if (store.isDismissed({ owner, repo, issueNumber: number })) {
    return { take: false, why: 'карточку удалили — значит видеть её здесь не хотят' }
  }
  return { take: true, why: '' }
}

/**
 * Пора ли задаче в архив.
 *
 * Архивируем ТОЛЬКО из `done`. Задача, застрявшая в ревью на месяц, — это
 * сигнал, а не мусор, и прятать её нельзя.
 *
 * Ноль в настройке отключает самоархивацию: это осознанное «не убирать»,
 * а не пропущенное значение.
 */
export function archiveBefore({ now, afterDays }) {
  const days = Number(afterDays)
  if (!Number.isFinite(days) || days <= 0) return undefined
  return now - days * 24 * 60 * 60 * 1000
}

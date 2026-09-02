// Автоперемещение карточек: вывод колонки из наблюдений и приоритет источников.
//
// Модуль чистый — ни сети, ни хранилища, ни харнесса. Наблюдения приходят
// готовыми, решение возвращается значением. Поэтому вся логика переходов
// проверяется тестами, а места, где она вызывается, остаются тонкими.

/**
 * Приоритет источников. Без него «PR влит → deploy» через секунду перебивалось
 * бы «ход завершился → in-progress», и карточка прыгала бы туда-сюда.
 *
 * Меньше число — сильнее источник.
 */
const PRIORITY = { gitea: 0, tool: 1, session: 2, manual: 3 }

/** Pull request считается черновиком, пока с него не снят признак WIP. */
export function isDraftPull(pull) {
  if (pull?.draft === true) return true
  return /^\s*(wip|draft)\b[:\s-]/i.test(String(pull?.title ?? ''))
}

/**
 * Колонка, которую диктуют наблюдения в Gitea.
 *
 * Порядок проверок идёт от самого позднего состояния к самому раннему: задача
 * не может «вернуться» в in-progress только потому, что ветка ещё цела, если
 * issue уже закрыт.
 *
 * WIP PR намеренно НЕ двигает карточку в review: он открывается рано и означает
 * «работа идёт», а не «смотрите».
 *
 * @param {object} obs наблюдения
 * @param {object} [obs.issue] issue из Gitea (`state`)
 * @param {Array}  [obs.pulls] pull request-ы, связанные с задачей
 * @param {boolean} [obs.branchExists] существует ли ветка задачи
 * @returns {string|undefined} колонка либо undefined, если наблюдения молчат
 */
export function deriveColumn(obs) {
  const issueClosed = obs?.issue?.state === 'closed'
  const pulls = Array.isArray(obs?.pulls) ? obs.pulls : []
  const branchExists = obs?.branchExists === true

  // Задача завершена, только когда cleanup сделан: issue закрыт И ветки нет.
  // Пока ветка цела, работа не закончена, сколько бы issue ни был закрыт.
  if (issueClosed && !branchExists) return 'done'
  if (issueClosed) return 'cleanup'

  if (pulls.some((p) => p?.merged === true || p?.merged_at)) return 'deploy'
  if (pulls.some((p) => p?.state === 'open' && !isDraftPull(p))) return 'review'
  if (branchExists) return 'in-progress'
  return undefined
}

/**
 * Выбрать перевод из нескольких предложений разных источников.
 *
 * Предложение, совпадающее с текущей колонкой, отбрасывается: перевод в ту же
 * колонку — не перевод, а лишняя строка в журнале.
 *
 * @param {string} current текущая колонка
 * @param {Array<{column: string, source: string, detail?: string}>} candidates
 * @returns {{column: string, source: string, detail: string}|undefined}
 */
export function resolveTransition(current, candidates) {
  const usable = (candidates ?? [])
    .filter((c) => c && typeof c.column === 'string' && c.column !== '' && c.column !== current)
    .filter((c) => PRIORITY[c.source] !== undefined)
  if (usable.length === 0) return undefined
  const best = usable.reduce((a, b) => (PRIORITY[a.source] <= PRIORITY[b.source] ? a : b))
  return { column: best.column, source: best.source, detail: best.detail ?? '' }
}

/**
 * Нужен ли человек по событию сессии.
 *
 * Колонки «Блокировано» в согласованном наборе нет, поэтому запрос разрешения и
 * вопрос агента не двигают карточку, а поднимают на ней признак ожидания.
 * Двигать в несуществующую колонку нельзя, а прятать «агент стоит и ждёт» —
 * значит терять главное, ради чего смотрят на доску.
 *
 * @returns {boolean|undefined} true — поднять, false — снять, undefined — событие не про это
 */
export function waitingFromEvent(type) {
  switch (type) {
    case 'approval/asked':
    case 'question/requested':
      return true
    case 'approval/decided':
    case 'turn/start':
    case 'user/message':
      return false
    default:
      return undefined
  }
}

/** Имя ветки, по которому задача узнаёт свою: то, что наблюдалось, либо ничего. */
export function branchOfTask(task, branches) {
  const known = typeof task?.branch === 'string' && task.branch !== '' ? task.branch : undefined
  const names = (branches ?? []).map((b) => (typeof b === 'string' ? b : b?.name)).filter(Boolean)
  if (known !== undefined) return names.includes(known) ? known : undefined

  // Ветку задачи заводит агент и называет как хочет, но номер issue в имени —
  // общее правило воркфлоу. Ищем по номеру, а не по угаданному шаблону.
  if (typeof task?.issueNumber !== 'number') return undefined
  const marker = String(task.issueNumber)
  return names.find((n) => new RegExp(`(^|[^0-9])${marker}([^0-9]|$)`).test(n))
}

/** Pull request-ы, относящиеся к задаче: по ветке либо по упоминанию issue. */
export function pullsOfTask(task, pulls, branch) {
  const number = typeof task?.issueNumber === 'number' ? task.issueNumber : undefined
  return (pulls ?? []).filter((p) => {
    if (branch !== undefined && p?.head?.ref === branch) return true
    if (number === undefined) return false
    const haystack = `${p?.title ?? ''} ${p?.body ?? ''}`
    return new RegExp(`#${number}([^0-9]|$)`).test(haystack)
  })
}

/**
 * Кто победил, когда обе стороны изменились с последней сверки.
 *
 * Правило простое: побеждает более позднее изменение. Важно другое —
 * проигравшая сторона НЕ исчезает молча, а возвращается в поле `overridden`,
 * чтобы вызывающий записал её в журнал задачи. Синхронизация, которая тихо
 * отменяет правку человека, хуже синхронизации, которой нет: расхождение
 * остаётся, а узнать о нём неоткуда.
 *
 * @param {object} state
 * @param {string} state.localColumn колонка на доске
 * @param {string} [state.remoteColumn] колонка, выведенная из Gitea
 * @param {number} state.localUpdatedAt когда правили на доске
 * @param {number} state.remoteUpdatedAt когда правили в Gitea
 * @param {number} state.syncedAt время последней удачной сверки
 * @returns {{winner: 'local'|'remote'|'none', column?: string, overridden?: string}}
 */
export function resolveConflict({ localColumn, remoteColumn, localUpdatedAt, remoteUpdatedAt, syncedAt }) {
  if (remoteColumn === undefined || remoteColumn === null || remoteColumn === '') return { winner: 'local' }
  if (remoteColumn === localColumn) return { winner: 'none' }

  const since = Number(syncedAt) || 0

  // До первой сверки «изменилось с прошлого раза» не имеет смысла: прошлого
  // раза не было. Карточку только что завели или импортировали, защищать в ней
  // нечего, и первая сверка обязана принять положение дел, а не спорить с ним.
  const firstSync = since === 0
  const localChanged = !firstSync && (Number(localUpdatedAt) || 0) > since
  const remoteChanged = firstSync || (Number(remoteUpdatedAt) || 0) > since

  if (localChanged && remoteChanged) {
    // Обе стороны двигались. Побеждает более позднее, проигравшее называется.
    if ((Number(localUpdatedAt) || 0) > (Number(remoteUpdatedAt) || 0)) {
      return { winner: 'local', overridden: remoteColumn }
    }
    return { winner: 'remote', column: remoteColumn, overridden: localColumn }
  }

  // Двигалась только доска — Gitea не имеет права тянуть карточку назад.
  if (localChanged) return { winner: 'local' }

  return { winner: 'remote', column: remoteColumn }
}

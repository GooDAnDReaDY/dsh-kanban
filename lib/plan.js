// План работы агента и состояние задачи.
//
// План получаем ПРЯМО — своим инструментом, а не разбором сообщений агента:
// разбор это гадание, а инструмент `todo_list` принадлежит чужому плагину, и
// опираться на его события значит завести зависимость.
//
// Состояние тоже факт, а не догадка по таймауту. Порог тишины в настройки не
// выносим: он был бы догадкой там, где есть точный признак.

/** Пункты плана дальше этого числа не храним: план — не журнал. */
export const MAX_ITEMS = 50

/** Длиннее этого пункт обрезаем: он едет на карточку в одну строку. */
export const MAX_ITEM_LENGTH = 120

const EMPTY = { items: [], current: 0 }

/** Приведение пункта к строке разумной длины. */
function cleanItem(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > MAX_ITEM_LENGTH ? text.slice(0, MAX_ITEM_LENGTH - 1) + '…' : text
}

/**
 * Разобрать план из хранилища.
 *
 * Испорченное поле не должно ронять чтение всей доски, поэтому любой сбой
 * разбора превращается в пустой план.
 */
export function parsePlan(raw) {
  if (typeof raw !== 'string' || raw === '') return EMPTY
  try {
    const value = JSON.parse(raw)
    const items = Array.isArray(value?.items)
      ? value.items.map(cleanItem).filter((t) => t !== '').slice(0, MAX_ITEMS)
      : []
    return { items, current: clampCurrent(value?.current, items.length) }
  } catch {
    return EMPTY
  }
}

export function serializePlan(plan) {
  return JSON.stringify({ items: plan.items, current: plan.current })
}

/**
 * Указатель на пункт в работе.
 *
 * Ноль означает «плана нет либо он ещё не начат»; значение больше длины плана —
 * «всё сделано», и удерживать его на последнем пункте нельзя: тогда законченный
 * план вечно показывал бы последний пункт как текущий.
 */
function clampCurrent(value, total) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.floor(n), total + 1)
}

/**
 * Наложить правку инструмента на прежний план.
 *
 * Пункты необязательны: агент публикует план один раз, а дальше двигает только
 * указатель. Требовать список на каждом шаге значило бы гонять его целиком ради
 * одного числа.
 */
export function applyPlan(previous, patch) {
  const prev = previous ?? EMPTY
  const items = Array.isArray(patch?.items)
    ? patch.items.map(cleanItem).filter((t) => t !== '').slice(0, MAX_ITEMS)
    : prev.items
  const current = patch?.current === undefined || patch?.current === null
    ? clampCurrent(prev.current, items.length)
    : clampCurrent(patch.current, items.length)
  return { items, current }
}

/**
 * Что показать о плане.
 *
 * Числа и текст пункта отдаём отдельно: строку «3 из 7» собирает браузер, он
 * же её и переводит.
 *
 * @returns {{total: number, done: number, current: number, text: string}|undefined}
 */
export function planProgress(plan) {
  const items = plan?.items ?? []
  if (items.length === 0) return undefined
  const current = clampCurrent(plan?.current, items.length)
  // Всё, что до текущего пункта, считается сделанным. Модель линейная: агент
  // двигает одно число, а не ведёт список галочек.
  const done = current === 0 ? 0 : Math.min(current - 1, items.length)
  const text = current >= 1 && current <= items.length ? items[current - 1] : ''
  return { total: items.length, done, current, text }
}

/** Отметки пунктов для окна карточки. */
export function planItems(plan) {
  const items = plan?.items ?? []
  const current = clampCurrent(plan?.current, items.length)
  return items.map((text, i) => ({
    text,
    done: current > i + 1,
    active: current === i + 1,
  }))
}

/**
 * Состояние задачи.
 *
 * `stopped` — не догадка по тишине, а факт: у задачи записана сессия, но живого
 * агента за ней нет. Так выглядит прерванная работа после перезапуска харнесса.
 *
 * @param {{task: object, live: 'running'|'idle'|undefined}} args
 *   `live` — состояние живого агента; `undefined` означает, что агента нет.
 */
export function taskState({ task, live }) {
  const sessionId = typeof task?.sessionId === 'string' ? task.sessionId : ''
  if (sessionId === '') return 'none'
  // Ожидание человека важнее хода: агент технически «работает», но без ответа
  // не сдвинется, и именно это надо показать.
  if (task?.waiting === true) return 'waiting'
  if (live === undefined) return 'stopped'
  return live === 'running' ? 'running' : 'idle'
}

// Относительное время для доски.
//
// Формат относительный, потому что «третий день» читается мгновенно, а точная
// дата требует чтения и сравнения с сегодняшним числом. Скорость чтения тут и
// есть смысл: на доску смотрят, чтобы за секунду понять, что застряло.
//
// Модуль отдаёт числа и единицу, а не готовую строку: собирает и переводит её
// браузерная половина.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Насколько давно это было.
 *
 * Будущее (расхождение часов между машинами) не выдумываем «через N минут», а
 * считаем настоящим моментом: показывать доске будущее незачем.
 *
 * @returns {{unit: 'now'|'min'|'hour'|'day', value: number}|undefined}
 *   `undefined` — отметки времени нет.
 */
export function relativeParts(now, then) {
  if (typeof then !== 'number' || !Number.isFinite(then) || then <= 0) return undefined
  const delta = Math.max(0, now - then)
  if (delta < MINUTE) return { unit: 'now', value: 0 }
  if (delta < HOUR) return { unit: 'min', value: Math.floor(delta / MINUTE) }
  if (delta < DAY) return { unit: 'hour', value: Math.floor(delta / HOUR) }
  return { unit: 'day', value: Math.floor(delta / DAY) }
}

/**
 * Пора ли тревожиться о молчании задачи.
 *
 * Отдельного опроса живости сессий не заводим: это второй источник правды и
 * лишняя нагрузка. Смотрим на то, что и так знаем, — когда задачу последний
 * раз трогали.
 */
export function isStale({ now, updatedAt, sessionId, afterMinutes }) {
  const limit = Number(afterMinutes)
  if (!Number.isFinite(limit) || limit <= 0) return false
  if (typeof sessionId !== 'string' || sessionId === '') return false
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return false
  return now - updatedAt >= limit * MINUTE
}

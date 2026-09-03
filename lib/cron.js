// dsh-kanban: парсер 5-позиционного cron и вычисление следующего запуска.
// Без внешних зависимостей: чистые функции над датами и числами.

const FIELD_RANGES = [
  [0, 59], // минуты
  [0, 23], // часы
  [1, 31], // дни месяца
  [1, 12], // месяцы
  [0, 7],  // дни недели (0 и 7 — воскресенье)
]

function parseField(token, min, max, targetSet) {
  if (token === '*') {
    for (let i = min; i <= max; i++) targetSet.add(i)
    return true
  }

  for (const part of token.split(',')) {
    if (part === '') return false

    if (part.includes('/')) {
      const [rangePart, stepStr] = part.split('/')
      const step = Number(stepStr)
      if (!Number.isInteger(step) || step <= 0) return false

      let start = min
      let end = max
      if (rangePart !== '*' && rangePart !== '') {
        if (rangePart.includes('-')) {
          const [sStr, eStr] = rangePart.split('-')
          start = Number(sStr)
          end = Number(eStr)
        } else {
          start = Number(rangePart)
          end = max
        }
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        return false
      }
      for (let i = start; i <= end; i += step) targetSet.add(i)
      continue
    }

    if (part.includes('-')) {
      const [sStr, eStr] = part.split('-')
      const start = Number(sStr)
      const end = Number(eStr)
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        return false
      }
      for (let i = start; i <= end; i++) targetSet.add(i)
      continue
    }

    const val = Number(part)
    if (!Number.isInteger(val) || val < min || val > max) return false
    targetSet.add(val)
  }

  return targetSet.size > 0
}

/**
 * Разобрать 5-позиционное выражение cron: "минута час день месяц день_недели".
 * @param {string} expr 
 * @returns {object|null} распарсенное расписание или null, если выражение невалидно
 */
export function parseCron(expr) {
  if (typeof expr !== 'string') return null
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null

  const sets = []
  for (let index = 0; index < 5; index++) {
    const [min, max] = FIELD_RANGES[index]
    const set = new Set()
    if (!parseField(fields[index], min, max, set)) return null
    sets.push(set)
  }

  const weekdays = new Set()
  for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day)

  return {
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays,
    dayWildcard: fields[2] === '*',
    weekdayWildcard: fields[4] === '*',
  }
}

/**
 * Вычислить время следующего запуска (в миллисекундах epoch) строго после `fromMs`.
 * Поиск ограничен 5 годами вперед, чтобы избежать бесконечного цикла.
 * @param {string|object} exprOrSchedule 
 * @param {number} [fromMs] 
 * @returns {number|undefined} время следующего запуска или undefined
 */
export function computeNextRun(exprOrSchedule, fromMs = Date.now()) {
  const schedule = typeof exprOrSchedule === 'string' ? parseCron(exprOrSchedule) : exprOrSchedule
  if (!schedule) return undefined

  // Стартуем со следующей целой минуты
  const current = new Date(fromMs)
  current.setSeconds(0, 0)
  current.setMinutes(current.getMinutes() + 1)

  const limitMs = fromMs + 5 * 365 * 24 * 60 * 60 * 1000

  while (current.getTime() <= limitMs) {
    const month = current.getMonth() + 1
    if (!schedule.months.has(month)) {
      current.setMonth(current.getMonth() + 1, 1)
      current.setHours(0, 0, 0, 0)
      continue
    }

    const dayOfMonth = current.getDate()
    const dayOfWeek = current.getDay()
    const dayMatches = schedule.dayWildcard && schedule.weekdayWildcard
      ? true
      : schedule.dayWildcard
        ? schedule.weekdays.has(dayOfWeek)
        : schedule.weekdayWildcard
          ? schedule.days.has(dayOfMonth)
          : schedule.days.has(dayOfMonth) || schedule.weekdays.has(dayOfWeek)

    if (!dayMatches) {
      current.setDate(current.getDate() + 1)
      current.setHours(0, 0, 0, 0)
      continue
    }

    const hour = current.getHours()
    if (!schedule.hours.has(hour)) {
      current.setHours(current.getHours() + 1, 0, 0, 0)
      continue
    }

    const minute = current.getMinutes()
    if (!schedule.minutes.has(minute)) {
      current.setMinutes(current.getMinutes() + 1)
      continue
    }

    return current.getTime()
  }

  return undefined
}

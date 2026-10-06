// dsh-kanban: 5-position cron parser and next run calculator.
// Zero dependencies: pure functions over dates and numbers.

const FIELD_RANGES = [
  [0, 59], // minutes
  [0, 23], // hours
  [1, 31], // days of month
  [1, 12], // months
  [0, 7],  // days of week (0 and 7 are Sunday)
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
 * Parse 5-position cron expression: "minute hour day month day_of_week".
 * @param {string} expr 
 * @returns {object|null} parsed schedule or null if expression is invalid
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
 * Calculate next run timestamp (epoch ms) strictly after `fromMs`.
 * Search capped at 5 years forward to prevent infinite loops.
 * @param {string|object} exprOrSchedule 
 * @param {number} [fromMs] 
 * @returns {number|undefined} next run timestamp or undefined
 */
export function computeNextRun(exprOrSchedule, fromMs = Date.now()) {
  const schedule = typeof exprOrSchedule === 'string' ? parseCron(exprOrSchedule) : exprOrSchedule
  if (!schedule) return undefined

  // Start at next whole minute
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

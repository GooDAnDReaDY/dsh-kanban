// Метрики доски: взгляд на журнал переходов, а не новые данные.
//
// Журнал копится с первого дня, но прочитать его можно было только по одной
// задаче. Вопросы «где затык», «сколько живёт задача» и «что лежит месяц» имеют
// ответ в тех же записях — их надо только сложить.
//
// Ничего не записываем: метрика, которая пишет, перестаёт быть наблюдением и
// становится ещё одним источником правды, расходящимся с журналом.

/**
 * Сколько времени задача пробыла в каждой колонке.
 *
 * Переход закрывает предыдущий отрезок и открывает следующий. Последний
 * отрезок закрывается «сейчас»: задача всё ещё лежит там, и это время идёт.
 *
 * @param {Array<{toCol: string, at: number}>} moves переходы задачи, старые первыми
 * @param {number} bornAt когда задача заведена — начало первого отрезка
 * @param {number} now
 * @returns {Object<string, number>} колонка → миллисекунды
 */
export function timeInColumns(moves, bornAt, now) {
  const rows = (moves ?? [])
    .filter((m) => typeof m?.at === 'number' && typeof m?.toCol === 'string')
    .slice()
    .sort((a, b) => a.at - b.at)

  const out = {}
  // До первого перехода задача лежит там, где её завели. Колонку начала берём
  // из первого перехода: `fromCol` и есть то, откуда она уехала.
  let col = rows.length > 0 && typeof rows[0].fromCol === 'string' ? rows[0].fromCol : 'backlog'
  let since = typeof bornAt === 'number' ? bornAt : (rows[0]?.at ?? now)

  const add = (where, ms) => {
    if (ms <= 0) return
    out[where] = (out[where] ?? 0) + ms
  }

  for (const move of rows) {
    add(col, move.at - since)
    col = move.toCol
    since = move.at
  }
  add(col, now - since)
  return out
}

/** Медиана: половина значений меньше, половина больше. */
export function median(values) {
  const rows = (values ?? []).filter((x) => typeof x === 'number').slice().sort((a, b) => a - b)
  if (rows.length === 0) return 0
  const mid = Math.floor(rows.length / 2)
  return rows.length % 2 === 1 ? rows[mid] : Math.round((rows[mid - 1] + rows[mid]) / 2)
}

/** Среднее; пустой набор даёт ноль, а не деление на ноль. */
export function mean(values) {
  const rows = (values ?? []).filter((x) => typeof x === 'number')
  if (rows.length === 0) return 0
  return Math.round(rows.reduce((sum, x) => sum + x, 0) / rows.length)
}

/**
 * Сводка по колонкам: сколько в среднем и по медиане в них лежат.
 *
 * Медиана важнее среднего: одна задача, забытая на полгода, сдвигает среднее
 * так, что оно перестаёт описывать хоть что-нибудь.
 *
 * @param {Array<{task: object, moves: object[]}>} rows
 * @returns {Array<{column: string, mean: number, median: number, tasks: number}>}
 */
export function columnStats(rows, now) {
  const byColumn = new Map()
  for (const row of rows ?? []) {
    const spent = timeInColumns(row.moves, row.task?.createdAt, now)
    for (const [column, ms] of Object.entries(spent)) {
      if (!byColumn.has(column)) byColumn.set(column, [])
      byColumn.get(column).push(ms)
    }
  }
  return [...byColumn.entries()]
    .map(([column, values]) => ({
      column,
      mean: mean(values),
      median: median(values),
      tasks: values.length,
    }))
    .sort((a, b) => b.median - a.median)
}

/**
 * Задачи, залежавшиеся в своей колонке дольше порога.
 *
 * Считаем от входа в колонку, а не от заведения: задача может быть старой и
 * при этом двигаться каждый день.
 *
 * @returns {Array<{id: string, title: string, column: string, since: number}>}
 */
export function stale(tasks, now, thresholdMs) {
  if (!(thresholdMs > 0)) return []
  return (tasks ?? [])
    .filter((task) => {
      const at = typeof task?.columnAt === 'number' && task.columnAt > 0 ? task.columnAt : task?.createdAt
      return typeof at === 'number' && now - at >= thresholdMs
    })
    .map((task) => ({
      id: task.id,
      title: task.title,
      column: task.column,
      since: (typeof task.columnAt === 'number' && task.columnAt > 0 ? task.columnAt : task.createdAt),
    }))
    .sort((a, b) => a.since - b.since)
}

/**
 * Сколько задач доехало до «Выполнено» за период.
 *
 * Считаем по переходам, а не по текущей колонке: задача, ушедшая в архив,
 * всё равно была сделана.
 */
export function doneWithin(rows, from, to) {
  let count = 0
  for (const row of rows ?? []) {
    const hit = (row.moves ?? []).some((m) => m?.toCol === 'done' && m.at >= from && m.at <= to)
    if (hit) count += 1
  }
  return count
}

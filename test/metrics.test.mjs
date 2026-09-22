// Метрики доски: арифметика поверх журнала переходов.
import test from 'node:test'
import assert from 'node:assert/strict'

import { columnStats, doneWithin, mean, median, stale, timeInColumns } from '../lib/metrics.js'
import { boardMetrics } from '../lib/routes.js'
import { freshStore } from './helpers.mjs'

const MIN = 60_000
const DAY = 24 * 60 * MIN
const NOW = 1_800_000_000_000

test('время в колонке считается по переходам', () => {
  const spent = timeInColumns([
    { fromCol: 'backlog', toCol: 'in-progress', at: NOW - 3 * DAY },
    { fromCol: 'in-progress', toCol: 'review', at: NOW - 1 * DAY },
  ], NOW - 5 * DAY, NOW)
  assert.equal(spent.backlog, 2 * DAY)
  assert.equal(spent['in-progress'], 2 * DAY)
  assert.equal(spent.review, 1 * DAY, 'последний отрезок идёт до «сейчас»')
})

test('задача без переходов лежит в бэклоге со дня заведения', () => {
  // Иначе доска не знала бы ничего о задачах, которые никто не трогал, —
  // а это и есть самые залежавшиеся.
  const spent = timeInColumns([], NOW - 10 * DAY, NOW)
  assert.deepEqual(spent, { backlog: 10 * DAY })
})

test('переходы в обратном порядке не ломают счёт', () => {
  const spent = timeInColumns([
    { fromCol: 'in-progress', toCol: 'done', at: NOW - DAY },
    { fromCol: 'backlog', toCol: 'in-progress', at: NOW - 2 * DAY },
  ], NOW - 3 * DAY, NOW)
  assert.equal(spent.backlog, DAY)
  assert.equal(spent['in-progress'], DAY)
  assert.equal(spent.done, DAY)
})

test('медиана важнее среднего и считается честно', () => {
  // Одна задача, забытая на полгода, сдвигает среднее так, что оно перестаёт
  // описывать хоть что-нибудь; медиана этого не делает.
  assert.equal(median([1, 2, 3]), 2)
  assert.equal(median([1, 2, 3, 5]), 3)
  assert.equal(median([]), 0)
  assert.equal(mean([2, 4]), 3)
  assert.equal(mean([]), 0, 'пустой набор не делит на ноль')
})

test('сводка по колонкам ставит долгие первыми', () => {
  const rows = [
    { task: { createdAt: NOW - 10 * DAY }, moves: [{ fromCol: 'backlog', toCol: 'review', at: NOW - DAY }] },
    { task: { createdAt: NOW - 2 * DAY }, moves: [{ fromCol: 'backlog', toCol: 'review', at: NOW - DAY }] },
  ]
  const out = columnStats(rows, NOW)
  assert.equal(out[0].column, 'backlog', 'где стоит работа — то и первым')
  assert.equal(out[0].tasks, 2)
  assert.equal(out[0].median, 5 * DAY)
  assert.equal(out.find((x) => x.column === 'review').tasks, 2)
})

test('залежавшиеся считаются от входа в колонку, а не от заведения', () => {
  // Задача может быть старой и при этом двигаться каждый день.
  const tasks = [
    { id: 'старая-но-живая', title: 'A', column: 'review', createdAt: NOW - 100 * DAY, columnAt: NOW - DAY },
    { id: 'залежалась', title: 'B', column: 'backlog', createdAt: NOW - 30 * DAY, columnAt: NOW - 20 * DAY },
  ]
  const out = stale(tasks, NOW, 14 * DAY)
  assert.deepEqual(out.map((x) => x.id), ['залежалась'])
})

test('нулевой порог не объявляет залежавшимися всех', () => {
  assert.deepEqual(stale([{ id: 'a', columnAt: NOW }], NOW, 0), [])
})

test('сделанное считается по переходам, а не по текущей колонке', () => {
  // Задача, уехавшая в архив, всё равно была сделана.
  const rows = [
    { task: {}, moves: [{ toCol: 'done', at: NOW - 2 * DAY }] },
    { task: {}, moves: [{ toCol: 'done', at: NOW - 40 * DAY }] },
    { task: {}, moves: [{ toCol: 'review', at: NOW - DAY }] },
  ]
  assert.equal(doneWithin(rows, NOW - 7 * DAY, NOW), 1)
  assert.equal(doneWithin(rows, NOW - 60 * DAY, NOW), 2)
})

test('метрики собираются на живом хранилище', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.moveTask(a.id, { column: 'in-progress' })
  store.addTransition({ taskId: a.id, fromCol: 'backlog', toCol: 'in-progress', source: 'manual' })

  const out = boardMetrics({ store, board: 'main', now: Date.now(), staleDays: 14 })
  assert.equal(out.tasks, 1)
  assert.ok(out.columns.length >= 1)
  assert.equal(out.staleDays, 14)
  assert.deepEqual(out.stale, [], 'свежая задача залежавшейся не считается')
  assert.equal(typeof out.done.week, 'number')
  cleanup()
})

test('пустая доска даёт пустую сводку, а не отказ', () => {
  const { store, cleanup } = freshStore()
  const out = boardMetrics({ store, board: 'main', now: Date.now() })
  assert.equal(out.tasks, 0)
  assert.deepEqual(out.columns, [])
  assert.equal(out.done.month, 0)
  cleanup()
})

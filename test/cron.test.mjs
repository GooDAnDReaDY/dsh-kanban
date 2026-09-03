import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, computeNextRun } from '../lib/cron.js'

test('parseCron корректно разбирает стандартные выражения', () => {
  const everyMinute = parseCron('* * * * *')
  assert.ok(everyMinute)
  assert.equal(everyMinute.minutes.size, 60)
  assert.equal(everyMinute.hours.size, 24)
  assert.equal(everyMinute.days.size, 31)
  assert.equal(everyMinute.months.size, 12)
  assert.equal(everyMinute.weekdays.size, 7)
  assert.equal(everyMinute.dayWildcard, true)
  assert.equal(everyMinute.weekdayWildcard, true)

  const steps = parseCron('*/15 9-17 1,15 * 1-5')
  assert.ok(steps)
  assert.deepEqual([...steps.minutes], [0, 15, 30, 45])
  assert.equal(steps.hours.size, 9) // 9,10,11,12,13,14,15,16,17
  assert.deepEqual([...steps.days], [1, 15])
  assert.equal(steps.months.size, 12)
  assert.deepEqual([...steps.weekdays], [1, 2, 3, 4, 5])
  assert.equal(steps.dayWildcard, false)
  assert.equal(steps.weekdayWildcard, false)
})

test('parseCron поддерживает 0 и 7 как воскресенье', () => {
  const sunday0 = parseCron('0 0 * * 0')
  const sunday7 = parseCron('0 0 * * 7')
  assert.ok(sunday0)
  assert.ok(sunday7)
  assert.deepEqual([...sunday0.weekdays], [0])
  assert.deepEqual([...sunday7.weekdays], [0])
})

test('parseCron отвергает невалидные строки', () => {
  assert.equal(parseCron(''), null)
  assert.equal(parseCron(null), null)
  assert.equal(parseCron('* * * *'), null) // 4 поля
  assert.equal(parseCron('* * * * * *'), null) // 6 полей
  assert.equal(parseCron('60 * * * *'), null) // минута 60 вне диапазона
  assert.equal(parseCron('* 24 * * *'), null) // час 24 вне диапазона
  assert.equal(parseCron('*/0 * * * *'), null) // шаг 0
  assert.equal(parseCron('5-2 * * * *'), null) // диапазон наоборот
  assert.equal(parseCron('abc * * * *'), null) // буквы
})

test('computeNextRun вычисляет следующее время запуска', () => {
  // Фиксируем базовую дату: 2026-09-03 14:30:15
  const base = new Date(2026, 8, 3, 14, 30, 15).getTime()

  // Каждые 15 минут -> 14:45:00
  const next15 = computeNextRun('*/15 * * * *', base)
  const d15 = new Date(next15)
  assert.equal(d15.getFullYear(), 2026)
  assert.equal(d15.getMonth(), 8)
  assert.equal(d15.getDate(), 3)
  assert.equal(d15.getHours(), 14)
  assert.equal(d15.getMinutes(), 45)
  assert.equal(d15.getSeconds(), 0)

  // Каждый день в 09:00 -> 2026-09-04 09:00:00
  const nextDaily = computeNextRun('0 9 * * *', base)
  const dDaily = new Date(nextDaily)
  assert.equal(dDaily.getDate(), 4)
  assert.equal(dDaily.getHours(), 9)
  assert.equal(dDaily.getMinutes(), 0)

  // Невалидное выражение даёт undefined
  assert.equal(computeNextRun('invalid', base), undefined)
})

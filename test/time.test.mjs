// Время на доске: относительный формат, время в колонке, порог молчания.
import test from 'node:test'
import assert from 'node:assert/strict'

import { relativeParts, isStale } from '../lib/time.js'
import { buildBoard } from '../lib/routes.js'
import { withDefaults } from '../lib/config.js'
import { freshStore, reopenStore } from './helpers.mjs'
import { loadClient } from './client-load.mjs'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const config = withDefaults({})
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = 1_700_000_000_000

test('единицы выбираются по величине промежутка', () => {
  assert.deepEqual(relativeParts(NOW, NOW), { unit: 'now', value: 0 })
  assert.deepEqual(relativeParts(NOW, NOW - 59_000), { unit: 'now', value: 0 })
  assert.deepEqual(relativeParts(NOW, NOW - 5 * MIN), { unit: 'min', value: 5 })
  assert.deepEqual(relativeParts(NOW, NOW - 3 * HOUR), { unit: 'hour', value: 3 })
  assert.deepEqual(relativeParts(NOW, NOW - 3 * DAY), { unit: 'day', value: 3 })
})

test('границы единиц не проваливаются', () => {
  assert.equal(relativeParts(NOW, NOW - MIN).unit, 'min')
  assert.equal(relativeParts(NOW, NOW - HOUR).unit, 'hour')
  assert.equal(relativeParts(NOW, NOW - DAY).unit, 'day')
})

test('будущее считается настоящим моментом', () => {
  // Часы машин расходятся, и «через 5 минут» на доске — чушь, а не сведение.
  assert.deepEqual(relativeParts(NOW, NOW + HOUR), { unit: 'now', value: 0 })
})

test('нечитаемая отметка времени не показывается вовсе', () => {
  for (const wrong of [undefined, null, 0, -1, NaN, 'вчера']) {
    assert.equal(relativeParts(NOW, wrong), undefined, String(wrong))
  }
})

// ------------------------------------------------- порог молчания

test('задача молчит дольше порога', () => {
  assert.equal(isStale({ now: NOW, updatedAt: NOW - 2 * HOUR, sessionId: 's', afterMinutes: 60 }), true)
  assert.equal(isStale({ now: NOW, updatedAt: NOW - 10 * MIN, sessionId: 's', afterMinutes: 60 }), false)
})

test('ровно на пороге уже молчит', () => {
  assert.equal(isStale({ now: NOW, updatedAt: NOW - HOUR, sessionId: 's', afterMinutes: 60 }), true)
})

test('задача без сессии молчащей не бывает', () => {
  // Ей просто некому отвечать, и тревожная отметка была бы враньём.
  assert.equal(isStale({ now: NOW, updatedAt: NOW - 10 * DAY, sessionId: '', afterMinutes: 60 }), false)
})

test('нулевой и негодный порог отключают отметку', () => {
  for (const limit of [0, -5, undefined, 'час']) {
    assert.equal(isStale({ now: NOW, updatedAt: NOW - 10 * DAY, sessionId: 's', afterMinutes: limit }), false)
  }
})

// ------------------------------------------------- время в колонке

test('карточка помнит, когда попала в колонку', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  assert.ok(store.getTask(task.id).columnAt > 0)
  cleanup()
})

test('перестановка внутри колонки отметку не сбрасывает', () => {
  // Задача в ревью третий день там и остаётся, как бы её ни двигали вверх-вниз.
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'review', title: 'A' })
  const was = store.getTask(task.id).columnAt
  store.moveTask(task.id, { column: 'review' })
  assert.equal(store.getTask(task.id).columnAt, was)
  cleanup()
})

test('переезд в другую колонку отметку обновляет', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  const was = store.getTask(task.id).columnAt
  store.moveTask(task.id, { column: 'review' })
  assert.ok(store.getTask(task.id).columnAt >= was)
  cleanup()
})

test('карточки прежних версий получают отметку от заведения', () => {
  // База, созданная версией без столбца columnAt: ноль читался бы как
  // «в 1970 году», а это хуже отсутствия сведения. Схему пишем руками — иначе
  // проверять миграцию нечем, хранилище старых столбцов уже не заводит.
  const dir = mkdtempSync(join(tmpdir(), 'kanban-old-'))
  const old = new DatabaseSync(join(dir, 'kanban.db'))
  old.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, board TEXT NOT NULL, col TEXT NOT NULL, position TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', owner TEXT, repo TEXT,
    issueNumber INTEGER, issueUrl TEXT, labels TEXT NOT NULL DEFAULT '[]',
    branch TEXT, worktree TEXT, sessionId TEXT, model TEXT, provider TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`)
  old.exec(`INSERT INTO tasks (id, board, col, position, title, createdAt, updatedAt)
    VALUES ('t1', 'main', 'review', 'a', 'старая', 1500000000000, 1500000000000)`)
  old.close()

  const store = reopenStore(dir)
  const row = store.getTask('t1')
  assert.equal(row.columnAt, row.createdAt)
  assert.equal(row.createdAt, 1500000000000)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------- ответ доски

test('доска отдаёт своё «сейчас» и признак молчания', () => {
  // Порог живёт в настройках, а настройки — на хосте: отдавать браузеру ещё и
  // порог значило бы отдавать ему решение.
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  store.updateTask(task.id, { sessionId: 's1' })

  const board = buildBoard({ store, config })
  assert.equal(typeof board.now, 'number')
  assert.equal(board.tasks.find((x) => x.id === task.id).stale, false, 'свежая задача помечена молчащей')
  cleanup()
})

// ------------------------------------------------- строка в браузере

test('строка времени собирается по тем же правилам', () => {
  const h = loadClient().exported.helpers
  const t = (key, vars) => (vars ? key + ':' + vars.n : key)
  assert.equal(h.agoText(NOW, NOW - 30_000, t), 'time.now')
  assert.equal(h.agoText(NOW, NOW - 5 * MIN, t), 'time.min:5')
  assert.equal(h.agoText(NOW, NOW - 3 * HOUR, t), 'time.hour:3')
  assert.equal(h.agoText(NOW, NOW - 3 * DAY, t), 'time.day:3')
})

test('без отметки строка пустая, а не «только что»', () => {
  const h = loadClient().exported.helpers
  const t = (key) => key
  assert.equal(h.agoText(NOW, undefined, t), '')
  assert.equal(h.agoText(NOW, 0, t), '')
})

test('подсказка с точной датой пустеет на негодной отметке', () => {
  const h = loadClient().exported.helpers
  assert.notEqual(h.exactAt(NOW), '')
  assert.equal(h.exactAt(0), '')
  assert.equal(h.exactAt(undefined), '')
})

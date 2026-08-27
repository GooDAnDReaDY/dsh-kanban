import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers.mjs'
import { withDefaults } from '../lib/config.js'
import {
  buildBoard, applyMove, createTask, updateTask, deleteTask, taskLog,
  taskBySession, isTrustedRequest, parseTaskPath,
} from '../lib/routes.js'

const config = withDefaults({})

test('buildBoard отдаёт колонки в порядке воркфлоу', () => {
  const { store, cleanup } = freshStore()
  const out = buildBoard({ store, config, board: 'main' })
  assert.deepEqual(out.columns.map((c) => c.id),
    ['backlog', 'in-progress', 'review', 'deploy', 'cleanup', 'done'])
  assert.equal(out.columns.find((c) => c.id === 'in-progress').limit, 3)
  assert.equal(out.columns.find((c) => c.id === 'backlog').limit, undefined)
  assert.deepEqual(out.tasks, [])
  cleanup()
})

test('buildBoard считает карточки по колонкам', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.createTask({ board: 'main', column: 'backlog', title: 'B' })
  store.createTask({ board: 'main', column: 'review', title: 'C' })
  const out = buildBoard({ store, config, board: 'main' })
  assert.equal(out.columns.find((c) => c.id === 'backlog').count, 2)
  assert.equal(out.columns.find((c) => c.id === 'review').count, 1)
  cleanup()
})

test('фильтр repo отбирает задачи одного репозитория', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'one' })
  store.createTask({ board: 'main', column: 'backlog', title: 'B', owner: 'o', repo: 'two' })
  const out = buildBoard({ store, config, board: 'main', repo: 'one' })
  assert.deepEqual(out.tasks.map((t) => t.title), ['A'])
  cleanup()
})

test('превышение предела помечается, но не запрещается', () => {
  const { store, cleanup } = freshStore()
  const tight = withDefaults({ wipInProgress: 1 })
  store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  const b = store.createTask({ board: 'main', column: 'backlog', title: 'B' })
  const out = applyMove({ store, config: tight, id: b.id, column: 'in-progress' })
  assert.equal(out.task.column, 'in-progress')
  assert.equal(out.overLimit, true)
  cleanup()
})

test('перенос внутри колонки не пишет переход', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  const b = store.createTask({ board: 'main', column: 'backlog', title: 'B' })
  applyMove({ store, config, id: b.id, column: 'backlog', beforeId: a.id })
  assert.equal(store.listTransitions(b.id).length, 0)
  cleanup()
})

test('перенос в другую колонку пишет переход с источником', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  applyMove({ store, config, id: a.id, column: 'review' })
  const log = store.listTransitions(a.id)
  assert.equal(log.length, 1)
  assert.equal(log[0].fromCol, 'backlog')
  assert.equal(log[0].toCol, 'review')
  assert.equal(log[0].source, 'manual')
  cleanup()
})

test('перенос несуществующей задачи отдаёт 404, а не падает', () => {
  const { store, cleanup } = freshStore()
  const out = applyMove({ store, config, id: 'нет-такой', column: 'done' })
  assert.equal(out.status, 404)
  assert.equal(out.error, 'task-not-found')
  cleanup()
})

test('своя задача создаётся с заголовком', () => {
  const { store, cleanup } = freshStore()
  const out = createTask({ store, input: { title: '  Прибраться в логах  ', labels: ['chore', 7] } })
  assert.equal(out.task.title, 'Прибраться в логах')
  assert.deepEqual(out.task.labels, ['chore'])
  assert.equal(out.task.column, 'backlog')
  cleanup()
})

test('задача без заголовка отвергается', () => {
  const { store, cleanup } = freshStore()
  assert.equal(createTask({ store, input: { title: '   ' } }).status, 400)
  assert.equal(createTask({ store, input: {} }).status, 400)
  cleanup()
})

test('неизвестная колонка при создании откатывается в backlog', () => {
  const { store, cleanup } = freshStore()
  const out = createTask({ store, input: { title: 'A', column: 'нет-такой' } })
  assert.equal(out.task.column, 'backlog')
  cleanup()
})

test('правка меняет заголовок и метки, но не колонку', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'review', title: 'Старый' })
  const out = updateTask({ store, id: a.id, input: { title: 'Новый', labels: ['bug'], column: 'done' } })
  assert.equal(out.task.title, 'Новый')
  assert.deepEqual(out.task.labels, ['bug'])
  assert.equal(out.task.column, 'review')
  cleanup()
})

test('правка несуществующей задачи отдаёт 404', () => {
  const { store, cleanup } = freshStore()
  assert.equal(updateTask({ store, id: 'нет', input: { title: 'A' } }).status, 404)
  assert.equal(deleteTask({ store, id: 'нет' }).status, 404)
  assert.equal(taskLog({ store, id: 'нет' }).status, 404)
  cleanup()
})

test('журнал задачи читается через маршрут', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  applyMove({ store, config, id: a.id, column: 'in-progress' })
  assert.equal(taskLog({ store, id: a.id }).transitions.length, 1)
  cleanup()
})

test('задача по сессии: отсутствие — штатный ответ null', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.updateTask(a.id, { sessionId: 'kanban-1-abc' })
  assert.equal(taskBySession({ store, sessionId: 'kanban-1-abc' }).task.id, a.id)
  assert.equal(taskBySession({ store, sessionId: 'msgw-xyz' }).task, null)
  cleanup()
})

test('правка с чужого сайта отклоняется', () => {
  assert.equal(isTrustedRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isTrustedRequest({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
  assert.equal(isTrustedRequest({ headers: {} }), true)
  assert.equal(isTrustedRequest(undefined), true)
})

test('путь задачи разбирается вместе с действием', () => {
  assert.deepEqual(parseTaskPath('/dsh-kanban/task/abc'), { id: 'abc', action: undefined })
  assert.deepEqual(parseTaskPath('/dsh-kanban/task/abc/move'), { id: 'abc', action: 'move' })
  assert.deepEqual(parseTaskPath('/dsh-kanban/task/abc/log'), { id: 'abc', action: 'log' })
  assert.deepEqual(parseTaskPath('/dsh-kanban/task/abc/message'), { id: 'abc', action: 'message' })
  assert.equal(parseTaskPath('/dsh-kanban/board'), undefined)
  assert.equal(parseTaskPath('/dsh-kanban/task/'), undefined)
})

test('идентификатор задачи в пути раскодируется', () => {
  assert.equal(parseTaskPath('/dsh-kanban/task/a%2Fb').id, 'a/b')
})

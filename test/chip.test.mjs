import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers.mjs'
import { taskBySession } from '../lib/routes.js'
import { loadClient, stubCtx } from './client-load.mjs'

const { exported } = loadClient()
const h = exported.helpers

test('идентификатор сессии берётся из свойства', () => {
  assert.equal(h.chipSessionId({ sessionId: 'kanban-1-abc' }, null), 'kanban-1-abc')
})

test('идентификатор сессии берётся из объекта сессии', () => {
  assert.equal(h.chipSessionId({}, { id: 'kanban-2-def' }), 'kanban-2-def')
  assert.equal(h.chipSessionId({}, { sessionId: 'kanban-3-ghi' }), 'kanban-3-ghi')
})

test('свойство сильнее объекта сессии', () => {
  assert.equal(h.chipSessionId({ sessionId: 'явный' }, { id: 'из-сессии' }), 'явный')
})

test('без сессии идентификатор пуст, а не undefined', () => {
  assert.equal(h.chipSessionId({}, null), '')
  assert.equal(h.chipSessionId(undefined, undefined), '')
})

test('чип регистрируется в шапке чата', () => {
  const { ctx, registered } = stubCtx({
    available: ['settings.plugin.item', 'app.section', 'conversation.session.header.utilities'],
  })
  exported.apply(ctx)
  const chip = registered.find((e) => e.id === '@goodandready/dsh-kanban.chip')
  assert.ok(chip, 'чип не зарегистрирован')
  assert.equal(chip.name, 'conversation.session.header.utilities')
  assert.equal(chip.locale, 'dsh-kanban', 'без locale компонент не получит props.t')
})

test('отсутствие слота шапки не роняет плагин', () => {
  const { ctx } = stubCtx({ available: ['settings.plugin.item'] })
  assert.doesNotThrow(() => exported.apply(ctx))
})

test('сессия с доски находит свою задачу', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  store.updateTask(task.id, { sessionId: 'kanban-live-1' })
  assert.equal(taskBySession({ store, sessionId: 'kanban-live-1' }).task.id, task.id)
  cleanup()
})

test('обычный чат задачи не получает — это штатный ответ', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  assert.equal(taskBySession({ store, sessionId: 'msgw-xyz' }).task, null)
  assert.equal(taskBySession({ store, sessionId: '' }).task, null)
  cleanup()
})

// Виды досок: проектная на шесть колонок и простая на четыре.
import test from 'node:test'
import assert from 'node:assert/strict'

import { columnsOf, normalizeKind, BOARD_KINDS, DEFAULT_BOARDS, COLUMN_ORDER, withDefaults } from '../lib/config.js'
import { buildBoard, createTask, taskBySession } from '../lib/routes.js'
import { importIssue } from '../lib/import.js'
import { freshStore, reopenStore } from './helpers.mjs'

const config = withDefaults({})

test('проектная доска — весь набор колонок, простая — четыре', () => {
  assert.deepEqual(columnsOf('project'), COLUMN_ORDER)
  assert.deepEqual(columnsOf('simple'), ['backlog', 'in-progress', 'review', 'done'])
})

test('колонки простой доски — подмножество проектных', () => {
  // Иначе задача, переехавшая с доски на доску, оказалась бы в колонке,
  // которой на второй нет.
  for (const column of columnsOf('simple')) assert.ok(COLUMN_ORDER.includes(column), column)
})

test('неизвестный вид откатывается на проектную, а не в пустоту', () => {
  // Доска без колонок выглядит как поломка и прячет задачи целиком.
  for (const wrong of ['нет-такого', '', undefined, null, 42]) {
    assert.equal(normalizeKind(wrong), 'project')
    assert.deepEqual(columnsOf(wrong), COLUMN_ORDER)
  }
})

test('видов ровно два и обе доски заводятся по умолчанию', () => {
  assert.deepEqual(BOARD_KINDS, ['project', 'simple'])
  assert.deepEqual(DEFAULT_BOARDS.map((b) => b.kind), BOARD_KINDS)
})

// ------------------------------------------------- хранилище

test('вид доски переживает переоткрытие базы', () => {
  const { store, dir, cleanup } = freshStore()
  assert.equal(store.boardKind('simple'), 'simple')
  store.close()
  const again = reopenStore(dir)
  assert.equal(again.boardKind('simple'), 'simple')
  assert.equal(again.boardKind('main'), 'project')
  again.close()
  cleanup()
})

test('прежняя единственная доска становится проектной вместе с задачами', () => {
  // Заведи мы вторую доску рядом, задачи остались бы на осиротевшей.
  const { store, dir, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'deploy', title: 'старая задача' })
  store.close()

  const again = reopenStore(dir)
  assert.equal(again.boardKind('main'), 'project')
  assert.equal(again.getTask(task.id).board, 'main')
  assert.equal(again.getTask(task.id).column, 'deploy')
  again.close()
  cleanup()
})

test('неизвестная доска считается проектной', () => {
  const { store, cleanup } = freshStore()
  assert.equal(store.boardKind('нет-такой'), 'project')
  cleanup()
})

// ------------------------------------------------- ответ доски

test('доска отдаёт свой вид и свои колонки', () => {
  const { store, cleanup } = freshStore()
  const project = buildBoard({ store, config, board: 'main' })
  const simple = buildBoard({ store, config, board: 'simple' })
  assert.equal(project.kind, 'project')
  assert.equal(simple.kind, 'simple')
  assert.deepEqual(project.columns.map((c) => c.id), COLUMN_ORDER)
  assert.deepEqual(simple.columns.map((c) => c.id), ['backlog', 'in-progress', 'review', 'done'])
  cleanup()
})

test('на простой доске задачу нельзя завести в чужой колонке', () => {
  // Колонка `deploy` там не рисуется, и задача просто пропала бы с глаз.
  const { store, cleanup } = freshStore()
  const out = createTask({ store, input: { board: 'simple', column: 'deploy', title: 'A' } })
  assert.equal(out.task.column, 'backlog')
  cleanup()
})

test('на проектной доске та же колонка принимается', () => {
  const { store, cleanup } = freshStore()
  const out = createTask({ store, input: { board: 'main', column: 'deploy', title: 'A' } })
  assert.equal(out.task.column, 'deploy')
  cleanup()
})

test('чип получает колонки своей доски', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'simple', column: 'backlog', title: 'A' })
  store.updateTask(task.id, { sessionId: 's1' })
  const out = taskBySession({ store, sessionId: 's1' })
  assert.deepEqual(out.columns, ['backlog', 'in-progress', 'review', 'done'])
  cleanup()
})

test('без задачи чип колонок не получает', () => {
  const { store, cleanup } = freshStore()
  assert.deepEqual(taskBySession({ store, sessionId: 'чужая' }), { task: null })
  cleanup()
})

// ------------------------------------------------- импорт

test('issue не импортируется на простую доску', async () => {
  // У свободной заметки нет ни ветки, ни PR, и Gitea о ней ничего не скажет.
  const { store, cleanup } = freshStore()
  const gitea = { isConfigured: () => true, getIssue: async () => ({ number: 1, title: 'A' }) }
  const out = await importIssue({ gitea, store, owner: 'o', repo: 'r', issueNumber: 1, board: 'simple' })
  assert.equal(out.error, 'board-not-for-issues')
  assert.equal(out.status, 400)
  cleanup()
})

test('на проектную доску тот же issue импортируется', async () => {
  const { store, cleanup } = freshStore()
  const gitea = {
    isConfigured: () => true,
    getIssue: async () => ({ number: 7, title: 'из issue', body: '', labels: [], html_url: 'u' }),
  }
  const out = await importIssue({ gitea, store, owner: 'o', repo: 'r', issueNumber: 7, board: 'main' })
  assert.equal(out.error, undefined)
  assert.equal(out.task.issueNumber, 7)
  cleanup()
})

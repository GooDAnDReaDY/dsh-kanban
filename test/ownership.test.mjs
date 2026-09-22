// Владение задачей: раскладка по ответственному, «мои», взятие при запуске.
import test from 'node:test'
import assert from 'node:assert/strict'

import { claimOnStart } from '../lib/launcher.js'
import { loadClient } from './client-load.mjs'
import { freshStore } from './helpers.mjs'

const h = loadClient().exported.helpers
const plain = (value) => JSON.parse(JSON.stringify(value))

// ---------------------------------------------- раскладка по ответственному

test('свободные задачи идут первой группой', () => {
  // Ради них в эту раскладку и заглядывают: «что можно взять».
  const out = plain(h.groupByAssignee([
    { id: 'a', assignee: 'vadim' },
    { id: 'b' },
    { id: 'c', assignee: 'codex' },
  ]))
  assert.deepEqual(out.map((g) => g.who), ['', 'codex', 'vadim'])
})

test('внутри группы порядок не переставляется', () => {
  // Порядок задаёт колонка — ручной либо по дате; группировка его не решает.
  const out = plain(h.groupByAssignee([
    { id: 'первая', assignee: 'v' },
    { id: 'вторая', assignee: 'v' },
  ]))
  assert.deepEqual(out[0].tasks.map((t) => t.id), ['первая', 'вторая'])
})

test('пустой список даёт пустую раскладку, а не группу из пустоты', () => {
  assert.deepEqual(plain(h.groupByAssignee([])), [])
  assert.deepEqual(plain(h.groupByAssignee(undefined)), [])
})

// ------------------------------------------------------ взятие при запуске

test('запуск берёт свободную задачу на себя', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  assert.equal(claimOnStart({ store, task, login: 'vadim' }), 'vadim')
  assert.equal(store.getTask(task.id).assignee, 'vadim')
  assert.match(store.listTransitions(task.id)[0].detail, /взял при запуске/)
  cleanup()
})

test('чужую задачу запуск не переназначает', () => {
  // Задачу могли отдать другому осознанно; запуск — не повод это отменять.
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A', assignee: 'codex' })
  assert.equal(claimOnStart({ store, task: store.getTask(task.id), login: 'vadim' }), '')
  assert.equal(store.getTask(task.id).assignee, 'codex')
  assert.equal(store.listTransitions(task.id).length, 0, 'молчание вместо лишней записи')
  cleanup()
})

test('без логина запуск ничего не назначает', () => {
  // Gitea не ответил — работаем без назначения, но запуск не срываем.
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  assert.equal(claimOnStart({ store, task, login: '' }), '')
  assert.equal(store.getTask(task.id).assignee, '')
  cleanup()
})

// ------------------------------------------------------------ браузер

test('«Мои» не рисуются, когда своих задач нет или мы себя не знаем', () => {
  const { src } = loadClient()
  const at = src.indexOf("t('board.mine'")
  const block = src.slice(at - 700, at)
  assert.match(block, /if \(me === ''\) return null/)
  assert.match(block, /if \(mine === 0\) return null/)
})

test('ключ группы решает переключатель, а не жёстко проект', () => {
  const { src } = loadClient()
  assert.match(src, /grouping === 'assignee'/)
  assert.match(src, /groupByAssignee\(items\)/)
})

test('подписи владения есть в обоих словарях', () => {
  const { src } = loadClient()
  for (const key of ['board.mine', 'board.mineHint', 'group.repo', 'group.assignee', 'group.nobody']) {
    assert.equal(src.split("'" + key + "':").length - 1, 2, 'у ' + key + ' не два перевода')
  }
})

// Ответственный за задачу: подхват, назначение, отправка в Gitea, отборы.
import test from 'node:test'
import assert from 'node:assert/strict'

import { issueAssignee, issueToTask, refreshPatch } from '../lib/import.js'
import { assignTask } from '../lib/routes.js'
import { planAssign, createOutbox } from '../lib/outbound.js'
import { applyObservation } from '../lib/sync.js'
import { facetsOf, matchesFilters, ASSIGNEE, NOBODY } from '../lib/filters.js'
import { loadClient } from './client-load.mjs'
import { freshStore } from './helpers.mjs'

test('ответственный берётся из issue', () => {
  assert.equal(issueAssignee({ assignee: { login: 'vadim' } }), 'vadim')
  assert.equal(issueAssignee({}), '', 'никого не назначили — так и говорим')
})

test('из списка берётся первый: отвечает один, а не все', () => {
  // «Ответственны все» на доске читается как «не отвечает никто».
  assert.equal(issueAssignee({ assignees: [{ login: 'codex' }, { login: 'claude' }] }), 'codex')
  assert.equal(issueAssignee({ assignee: null, assignees: [{ login: 'claude' }] }), 'claude')
})

test('ответственный доезжает до карточки при подхвате', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask(issueToTask(
    { number: 7, title: 'A', user: { login: 'vadim' }, assignee: { login: 'codex' } },
    { owner: 'o', repo: 'r' },
  ))
  assert.equal(task.assignee, 'codex')
  assert.equal(task.author, 'vadim', 'кто завёл и кто взял — разные вопросы')
  cleanup()
})

test('снятие ответственного в Gitea доезжает тоже', () => {
  // Иначе доска показывала бы вчерашнего владельца задачи, с которой его сняли.
  const patch = refreshPatch({ assignee: 'codex' }, { title: 'A', assignees: [] })
  assert.equal(patch.assignee, '')
})

test('сверка подхватывает ответственного в обе стороны', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
  })
  applyObservation({
    store, task, observation: { column: 'backlog' },
    issue: { title: 'A', assignee: { login: 'claude' } },
  })
  assert.equal(store.getTask(task.id).assignee, 'claude')

  applyObservation({
    store, task: store.getTask(task.id), observation: { column: 'backlog' },
    issue: { title: 'A', assignees: [] },
  })
  assert.equal(store.getTask(task.id).assignee, '', 'сняли в Gitea — снято и здесь')
  cleanup()
})

test('назначение пишется в журнал задачи', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  assert.equal(assignTask({ store, id: task.id, login: 'vadim' }).task.assignee, 'vadim')
  assert.match(store.listTransitions(task.id)[0].detail, /ответственный: vadim/)

  assignTask({ store, id: task.id, login: '' })
  assert.equal(store.getTask(task.id).assignee, '')
  const said = store.listTransitions(task.id).map((row) => row.detail)
  assert.ok(said.some((one) => /снят/.test(one)), 'о снятии не написали: ' + said.join(' | '))
  cleanup()
})

test('повторное назначение того же не плодит записей', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A', assignee: 'vadim' })
  assignTask({ store, id: task.id, login: 'vadim' })
  assert.equal(store.listTransitions(task.id).length, 0)
  cleanup()
})

test('несуществующей задаче отвечают отказом, а не молчанием', () => {
  const { store, cleanup } = freshStore()
  assert.equal(assignTask({ store, id: 'нет-такой', login: 'vadim' }).error, 'task-not-found')
  cleanup()
})

test('в Gitea уходит назначение, а своей задаче отправлять нечего', () => {
  assert.deepEqual(planAssign({ owner: 'o', repo: 'r', issueNumber: 7 }, 'vadim'),
    [{ kind: 'assign', owner: 'o', repo: 'r', index: 7, login: 'vadim' }])
  assert.deepEqual(planAssign({ title: 'своя задача' }, 'vadim'), [])
})

test('снятие уходит пустым списком, а не пропуском поля', async () => {
  // Gitea понимает пустой список как «никто»; отсутствие поля она понимает
  // как «не трогай», и снять назначение стало бы нечем.
  const seen = []
  const outbox = createOutbox({
    gitea: { setAssignees: async (op) => seen.push(op) },
    store: { getTask: () => undefined },
  })
  outbox.push('t1', planAssign({ owner: 'o', repo: 'r', issueNumber: 7 }, ''))
  await outbox.flush()
  assert.deepEqual(seen, [{ owner: 'o', repo: 'r', index: 7, logins: [] }])
})

test('ответственный становится измерением отбора', () => {
  const tasks = [{ assignee: 'vadim' }, { assignee: 'vadim' }, { assignee: '' }]
  const facet = facetsOf(tasks).find((f) => f.ns === ASSIGNEE)
  const counts = Object.fromEntries(facet.values.map((v) => [v.value, v.count]))
  assert.deepEqual(counts, { vadim: 2, [NOBODY]: 1 })
  // «Что свободно» — главный вопрос к доске, и он обязан отбираться.
  assert.equal(matchesFilters({ assignee: '' }, { [ASSIGNEE]: [NOBODY] }), true)
  assert.equal(matchesFilters({ assignee: 'vadim' }, { [ASSIGNEE]: [NOBODY] }), false)
})

test('подписи ответственного есть в обоих словарях', () => {
  const { src } = loadClient()
  for (const key of ['facet.assignee', 'card.assigneeHint', 'panel.assignee',
    'panel.assignMe', 'panel.assignDrop', 'error.gitea-unreachable']) {
    assert.equal(src.split("'" + key + "':").length - 1, 2, 'у ' + key + ' не два перевода')
  }
})

test('кнопка берёт задачу на того, чьим токеном ходит доска', () => {
  // Своего пользователя у харнесса нет, поэтому «взять себе» — это «me»,
  // который сервер разворачивает в логин владельца токена.
  const { src } = loadClient()
  assert.match(src, /login: mine \? '' : 'me'/)
})

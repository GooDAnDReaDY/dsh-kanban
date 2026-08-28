// Пачка задач одной сессией и очередь.
import test from 'node:test'
import assert from 'node:assert/strict'

import { runBatch, queueTask, unqueueTask, liveSessions, buildQueuedMessage } from '../lib/launcher.js'
import { taskState, queuePosition } from '../lib/plan.js'
import { pickTask, boardMoveDefinition, boardPlanDefinition } from '../lib/board-tool.js'
import { buildBoard } from '../lib/routes.js'
import { withDefaults } from '../lib/config.js'
import { freshStore } from './helpers.mjs'

const config = withDefaults({})
const createMessage = (m) => m
const NOW = 1_700_000_000_000

/** Заглушка службы агентов: одна живая сессия, помнит отправленное. */
function stubAgents(status = 'running', sessionId = 'kanban-batch-1') {
  const sent = []
  const agent = {
    status,
    session: { id: sessionId },
    whenIdle: async () => {},
    followup: (m) => sent.push(m),
    cancel() {},
  }
  return {
    sent,
    agents: {
      // Живого агента у новой пачки нет: сессию поднимают, а не берут.
      get: () => undefined,
      create: async () => ({ agent, dispose() {} }),
    },
  }
}

/** Заглушка с ЖИВОЙ сессией — для очереди к уже идущей работе. */
function stubLive(sessionId = 'kanban-1') {
  const { sent, agents } = stubAgents('running', sessionId)
  const agent = { status: 'running', session: { id: sessionId }, whenIdle: async () => {}, followup: (m) => sent.push(m) }
  return { sent, agents: { get: () => agent, create: agents.create } }
}

const threeTasks = (store) => ['раз', 'два', 'три'].map((title, i) => store.createTask({
  board: 'main', column: 'backlog', title, owner: 'o', repo: 'r', issueNumber: i + 1,
}))

test('пачка идёт одной сессией и по одному сообщению на задачу', async () => {
  // «Разом» не бывает: правило владельца, и оно лучше выбора.
  const { store, cleanup } = freshStore()
  const { agents, sent } = stubAgents()
  const tasks = threeTasks(store)

  const out = await runBatch({
    agents, store, tasks, config, provider: 'p', model: 'm',
    mintSessionId: () => 'kanban-batch-1', createMessage, now: NOW,
  })
  assert.equal(out.started, 3)
  assert.equal(sent.length, 3, 'по сообщению на задачу')
  assert.equal(store.listTasksBySession('kanban-batch-1').length, 3)
  cleanup()
})

test('каждое сообщение пачки называет свой номер и общее число', () => {
  // Без этого агент, получив первую из пяти, объявит работу законченной и
  // приберёт за собой: удалит ветку, закроет issue.
  const task = { repo: 'r', issueNumber: 7, title: 'A', body: '' }
  assert.match(buildQueuedMessage(task, config, 2, 5), /Задача 2 из 5/)
})

test('одна задача номера не получает', () => {
  const task = { repo: 'r', issueNumber: 7, title: 'A', body: '' }
  assert.doesNotMatch(buildQueuedMessage(task, config, 1, 1), /из 1/)
})

test('в работу уезжает только первая, остальные ждут очереди', async () => {
  // Десять карточек в «В работе», из которых делается одна, — это ложь, и
  // предел колонки от неё теряет смысл.
  const { store, cleanup } = freshStore()
  const { agents } = stubAgents()
  const tasks = threeTasks(store)

  await runBatch({
    agents, store, tasks, config, provider: 'p', model: 'm',
    mintSessionId: () => 'kanban-batch-1', createMessage, now: NOW,
  })
  const after = tasks.map((t) => store.getTask(t.id))
  assert.equal(after[0].column, 'in-progress')
  assert.equal(after[0].queuedAt, 0, 'идущая задача в очереди не стоит')
  assert.deepEqual(after.slice(1).map((t) => t.column), ['backlog', 'backlog'])
  assert.ok(after[1].queuedAt > 0 && after[2].queuedAt > after[1].queuedAt)
  cleanup()
})

test('номера очереди идут подряд с единицы', () => {
  const same = [{ queuedAt: 0 }, { queuedAt: 10 }, { queuedAt: 20 }, { queuedAt: 30 }]
  assert.equal(queuePosition(same[0], same), undefined, 'идущая задача номера не имеет')
  assert.deepEqual(same.slice(1).map((t) => queuePosition(t, same)), [1, 2, 3])
})

test('состояние queued видно на доске вместе с номером', async () => {
  const { store, cleanup } = freshStore()
  const { agents } = stubAgents()
  const tasks = threeTasks(store)
  await runBatch({
    agents, store, tasks, config, provider: 'p', model: 'm',
    mintSessionId: () => 'kanban-batch-1', createMessage, now: NOW,
  })
  const board = buildBoard({ store, config, liveOf: () => 'running' })
  const second = board.tasks.find((t) => t.id === tasks[1].id)
  assert.equal(second.state, 'queued')
  assert.equal(second.queuePos, 1)
  cleanup()
})

test('пустой выбор запускать нечего', async () => {
  const { store, cleanup } = freshStore()
  const { agents } = stubAgents()
  const out = await runBatch({
    agents, store, tasks: [], config, provider: 'p', model: 'm',
    mintSessionId: () => 'x', createMessage,
  })
  assert.equal(out.error, 'nothing-picked')
  cleanup()
})

// ------------------------------------------------- очередь к идущей сессии

test('задача встаёт в очередь живой сессии', async () => {
  const { store, cleanup } = freshStore()
  const { agents, sent } = stubLive()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  const out = await queueTask({
    agents, store, task, sessionId: 'kanban-1', config, createMessage, now: NOW,
  })
  assert.equal(out.sessionId, 'kanban-1')
  assert.equal(sent.length, 1)
  assert.equal(store.getTask(task.id).queuedAt, NOW)
  assert.equal(taskState({ task: store.getTask(task.id), live: 'running' }), 'queued')
  cleanup()
})

test('мёртвой сессии ставить в очередь нечего', async () => {
  // Сообщение исчезло бы, а карточка осталась привязанной к тому, чего нет.
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  const out = await queueTask({
    agents: { get: () => undefined }, store, task, sessionId: 'нет-такой', config, createMessage,
  })
  assert.equal(out.error, 'session-not-live')
  assert.equal(store.getTask(task.id).sessionId, null)
  cleanup()
})

test('снятие с очереди отвязывает задачу и говорит об этом в журнале', () => {
  // Агент может дойти до задачи и увидеть карточку, которая его не ждёт:
  // сообщение из очереди ядра уже отдано и отозвать его нечем.
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.updateTask(task.id, { sessionId: 's1', queuedAt: NOW })
  const out = unqueueTask({ store, task: store.getTask(task.id) })
  assert.equal(out.task.queuedAt, 0)
  assert.equal(out.task.sessionId, null)
  assert.match(store.listTransitions(task.id)[0].detail, /отозвать его нечем/)
  cleanup()
})

test('снять можно только то, что в очереди', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  assert.equal(unqueueTask({ store, task: store.getTask(task.id) }).error, 'task-not-queued')
  assert.equal(unqueueTask({ store, task: undefined }).error, 'task-not-found')
  cleanup()
})

test('в списке сессий только живые', () => {
  const { store, cleanup } = freshStore()
  const live = store.createTask({ board: 'main', column: 'in-progress', title: 'живая' })
  const dead = store.createTask({ board: 'main', column: 'in-progress', title: 'мёртвая' })
  store.updateTask(live.id, { sessionId: 'жива' })
  store.updateTask(dead.id, { sessionId: 'мертва' })
  const out = liveSessions({
    store,
    agents: { get: (id) => (id === 'жива' ? { status: 'running' } : undefined) },
  })
  assert.deepEqual(out.map((x) => x.sessionId), ['жива'])
  assert.equal(out[0].tasks.length, 1)
  cleanup()
})

// ------------------------------------------------- инструменты при пачке

test('при нескольких задачах инструмент обязан назвать, какую двигает', () => {
  // Догадка здесь означает подвинутую не ту карточку, и заметят это нескоро.
  const store = {
    listTasksBySession: () => [
      { id: 'a', repo: 'r', issueNumber: 1, column: 'backlog' },
      { id: 'b', repo: 'r', issueNumber: 2, column: 'backlog' },
    ],
  }
  const out = pickTask(store, { agent: { session: { id: 's1' } } }, '')
  assert.match(out.error, /several tasks/)
  assert.match(out.error, /r#1/)
  assert.match(out.error, /r#2/)
})

test('при одной задаче называть нечего', () => {
  const store = { listTasksBySession: () => [{ id: 'a', column: 'backlog' }] }
  assert.equal(pickTask(store, { agent: { session: { id: 's1' } } }, '').task.id, 'a')
})

test('задача выбирается и по ссылке, и по идентификатору', () => {
  const store = {
    listTasksBySession: () => [
      { id: 'a', repo: 'r', issueNumber: 1, column: 'backlog' },
      { id: 'b', repo: 'r', issueNumber: 2, column: 'backlog' },
    ],
  }
  const exec = { agent: { session: { id: 's1' } } }
  assert.equal(pickTask(store, exec, 'r#2').task.id, 'b')
  assert.equal(pickTask(store, exec, 'a').task.id, 'a')
  assert.match(pickTask(store, exec, 'r#9').error, /No task/)
})

test('план кладётся всем задачам сессии', async () => {
  // План один на сессию: это план работы над пачкой, а не над каждой порознь.
  const { store, cleanup } = freshStore()
  const tasks = threeTasks(store)
  for (const task of tasks) store.updateTask(task.id, { sessionId: 's1' })
  const tool = boardPlanDefinition({ store })
  await tool.execute({ items: ['раз', 'два'], current: 1 }, { agent: { session: { id: 's1' } } })
  for (const task of tasks) assert.notEqual(store.getTask(task.id).plan, '')
  cleanup()
})

test('board_move принимает указание задачи', () => {
  const { parameters } = boardMoveDefinition({ store: { listTasksBySession: () => [] } })
  assert.equal(parameters.task.type, 'string')
  assert.equal(parameters.task.required, undefined, 'при одной задаче указывать нечего')
})

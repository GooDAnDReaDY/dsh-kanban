import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers.mjs'
import {
  handleTriageTask,
  handleGetSubtasks,
  handleCreateSubtask,
  handleToggleChecklistItem,
  handleCreateTaskPr,
} from '../lib/routes.js'
import {
  boardDecomposeDefinition,
  boardChecklistItemDefinition,
} from '../lib/board-tool.js'

test('handleTriageTask converts task into epic and creates subtasks', async () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    title: 'Main Feature',
    body: 'Epic description',
    owner: 'goodandready',
    repo: 'dsh-kanban',
    issueNumber: 100,
  })

  const res = await handleTriageTask({
    store,
    task,
    input: {
      subtasks: [
        { title: 'Subtask A', body: 'Do A' },
        { title: 'Subtask B', body: 'Do B' },
      ],
    },
  })

  assert.equal(res.status, 200)
  assert.equal(res.body.createdCount, 2)
  assert.equal(res.body.epic.isEpic, true)
  assert.equal(res.body.subtasks.length, 2)
  assert.equal(res.body.subtasks[0].title, 'Subtask A')
  assert.equal(res.body.subtasks[0].parentId, task.id)
  assert.equal(res.body.counts.total, 2)
  assert.equal(res.body.counts.completed, 0)
  cleanup()
})

test('handleGetSubtasks and handleCreateSubtask manage child tasks', async () => {
  const { store, cleanup } = freshStore()
  const epic = store.createTask({ title: 'Parent Epic' })

  const createdRes = await handleCreateSubtask({
    store,
    task: epic,
    input: { title: 'Single Child', body: 'Child details' },
  })
  assert.equal(createdRes.status, 200)
  assert.equal(createdRes.body.subtask.parentId, epic.id)
  assert.equal(createdRes.body.counts.total, 1)

  const getRes = handleGetSubtasks({ store, task: store.getTask(epic.id) })
  assert.equal(getRes.status, 200)
  assert.equal(getRes.body.subtasks.length, 1)
  assert.equal(getRes.body.subtasks[0].title, 'Single Child')
  cleanup()
})

test('handleToggleChecklistItem toggles checklist items atomically', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    title: 'Task with DoD',
    checklist: [
      { text: 'Write tests', done: false },
      { text: 'Update docs', done: false },
    ],
  })

  // Toggle by index
  const res1 = handleToggleChecklistItem({
    store,
    task: store.getTask(task.id),
    input: { index: 0, checked: true },
  })
  assert.equal(res1.status, 200)
  assert.equal(res1.body.item.done, true)
  assert.equal(res1.body.task.checklist[0].done, true)
  assert.equal(res1.body.task.checklist[1].done, false)

  // Toggle by text match
  const res2 = handleToggleChecklistItem({
    store,
    task: store.getTask(task.id),
    input: { text: 'docs' },
  })
  assert.equal(res2.status, 200)
  assert.equal(res2.body.item.done, true)
  assert.equal(res2.body.task.checklist[1].done, true)

  cleanup()
})

test('handleCreateTaskPr invokes gitea createPullRequest', async () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    title: 'PR Task',
    owner: 'goodandready',
    repo: 'dsh-kanban',
    branch: 'feat/test-pr',
    issueNumber: 42,
  })

  let prCalledWith = null
  const mockGitea = {
    async createPullRequest(params) {
      prCalledWith = params
      return { number: 10, html_url: 'http://gitea/pr/10' }
    },
  }

  const res = await handleCreateTaskPr({
    store,
    gitea: mockGitea,
    task,
    input: { base: 'main' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.pr.number, 10)
  assert.equal(prCalledWith.head, 'feat/test-pr')
  assert.equal(prCalledWith.base, 'main')
  cleanup()
})

test('board_decompose tool decomposes current session task', async () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    title: 'Agent Decompose Task',
    sessionId: 'session-decomp-1',
  })

  const tool = boardDecomposeDefinition({ store })
  const exec = { session: { id: 'session-decomp-1' } }

  const out = await tool.execute({
    subtasks: ['Step 1: Init', 'Step 2: Verify'],
  }, exec)

  assert.match(out, /Decomposed task.*into 2 subtasks/)
  const epic = store.getTask(task.id)
  assert.equal(epic.isEpic, true)
  const subs = store.listSubtasks(task.id)
  assert.equal(subs.length, 2)
  cleanup()
})

test('board_checklist_item tool toggles DoD checklist items', async () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    title: 'Agent Checklist Task',
    sessionId: 'session-check-1',
    checklist: [
      { text: 'Unit tests passing', done: false },
      { text: 'Build check', done: false },
    ],
  })

  const tool = boardChecklistItemDefinition({ store })
  const exec = { session: { id: 'session-check-1' } }

  const out1 = await tool.execute({ text: 'Unit tests', done: true }, exec)
  assert.match(out1, /marked as DONE/)
  assert.equal(store.getTask(task.id).checklist[0].done, true)

  const out2 = await tool.execute({ index: 1, done: true }, exec)
  assert.match(out2, /marked as DONE/)
  assert.equal(store.getTask(task.id).checklist[1].done, true)
  cleanup()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { runTask, runBatch, queueTask } from '../lib/launcher.js'
import { dispatchMove } from '../lib/commands.js'
import { freshStore } from './helpers.mjs'

function validateV4SourceAdmission(source) {
  assert.ok(source && typeof source === 'object', 'source must be an object')
  assert.equal(typeof source.kind, 'string', 'source.kind must be string')
  assert.ok(source.kind.length > 0, 'source.kind must not be empty')
  assert.notEqual(source.kind, 'plugin', 'source.kind must not be generic "plugin" in format v4')
  assert.equal(source.kind, 'dsh-kanban', 'source.kind must be producer-owned "dsh-kanban"')
}

function makeMockContext() {
  const { store, cleanup } = freshStore()
  const sent = []
  const agent = {
    status: 'idle',
    followup: (msg) => {
      sent.push(msg)
      return { id: 'msg-' + sent.length }
    },
    cancel: () => {},
    whenIdle: async () => {},
    session: { id: 'session-1' },
  }
  const agents = {
    get: () => agent,
    create: async () => ({ agent, dispose() {} }),
    resume: async () => ({ agent, dispose() {} }),
  }
  const mintSessionId = () => 'session-1'
  const createMessage = (msg) => msg
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const config = { defaultProjectRoot: '/tmp', defaultModel: 'test-model' }

  return { store, cleanup, sent, agent, agents, mintSessionId, createMessage, logger, config }
}

test('DSH v4: runTask (task-start) uses producer-owned source kind', async () => {
  const { store, cleanup, sent, agents, mintSessionId, createMessage, logger, config } = makeMockContext()
  try {
    const task = store.createTask({ board: 'main', column: 'backlog', title: 'Task A' })

    await runTask({
      agents,
      store,
      task,
      config,
      mintSessionId,
      createMessage,
      logger,
      resume: false,
    })

    assert.equal(sent.length, 1)
    validateV4SourceAdmission(sent[0].source)
    assert.equal(sent[0].source.form, 'task-start')
    assert.equal(sent[0].source.plugin, 'dsh-kanban')
  } finally {
    cleanup()
  }
})

test('DSH v4: runTask (task-resume) uses producer-owned source kind', async () => {
  const { store, cleanup, sent, agents, mintSessionId, createMessage, logger, config } = makeMockContext()
  try {
    const task = store.createTask({ board: 'main', column: 'backlog', title: 'Task Resume' })

    await runTask({
      agents,
      store,
      task,
      config,
      mintSessionId,
      createMessage,
      logger,
      resume: true,
    })

    assert.equal(sent.length, 1)
    validateV4SourceAdmission(sent[0].source)
    assert.equal(sent[0].source.form, 'task-resume')
    assert.equal(sent[0].source.plugin, 'dsh-kanban')
  } finally {
    cleanup()
  }
})

test('DSH v4: queueTask (task-queued) uses producer-owned source kind', async () => {
  const { store, cleanup, sent, agents, logger, config, createMessage } = makeMockContext()
  try {
    const task = store.createTask({ board: 'main', column: 'backlog', title: 'Task Queue' })

    await queueTask({
      agents,
      store,
      task,
      sessionId: 'session-1',
      config,
      createMessage,
      logger,
    })

    assert.equal(sent.length, 1)
    validateV4SourceAdmission(sent[0].source)
    assert.equal(sent[0].source.form, 'task-queued')
    assert.equal(sent[0].source.plugin, 'dsh-kanban')
  } finally {
    cleanup()
  }
})

test('DSH v4: runBatch (batch-queued & single-item task-start) uses producer-owned source kind', async () => {
  const { store, cleanup, sent, agents, mintSessionId, createMessage, logger, config } = makeMockContext()
  try {
    const t1 = store.createTask({ board: 'main', column: 'backlog', title: 'Batch Task 1' })
    const t2 = store.createTask({ board: 'main', column: 'backlog', title: 'Batch Task 2' })

    // Multi-task batch: uses batch-queued
    await runBatch({
      agents,
      store,
      tasks: [t1, t2],
      config,
      mintSessionId,
      createMessage,
      logger,
    })

    assert.equal(sent.length, 2)
    validateV4SourceAdmission(sent[0].source)
    assert.equal(sent[0].source.form, 'batch-queued')
    assert.equal(sent[0].source.plugin, 'dsh-kanban')

    validateV4SourceAdmission(sent[1].source)
    assert.equal(sent[1].source.form, 'batch-queued')
    assert.equal(sent[1].source.plugin, 'dsh-kanban')

    // Single-task batch with custom text: uses task-start
    const t3 = store.createTask({ board: 'main', column: 'backlog', title: 'Batch Single' })
    await runBatch({
      agents,
      store,
      tasks: [t3],
      text: 'Custom start prompt',
      config,
      mintSessionId,
      createMessage,
      logger,
    })

    assert.equal(sent.length, 3)
    validateV4SourceAdmission(sent[2].source)
    assert.equal(sent[2].source.form, 'task-start')
    assert.equal(sent[2].source.plugin, 'dsh-kanban')
  } finally {
    cleanup()
  }
})

test('DSH v4: dispatchMove (board-command) uses producer-owned source kind', () => {
  const { store, cleanup, sent, agents, createMessage, logger } = makeMockContext()
  try {
    const task = store.createTask({ board: 'main', column: 'in-progress', title: 'Move Task' })
    store.updateTask(task.id, { sessionId: 'session-1' })
    const updated = store.getTask(task.id)

    const res = dispatchMove({
      agents,
      task: updated,
      column: 'review',
      kind: 'project',
      createMessage,
      logger,
    })

    assert.equal(res.acted, 'sent')
    assert.equal(sent.length, 1)
    validateV4SourceAdmission(sent[0].source)
    assert.equal(sent[0].source.form, 'board-command')
    assert.equal(sent[0].source.plugin, 'dsh-kanban')
  } finally {
    cleanup()
  }
})

test('DSH v4: live assertV4RowAdmission compatibility if package available', async () => {
  let assertV4RowAdmission
  try {
    const mod = await import('/home/vadim/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')
    assertV4RowAdmission = mod.assertV4RowAdmission
  } catch {
    try {
      const mod = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
      assertV4RowAdmission = mod.assertV4RowAdmission
    } catch {
      // not resolvable in standalone test runner
    }
  }

  if (typeof assertV4RowAdmission === 'function') {
    const validForms = ['task-start', 'task-resume', 'task-queued', 'batch-queued', 'board-command']
    for (const form of validForms) {
      const row = {
        type: 'user/message',
        data: {
          source: { kind: 'dsh-kanban', plugin: 'dsh-kanban', form },
          content: [{ type: 'text', text: 'test content' }],
        },
      }
      assert.doesNotThrow(() => assertV4RowAdmission(row), `assertV4RowAdmission should accept form ${form}`)
    }

    // Verify rejection of legacy source
    const legacyRow = {
      type: 'user/message',
      data: {
        source: { kind: 'plugin', plugin: 'dsh-kanban', form: 'task-start' },
        content: [{ type: 'text', text: 'test content' }],
      },
    }
    assert.throws(
      () => assertV4RowAdmission(legacyRow),
      /format v4 message requires a producer-owned source kind/,
      'assertV4RowAdmission must reject legacy kind: "plugin"'
    )
  }
})

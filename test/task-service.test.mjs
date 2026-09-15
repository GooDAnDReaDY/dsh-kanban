import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore, reopenStore } from './helpers.mjs'
import { createKanbanTaskService, TASK_PROVISION_CONTRACT } from '../lib/task-service.js'

test('task service validates board and column', async () => {
  const { store, cleanup } = freshStore()
  const service = createKanbanTaskService({ store })
  assert.equal(service.contract, TASK_PROVISION_CONTRACT)
  assert.deepEqual(await service.createTask({ title: 'A', board: 'missing' }), { ok: false, code: 'board-not-found', board: 'missing' })
  const invalid = await service.createTask({ title: 'A', board: 'simple', column: 'deploy' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'column-not-found')
  cleanup()
})

test('task service stores external links and is idempotent', async () => {
  const { store, dir, cleanup } = freshStore()
  const service = createKanbanTaskService({ store })
  const first = await service.createTask({
    title: 'Drive task',
    body: 'details',
    owner: 'acme',
    repo: 'app',
    issueNumber: 7,
    issueUrl: 'https://gitea.example.test/acme/app/issues/7',
    labels: ['dsh-drives', 'dsh-drives'],
    externalRef: 'dsh-drives:proposal-1',
  })
  assert.equal(first.ok, true)
  assert.equal(first.alreadyExists, false)
  assert.equal(first.task.externalRef, 'dsh-drives:proposal-1')
  assert.equal(first.task.issueNumber, 7)
  const second = await service.createTask({ title: 'different', externalRef: 'dsh-drives:proposal-1' })
  assert.equal(second.ok, true)
  assert.equal(second.alreadyExists, true)
  assert.equal(second.taskId, first.taskId)
  store.close()
  const again = reopenStore(dir)
  assert.equal(again.findTaskByExternalRef('dsh-drives:proposal-1').id, first.taskId)
  again.close()
  cleanup()
})

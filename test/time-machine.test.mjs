import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isTimeMachineAvailable,
  createInceptionSnapshot,
  createCheckpointSnapshot,
  rollbackToSnapshot,
  listTaskSnapshots,
} from '../lib/time-machine.js'

test('isTimeMachineAvailable: detects engine from context or returns false gracefully', () => {
  assert.equal(isTimeMachineAvailable({}), false)
  assert.equal(isTimeMachineAvailable(null), false)

  const ctxWithProp = { timeMachineEngine: { createSnapshot: () => {} } }
  assert.equal(isTimeMachineAvailable(ctxWithProp), true)

  const ctxWithGet = { get: (name) => (name === 'timeMachineEngine' ? { createSnapshot: () => {} } : null) }
  assert.equal(isTimeMachineAvailable(ctxWithGet), true)
})

test('createInceptionSnapshot: creates snapshot and stores inceptionSnapshotId on task', async () => {
  let createdArgs = null
  const fakeEngine = {
    async createSnapshot(label, opts) {
      createdArgs = { label, opts }
      return { id: 'snap-123', label, at: Date.now() }
    },
  }
  const ctx = { timeMachineEngine: fakeEngine }

  let updatedPatch = null
  const fakeStore = {
    updateTask(id, patch) {
      updatedPatch = { id, patch }
      return { id, ...patch }
    },
  }

  const task = { id: 'task-42', title: 'Implement feature', worktree: '/tmp/worktree-42' }
  const res = await createInceptionSnapshot({
    ctx,
    task,
    store: fakeStore,
    cwdOf: () => '/default/cwd',
  })

  assert.equal(res.available, true)
  assert.equal(res.created, true)
  assert.equal(res.snapshot.id, 'snap-123')
  assert.equal(createdArgs.opts.cwd, '/tmp/worktree-42')
  assert.equal(createdArgs.opts.sessionId, 'task-task-42')
  assert.equal(updatedPatch.id, 'task-42')
  assert.equal(updatedPatch.patch.inceptionSnapshotId, 'snap-123')
})

test('createInceptionSnapshot: skips if task already has inceptionSnapshotId', async () => {
  let called = false
  const fakeEngine = {
    async createSnapshot() {
      called = true
      return { id: 'new-snap' }
    },
  }
  const ctx = { timeMachineEngine: fakeEngine }
  const task = { id: 'task-42', inceptionSnapshotId: 'existing-snap-99' }

  const res = await createInceptionSnapshot({ ctx, task })
  assert.equal(res.available, true)
  assert.equal(res.created, false)
  assert.equal(res.alreadyExists, true)
  assert.equal(res.snapshotId, 'existing-snap-99')
  assert.equal(called, false)
})

test('createInceptionSnapshot: soft degradation when time-machine absent', async () => {
  const res = await createInceptionSnapshot({ ctx: {}, task: { id: 'task-1' } })
  assert.equal(res.available, false)
  assert.equal(res.created, false)
})

test('createCheckpointSnapshot: creates manual checkpoint', async () => {
  let createdArgs = null
  const fakeEngine = {
    async createSnapshot(label, opts) {
      createdArgs = { label, opts }
      return { id: 'checkpoint-001', label, at: Date.now() }
    },
  }
  const ctx = { timeMachineEngine: fakeEngine }
  const task = { id: 'task-10', worktree: '/workspace/wt-10' }

  const res = await createCheckpointSnapshot({
    ctx,
    task,
    label: 'Pre-refactor state',
  })

  assert.equal(res.available, true)
  assert.equal(res.created, true)
  assert.equal(res.snapshot.id, 'checkpoint-001')
  assert.match(createdArgs.label, /Pre-refactor state/)
})

test('rollbackToSnapshot: rolls back to inception snapshot', async () => {
  let rollbackArgs = null
  const fakeEngine = {
    async rollbackSnapshot(id, opts) {
      rollbackArgs = { id, opts }
      return { rolledBack: true }
    },
  }
  const ctx = { timeMachineEngine: fakeEngine }
  const task = { id: 'task-1', worktree: '/tmp/wt-1', inceptionSnapshotId: 'snap-inc-1' }

  const res = await rollbackToSnapshot({ ctx, task })
  assert.equal(res.available, true)
  assert.equal(res.rolledBack, true)
  assert.equal(rollbackArgs.id, 'snap-inc-1')
  assert.equal(rollbackArgs.opts.confirm, true)
  assert.equal(rollbackArgs.opts.cwd, '/tmp/wt-1')
})

test('rollbackToSnapshot: returns error when no snapshot ID found', async () => {
  const fakeEngine = { async rollbackSnapshot() {} }
  const ctx = { timeMachineEngine: fakeEngine }
  const task = { id: 'task-no-snap' }

  const res = await rollbackToSnapshot({ ctx, task })
  assert.equal(res.error, 'no-snapshot-id')
})

test('listTaskSnapshots: lists snapshots from engine', async () => {
  const fakeEngine = {
    listSnapshots(sessionId) {
      return [{ id: 'snap-1', sessionId }]
    },
  }
  const ctx = { timeMachineEngine: fakeEngine }
  const task = { id: 'task-5' }

  const list = await listTaskSnapshots({ ctx, task })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'snap-1')
})


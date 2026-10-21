import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateDependencies,
  computeBlocksMap,
  checkTaskBlocked,
  checkMoveAllowed,
  findUnblockedDependents,
} from '../lib/dependencies.js'

test('validateDependencies: allows valid non-cyclic dependencies', () => {
  const tasks = {
    'task-1': { id: 'task-1', blockedBy: [] },
    'task-2': { id: 'task-2', blockedBy: ['task-1'] },
    'task-3': { id: 'task-3', blockedBy: ['task-2'] },
  }
  const getTask = (id) => tasks[id]

  // task-4 can depend on task-3
  const res = validateDependencies('task-4', ['task-3'], getTask)
  assert.equal(res.valid, true)
})

test('validateDependencies: rejects self-dependency', () => {
  const getTask = () => undefined
  const res = validateDependencies('task-1', ['task-1'], getTask)
  assert.equal(res.valid, false)
  assert.match(res.error, /cannot depend on itself/i)
})

test('validateDependencies: rejects direct circular dependency (A -> B -> A)', () => {
  const tasks = {
    'task-a': { id: 'task-a', blockedBy: ['task-b'] },
    'task-b': { id: 'task-b', blockedBy: [] },
  }
  const getTask = (id) => tasks[id]

  // Attempting to make task-b depend on task-a
  const res = validateDependencies('task-b', ['task-a'], getTask)
  assert.equal(res.valid, false)
  assert.match(res.error, /circular dependency/i)
})

test('validateDependencies: rejects indirect circular dependency (A -> B -> C -> A)', () => {
  const tasks = {
    'task-a': { id: 'task-a', blockedBy: ['task-b'] },
    'task-b': { id: 'task-b', blockedBy: ['task-c'] },
    'task-c': { id: 'task-c', blockedBy: [] },
  }
  const getTask = (id) => tasks[id]

  // Attempting to make task-c depend on task-a
  const res = validateDependencies('task-c', ['task-a'], getTask)
  assert.equal(res.valid, false)
  assert.match(res.error, /circular dependency/i)
})

test('computeBlocksMap: builds reverse mapping', () => {
  const allTasks = [
    { id: 'task-1', blockedBy: [] },
    { id: 'task-2', blockedBy: ['task-1'] },
    { id: 'task-3', blockedBy: ['task-1', 'task-2'] },
  ]
  const blocks = computeBlocksMap(allTasks)
  assert.deepEqual(blocks['task-1'].sort(), ['task-2', 'task-3'])
  assert.deepEqual(blocks['task-2'], ['task-3'])
  assert.deepEqual(blocks['task-3'], [])
})

test('checkTaskBlocked: reports blocked status correctly based on blocker column', () => {
  const tasks = {
    'blocker-1': { id: 'blocker-1', title: 'DB Schema', column: 'in-progress' },
    'blocker-2': { id: 'blocker-2', title: 'Auth API', column: 'done' },
  }
  const getTask = (id) => tasks[id]

  // Blocked because blocker-1 is in-progress
  const taskA = { id: 'task-a', blockedBy: ['blocker-1', 'blocker-2'] }
  const checkA = checkTaskBlocked(taskA, getTask)
  assert.equal(checkA.isBlocked, true)
  assert.equal(checkA.pendingBlockers.length, 1)
  assert.equal(checkA.pendingBlockers[0].id, 'blocker-1')

  // Not blocked because blocker-2 is done
  const taskB = { id: 'task-b', blockedBy: ['blocker-2'] }
  const checkB = checkTaskBlocked(taskB, getTask)
  assert.equal(checkB.isBlocked, false)
  assert.equal(checkB.pendingBlockers.length, 0)
})

test('checkMoveAllowed: prevents moving blocked task to in-progress', () => {
  const tasks = {
    'blocker-1': { id: 'blocker-1', title: 'DB Schema', column: 'backlog' },
  }
  const getTask = (id) => tasks[id]
  const blockedTask = { id: 'task-x', title: 'Write API', blockedBy: ['blocker-1'] }

  const moveRes = checkMoveAllowed(blockedTask, 'in-progress', getTask)
  assert.equal(moveRes.allowed, false)
  assert.match(moveRes.reason, /blocked by unfinished task/i)

  // Moving to other columns (e.g. backlog) is allowed
  const backlogMove = checkMoveAllowed(blockedTask, 'backlog', getTask)
  assert.equal(backlogMove.allowed, true)
})

test('findUnblockedDependents: identifies tasks unblocked by completing a blocker', () => {
  const tasks = [
    { id: 'task-1', title: 'Blocker 1', column: 'done', blockedBy: [] },
    { id: 'task-2', title: 'Dependent', column: 'backlog', blockedBy: ['task-1'] },
    { id: 'task-3', title: 'Still Blocked', column: 'backlog', blockedBy: ['task-1', 'task-4'] },
    { id: 'task-4', title: 'Blocker 2', column: 'in-progress', blockedBy: [] },
  ]
  const taskMap = Object.fromEntries(tasks.map((t) => [t.id, t]))
  const getTask = (id) => taskMap[id]

  const unblocked = findUnblockedDependents('task-1', getTask, () => tasks)
  assert.equal(unblocked.length, 1)
  assert.equal(unblocked[0].id, 'task-2')
})


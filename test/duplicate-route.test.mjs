import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskRouteHandler } from '../lib/server/task-handler.js'

function createMockStore(tasks = []) {
  return {
    listTasks: () => tasks,
    getTask: (id) => tasks.find((t) => t.id === id),
  }
}

test('POST /dsh-kanban/task/find-duplicates finds duplicates in board (#380)', async () => {
  const tasks = [
    { id: 'task-1', title: 'Implement biometric WebAuthn login', issueNumber: 50, repo: 'dsh-kanban', column: 'in-progress' },
    { id: 'task-2', title: 'Add WebAuthn biometric authentication flow', issueNumber: 51, repo: 'dsh-kanban', column: 'backlog' },
    { id: 'task-3', title: 'Completely different feature', issueNumber: 52, repo: 'dsh-kanban', column: 'done' },
  ]

  const store = createMockStore(tasks)
  let capturedStatus = 0
  let capturedBody = null

  const handler = createTaskRouteHandler({
    store,
    getConfig: () => ({}),
    eventHub: { broadcast: () => {} },
    ctx: { get: () => undefined },
    urlOf: (req) => new URL(req.url, 'http://localhost'),
    writeJson: (res, status, body) => {
      capturedStatus = status
      capturedBody = body
    },
    reply: (res, obj) => {
      capturedStatus = obj.status || 200
      capturedBody = obj.body || obj
    },
    readBody: async () => ({
      title: 'Implement WebAuthn login with biometric',
      excludeId: 'task-1',
      threshold: 0.35,
    }),
    rejectUntrusted: () => false,
  })

  const req = {
    method: 'POST',
    url: '/dsh-kanban/task/find-duplicates',
  }
  const res = {}

  await handler(req, res)

  assert.equal(capturedStatus, 200)
  assert.equal(capturedBody.ok, true)
  assert.ok(Array.isArray(capturedBody.duplicates))
  // task-1 is excluded via excludeId, task-2 should match
  assert.equal(capturedBody.duplicates.length, 1)
  assert.equal(capturedBody.duplicates[0].id, 'task-2')
  assert.equal(capturedBody.duplicates[0].issueNumber, 51)
  assert.ok(capturedBody.duplicates[0].percent > 40)
})

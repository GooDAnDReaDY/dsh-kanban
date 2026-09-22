import test from 'node:test'
import assert from 'node:assert/strict'
import { countActiveSessions, dispatchNextQueuedTask } from '../lib/launcher.js'

test('countActiveSessions считает только сессии в статусе running/busy/thinking (#214)', () => {
  const store = {
    listTasks: () => [
      { sessionId: 's1' },
      { sessionId: 's2' },
      { sessionId: 's3' },
    ],
  }
  const agents = {
    get: (id) => {
      if (id === 's1') return { status: 'running' }
      if (id === 's2') return { status: 'idle' }
      if (id === 's3') return { status: 'busy' }
      return undefined
    },
  }

  const active = countActiveSessions({ store, agents })
  assert.equal(active, 2)
})

test('dispatchNextQueuedTask не запускает задачи, если достигнут maxConcurrentSessions (#214)', async () => {
  const store = {
    listTasks: () => [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }],
    listQueuedTasks: () => [{ id: 'q1', title: 'Queued task' }],
  }
  const agents = {
    get: () => ({ status: 'running' }),
  }

  const res = await dispatchNextQueuedTask({
    agents,
    store,
    config: { maxConcurrentSessions: 3 },
  })

  assert.equal(res, null)
})
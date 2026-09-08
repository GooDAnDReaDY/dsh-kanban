import test from 'node:test'
import assert from 'node:assert/strict'
import { liveSessions } from '../lib/launcher.js'
import { handleSessionEvent } from '../lib/lifecycle.js'
import { freshStore } from './helpers.mjs'

test('liveSessions фильтрует дочерние сессии субагентов (#215)', () => {
  const { store, cleanup } = freshStore()
  try {
    store.createTask({
      id: 'task-root',
      title: 'Root Task',
      sessionId: 'sess-root',
      board: 'main',
    })
    store.createTask({
      id: 'task-child',
      title: 'Child Subagent Task',
      sessionId: 'sess-sub',
      board: 'main',
    })

    const agents = {
      get(id) {
        if (id === 'sess-root') {
          return { status: 'running' }
        }
        if (id === 'sess-sub') {
          return { status: 'running', origin: 'subagent', parentId: 'sess-root' }
        }
        return undefined
      },
    }

    const live = liveSessions({ store, agents })
    assert.equal(live.length, 1, 'в списке должна остаться только корневая сессия')
    assert.equal(live[0].sessionId, 'sess-root')
  } finally {
    cleanup()
  }
})

test('handleSessionEvent игнорирует события дочерних сессий субагентов (#215)', () => {
  const { store, cleanup } = freshStore()
  try {
    const task = store.createTask({
      id: 'task-main',
      title: 'Main Task',
      sessionId: 'sess-main',
      waiting: false,
    })

    // 1. Событие от субагента не должно менять waiting у задачи
    const subEventRes = handleSessionEvent({
      store,
      sessionId: 'sess-main',
      session: { id: 'sess-sub-child', origin: 'subagent', parentId: 'sess-main' },
      type: 'approval/asked',
    })
    assert.equal(subEventRes, undefined, 'событие субагента должно быть проигнорировано')
    assert.equal(store.getTask(task.id).waiting, false)

    // 2. Событие от корневой сессии меняет waiting
    const rootEventRes = handleSessionEvent({
      store,
      sessionId: 'sess-main',
      session: { id: 'sess-main' },
      type: 'approval/asked',
    })
    assert.ok(rootEventRes)
    assert.equal(rootEventRes.waiting, true)
    assert.equal(store.getTask(task.id).waiting, true)
  } finally {
    cleanup()
  }
})
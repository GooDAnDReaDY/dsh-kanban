import test from 'node:test'
import assert from 'node:assert/strict'
import { boardMoveDefinition } from '../lib/board-tool.js'

function makeMockStore(task) {
  return {
    listTasksBySession: () => [task],
    moveTask: () => {},
    addTransition: () => {},
  }
}

test('board_move разрешает перемещение, если воркспейсы совпадают (#216)', async () => {
  const task = {
    id: 'task-1',
    column: 'in-progress',
    workspaceId: 'ws-alpha',
    checklist: [],
  }
  const store = makeMockStore(task)
  const tool = boardMoveDefinition({ store, config: { workspaceClaimBoundaries: true } })

  const exec = {
    agent: {
      session: {
        id: 'sess-1',
        meta: { workspaceId: 'ws-alpha' },
      },
    },
  }

  const res = await tool.execute({ column: 'review' }, exec)
  assert.equal(res, 'Card moved to review.')
})

test('board_move блокирует перемещение задачи из чужого воркспейса (#216)', async () => {
  const task = {
    id: 'task-2',
    column: 'in-progress',
    workspaceId: 'ws-alpha',
    checklist: [],
  }
  const store = makeMockStore(task)
  const tool = boardMoveDefinition({ store, config: { workspaceClaimBoundaries: true } })

  const exec = {
    agent: {
      session: {
        id: 'sess-2',
        meta: { workspaceId: 'ws-beta' },
      },
    },
  }

  const res = await tool.execute({ column: 'review' }, exec)
  assert.ok(res.includes('Cannot move card: task belongs to workspace "ws-alpha", but current session belongs to workspace "ws-beta"'))
})

test('board_move разрешает перемещение без ограничений, если workspaceClaimBoundaries: false (#216)', async () => {
  const task = {
    id: 'task-3',
    column: 'in-progress',
    workspaceId: 'ws-alpha',
    checklist: [],
  }
  const store = makeMockStore(task)
  const tool = boardMoveDefinition({ store, config: { workspaceClaimBoundaries: false } })

  const exec = {
    agent: {
      session: {
        id: 'sess-3',
        meta: { workspaceId: 'ws-beta' },
      },
    },
  }

  const res = await tool.execute({ column: 'review' }, exec)
  assert.equal(res, 'Card moved to review.')
})
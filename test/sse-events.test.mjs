import test from 'node:test'
import assert from 'node:assert/strict'
import { KanbanEventHub } from '../lib/events.js'

test('KanbanEventHub регистрирует клиента и шлёт connected (#222)', () => {
  const hub = new KanbanEventHub({ heartbeatIntervalMs: 60000 })
  const written = []
  const headers = {}
  const fakeRes = {
    writeHead(code, h) { Object.assign(headers, h) },
    write(data) { written.push(data) },
    end() {},
  }
  const fakeReq = {
    on(event, cb) {},
  }

  const cleanup = hub.handleSseRequest(fakeReq, fakeRes)
  assert.equal(hub.getClientCount(), 1)
  assert.equal(headers['Content-Type'], 'text/event-stream')
  assert.ok(written.some((w) => w.includes(':connected')))

  cleanup()
  assert.equal(hub.getClientCount(), 0)
  hub.closeAll()
})

test('KanbanEventHub broadcast отправляет сообщение всем подписанным клиентам (#222)', () => {
  const hub = new KanbanEventHub({ heartbeatIntervalMs: 60000 })
  const written1 = []
  const written2 = []
  const fakeRes1 = {
    writeHead() {},
    write(data) { written1.push(data) },
    end() {},
  }
  const fakeRes2 = {
    writeHead() {},
    write(data) { written2.push(data) },
    end() {},
  }
  const fakeReq = { on() {} }

  hub.handleSseRequest(fakeReq, fakeRes1)
  hub.handleSseRequest(fakeReq, fakeRes2)

  assert.equal(hub.getClientCount(), 2)
  const sent = hub.broadcast('task:change', { taskId: 'task-1', action: 'moved' })
  assert.equal(sent, 2)
  assert.ok(written1.some((w) => w.includes('event: task:change') && w.includes('"taskId":"task-1"')))
  assert.ok(written2.some((w) => w.includes('event: task:change') && w.includes('"action":"moved"')))

  hub.closeAll()
  assert.equal(hub.getClientCount(), 0)
})

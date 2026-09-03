import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PowerInhibitor } from '../lib/power.js'

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = {
    destroyed: false,
    end() { this.destroyed = true },
  }
  child.kill = () => {
    child.killed = true
    child.emit('exit', 0)
  }
  return child
}

test('PowerInhibitor стартует выключенным', () => {
  const inhibitor = new PowerInhibitor()
  const snap = inhibitor.snapshot()
  assert.equal(snap.enabled, false)
  assert.equal(snap.reasons, 0)
  assert.equal(snap.phase, 'disabled')
})

test('PowerInhibitor запускает хелпер только при enabled и reasons > 0', () => {
  let spawnCalls = []
  let currentChild = null
  const mockSpawn = (cmd, args) => {
    spawnCalls.push({ cmd, args })
    currentChild = createMockChild()
    return currentChild
  }

  const inhibitor = new PowerInhibitor({
    platform: 'win32',
    spawn: mockSpawn,
  })

  // Reasons без включения не запускают хелпер
  inhibitor.acquire()
  assert.equal(inhibitor.snapshot().reasons, 1)
  assert.equal(spawnCalls.length, 0)

  // Включаем -> должен запуститься хелпер
  inhibitor.setEnabled(true)
  assert.equal(spawnCalls.length, 1)
  assert.equal(inhibitor.snapshot().phase, 'running')

  // Дополнительный acquire не перезапускает
  inhibitor.acquire()
  assert.equal(spawnCalls.length, 1)
  assert.equal(inhibitor.snapshot().reasons, 2)

  // Первый release держит
  inhibitor.release()
  assert.equal(spawnCalls.length, 1)
  assert.equal(inhibitor.snapshot().reasons, 1)

  // Второй release гасит хелпер
  inhibitor.release()
  assert.equal(inhibitor.snapshot().reasons, 0)
  assert.equal(currentChild.killed, true)
  assert.equal(inhibitor.snapshot().phase, 'disabled')
})

test('PowerInhibitor останавливает хелпер при выключении setEnabled(false)', () => {
  let currentChild = null
  const mockSpawn = () => {
    currentChild = createMockChild()
    return currentChild
  }

  const inhibitor = new PowerInhibitor({
    platform: 'darwin',
    spawn: mockSpawn,
  })

  inhibitor.setEnabled(true)
  inhibitor.acquire()
  assert.equal(inhibitor.snapshot().phase, 'running')

  inhibitor.setEnabled(false)
  assert.equal(currentChild.killed, true)
  assert.equal(inhibitor.snapshot().phase, 'disabled')
})

test('PowerInhibitor штатно обрабатывает неизвестную платформу', () => {
  const inhibitor = new PowerInhibitor({ platform: 'freebsd' })
  inhibitor.setEnabled(true)
  inhibitor.acquire()
  assert.equal(inhibitor.snapshot().phase, 'unsupported')
})

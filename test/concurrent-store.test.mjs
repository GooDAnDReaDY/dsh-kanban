import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../lib/store.js'

test('PRAGMA busy_timeout: concurrent writes across multiple connections succeed without database locked (#266)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-busy-'))
  const store1 = openStore({ dir })
  const store2 = openStore({ dir })

  try {
    const task1 = store1.createTask({
      board: 'main',
      col: 'backlog',
      title: 'Task from conn 1',
    })
    assert.ok(task1.id)

    const task2 = store2.createTask({
      board: 'main',
      col: 'backlog',
      title: 'Task from conn 2',
    })
    assert.ok(task2.id)

    // Concurrent updates
    store1.updateTask(task1.id, { title: 'Updated task 1' })
    store2.updateTask(task2.id, { title: 'Updated task 2' })

    const readBack1 = store2.getTask(task1.id)
    assert.equal(readBack1.title, 'Updated task 1')

    const readBack2 = store1.getTask(task2.id)
    assert.equal(readBack2.title, 'Updated task 2')
  } finally {
    try { store1.close() } catch {}
    try { store2.close() } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

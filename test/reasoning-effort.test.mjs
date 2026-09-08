import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('store поддерживает reasoningEffort в задачах (#217)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-reasoning-'))
  try {
    const store = openStore({ dir })
    const task = store.createTask({
      id: 't-reasoning',
      title: 'Test Reasoning Effort',
      reasoningEffort: 'high',
    })

    assert.equal(task.reasoningEffort, 'high')

    const updated = store.updateTask('t-reasoning', { reasoningEffort: 'low' })
    assert.equal(updated.reasoningEffort, 'low')

    const fetched = store.getTask('t-reasoning')
    assert.equal(fetched.reasoningEffort, 'low')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../lib/store.js'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importBoard } from '../lib/routes.js'

test('backupDatabase создаёт файл бэкапа и выполняет ротацию (#224)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-backup-test-'))
  try {
    const store = openStore({ dir })
    store.createTask({ id: 't1', title: 'Task 1' })

    const res = store.backupDatabase()
    assert.ok(res.backup.startsWith('kanban-backup-'))
    assert.ok(res.backup.endsWith('.db'))

    const backupsDir = join(dir, 'backups')
    const files = readdirSync(backupsDir)
    assert.equal(files.length, 1)
    assert.equal(files[0], res.backup)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importBoard автоматически вызывает backupDatabase и возвращает метаданные (#224)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-import-test-'))
  try {
    const store = openStore({ dir })
    store.createTask({ id: 'old-task', title: 'Old' })

    const input = {
      version: 1,
      boards: [{ id: 'main', title: 'Main', kind: 'project' }],
      tasks: [{ id: 'new-task', title: 'New', board: 'main' }],
    }

    const out = importBoard({ store, input })
    assert.equal(out.imported, 1)
    assert.ok(typeof out.backup === 'string' && out.backup.startsWith('kanban-backup-'))

    const backupsDir = join(dir, 'backups')
    const files = readdirSync(backupsDir)
    assert.equal(files.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, secureStorePermissions } from '../lib/store.js'

function getOctalMode(path) {
  return statSync(path).mode & 0o777
}

test('new store directory and files are created with 0700 and 0600 permissions (#298)', () => {
  if (process.platform === 'win32') return // Windows does not use POSIX permission bits
  const parent = mkdtempSync(join(tmpdir(), 'kanban-perm-'))
  const storeDir = join(parent, 'nested-kanban-store')

  const store = openStore({ dir: storeDir })

  try {
    assert.equal(getOctalMode(storeDir), 0o700, 'storeDir must have mode 0700')
    const dbPath = join(storeDir, 'kanban.db')
    assert.equal(getOctalMode(dbPath), 0o600, 'kanban.db must have mode 0600')

    const walPath = join(storeDir, 'kanban.db-wal')
    try {
      assert.equal(getOctalMode(walPath), 0o600, 'kanban.db-wal must have mode 0600')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }

    const shmPath = join(storeDir, 'kanban.db-shm')
    try {
      assert.equal(getOctalMode(shmPath), 0o600, 'kanban.db-shm must have mode 0600')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  } finally {
    try { store.close() } catch { /* ignore */ }
    rmSync(parent, { recursive: true, force: true })
  }
})

test('legacy store with 0755 directory and 0644 files is automatically repaired to 0700 and 0600 on openStore (#298)', () => {
  if (process.platform === 'win32') return
  const parent = mkdtempSync(join(tmpdir(), 'kanban-legacy-'))
  const storeDir = join(parent, 'store')
  mkdirSync(storeDir, { recursive: true, mode: 0o755 })
  chmodSync(storeDir, 0o755)

  // First create a database and close it
  const initialStore = openStore({ dir: storeDir })
  initialStore.createTask({ board: 'main', column: 'backlog', title: 'Task 1' })
  initialStore.close()

  // Emulate legacy world-readable permissions
  chmodSync(storeDir, 0o755)
  chmodSync(join(storeDir, 'kanban.db'), 0o644)
  assert.equal(getOctalMode(storeDir), 0o755, 'pre-condition: storeDir is 0755')
  assert.equal(getOctalMode(join(storeDir, 'kanban.db')), 0o644, 'pre-condition: kanban.db is 0644')

  // Now open the store again (as DSH startup would)
  const reopened = openStore({ dir: storeDir })

  try {
    assert.equal(getOctalMode(storeDir), 0o700, 'repaired storeDir must have mode 0700')
    assert.equal(getOctalMode(join(storeDir, 'kanban.db')), 0o600, 'repaired kanban.db must have mode 0600')
  } finally {
    try { reopened.close() } catch { /* ignore */ }
    rmSync(parent, { recursive: true, force: true })
  }
})

test('backupDatabase creates backups directory as 0700 and backup files as 0600, and repairs legacy backups (#298)', () => {
  if (process.platform === 'win32') return
  const parent = mkdtempSync(join(tmpdir(), 'kanban-backup-perm-'))
  const storeDir = join(parent, 'store')

  const store = openStore({ dir: storeDir })

  try {
    store.createTask({ board: 'main', column: 'backlog', title: 'Task to backup' })
    const { path: backupPath } = store.backupDatabase()
    const backupsDir = join(storeDir, 'backups')

    assert.equal(getOctalMode(backupsDir), 0o700, 'backups directory must have mode 0700')
    assert.equal(getOctalMode(backupPath), 0o600, 'backup file must have mode 0600')

    // Emulate legacy permissions on backup
    chmodSync(backupsDir, 0o755)
    chmodSync(backupPath, 0o644)
    assert.equal(getOctalMode(backupsDir), 0o755)
    assert.equal(getOctalMode(backupPath), 0o644)

    // Call secureStorePermissions (or store.securePermissions())
    secureStorePermissions(storeDir)

    assert.equal(getOctalMode(backupsDir), 0o700, 'repaired backups dir must be 0700')
    assert.equal(getOctalMode(backupPath), 0o600, 'repaired backup file must be 0600')
  } finally {
    try { store.close() } catch { /* ignore */ }
    rmSync(parent, { recursive: true, force: true })
  }
})

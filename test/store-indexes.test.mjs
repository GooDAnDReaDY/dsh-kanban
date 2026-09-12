import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { freshStore } from './helpers.mjs'

test('новые композитные индексы создаются в базе данных', () => {
  const { dir } = freshStore()
  const db = new DatabaseSync(join(dir, 'kanban.db'))
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
  const names = rows.map(r => r.name)
  
  assert.ok(names.includes('tasks_board_active'), 'индекс tasks_board_active отсутствует')
  assert.ok(names.includes('tasks_gitea_issue'), 'индекс tasks_gitea_issue отсутствует')
  assert.ok(names.includes('tasks_cron_next'), 'индекс tasks_cron_next отсутствует')
  assert.ok(names.includes('tasks_queued'), 'индекс tasks_queued отсутствует')
})

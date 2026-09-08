import test from 'node:test'
import assert from 'node:assert/strict'
import { exportTasksCsv } from '../lib/routes.js'

test('exportTasksCsv генерирует CSV с UTF-8 BOM и экранированием (#223)', () => {
  const store = {
    listTasks: () => [
      {
        id: 'task-1',
        title: 'Тест, "кавычки" и запятая',
        column: 'in-progress',
        priority: 'high',
        repo: 'dsh-kanban',
        issueNumber: 223,
        assignee: 'antigravity',
        model: 'deepseek-r1',
        provider: 'deepseek',
        reasoningEffort: 'high',
        workspaceId: 'ws-main',
        branch: 'feat/csv-export',
        createdAt: 1773000000000,
        updatedAt: 1773001000000,
      },
    ],
  }

  const csv = exportTasksCsv({ store, board: 'main' })

  // Проверка UTF-8 BOM
  assert.ok(csv.startsWith('\uFEFF'), 'CSV должен начинаться с UTF-8 BOM')

  // Проверка экранирования кавычек и запятых
  assert.ok(csv.includes('"Тест, ""кавычки"" и запятая"'))
  assert.ok(csv.includes('high'))
  assert.ok(csv.includes('deepseek-r1'))
})
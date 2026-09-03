import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers.mjs'

test('store сохраняет и обновляет runs, усекая до 20 записей', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main',
    column: 'backlog',
    title: 'Run test task',
  })

  assert.deepEqual(task.runs, [])

  // Добавляем 25 запусков
  for (let i = 1; i <= 25; i++) {
    store.recordTaskRun(task.id, {
      id: `run-${i}`,
      sessionId: `session-${i}`,
      startedAt: 1000 + i,
      result: undefined,
    })
  }

  const updated = store.getTask(task.id)
  assert.equal(updated.runs.length, 20)
  assert.equal(updated.runs[0].id, 'run-25') // самый свежий в начале
  assert.equal(updated.runs[19].id, 'run-6')

  // Обновляем результат последнего запуска
  store.updateTaskRun(task.id, 'run-25', {
    endedAt: 2000,
    result: 'succeeded',
  })

  const afterUpdate = store.getTask(task.id)
  assert.equal(afterUpdate.runs[0].result, 'succeeded')
  assert.equal(afterUpdate.runs[0].endedAt, 2000)

  cleanup()
})

test('store фильтрует наступившие задачи listDueTasks', () => {
  const { store, cleanup } = freshStore()

  // Задача с кроном в будущем (через 10 минут)
  store.createTask({
    board: 'main',
    title: 'Future task',
    cron: '*/15 * * * *',
    nextRunAt: 2000,
  })

  // Задача с наступившим кроном (время 1000)
  const dueTask = store.createTask({
    board: 'main',
    title: 'Due task',
    cron: '0 9 * * *',
    nextRunAt: 1000,
  })

  // Задача без крона
  store.createTask({
    board: 'main',
    title: 'No cron task',
  })

  const due = store.listDueTasks(1500)
  assert.equal(due.length, 1)
  assert.equal(due[0].id, dueTask.id)

  cleanup()
})

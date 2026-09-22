import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers.mjs'
import { runTask } from '../lib/launcher.js'
import { handleSessionEvent } from '../lib/lifecycle.js'
import { confirmPermission, updateTask } from '../lib/routes.js'

function fakeAgents() {
  const sent = []
  const makeAgent = (id) => ({
    whenIdle: async () => {},
    followup: (m) => sent.push(m),
    session: { id },
  })
  const agents = {
    get: () => undefined,
    resume: async () => { throw new Error('not resumable') },
    create: async () => ({ agent: makeAgent('session-123'), dispose() {} }),
  }
  return { agents, sent }
}

test('Permission Confirmation Gate блокирует запуск до подтверждения человеком', async () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main',
    title: 'High permission task',
    permission: 'danger-full-access',
  })

  const config = {
    permissionGateEnabled: true,
    sessionDefaultPermission: 'read-only',
    worktreeIsolation: false,
  }

  const { agents } = fakeAgents()

  // Попытка запуска без подтверждения прав должна выбросить ошибку
  await assert.rejects(
    async () => {
      await runTask({
        agents, store, task, config,
        provider: 'test-prov', model: 'test-mod',
        mintSessionId: () => 'sess-1',
        createMessage: (m) => m,
      })
    },
    (err) => err.key === 'permission-unconfirmed' && err.status === 403,
  )

  // Человек подтверждает права через маршрут
  const confirmed = confirmPermission({ store, id: task.id })
  assert.ok(confirmed.task.permissionConfirmedAt > 0)

  // Теперь запуск проходит успешно
  const res = await runTask({
    agents, store, task: confirmed.task, config,
    provider: 'test-prov', model: 'test-mod',
    mintSessionId: () => 'sess-1',
    createMessage: (m) => m,
  })
  assert.ok(res.sessionId)

  // Правка прав сбрасывает подтверждение (anti-swap)
  const edited = updateTask({
    store, id: task.id,
    input: { permission: 'workspace-write' },
  })
  assert.equal(edited.task.permissionConfirmedAt, 0)

  cleanup()
})

test('PROGRESSDUMP передаёт вводный бриф и подхватывает срез из событий сессии', async () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main',
    title: 'Dump task',
    progressDump: [
      '<<<PROGRESSDUMP',
      'Цель: Рефакторинг store.js',
      'Прогресс: Написаны юнит-тесты',
      'Следующие шаги: Запустить линтер',
      '>>>PROGRESSDUMP',
    ].join('\n'),
  })

  const config = {
    progressDumpEnabled: true,
    worktreeIsolation: false,
  }

  const { agents, sent } = fakeAgents()
  await runTask({
    agents, store, task, config,
    provider: 'test-prov', model: 'test-mod',
    mintSessionId: () => 'session-123',
    createMessage: (m) => m,
    text: 'Продолжай работу.',
  })

  // Проверяем, что в первое сообщение попал заголовок эстафеты
  const msgText = sent[0].content[0].text
  assert.ok(msgText.includes('## 📋 Эстафета задачи (PROGRESSDUMP)'))
  assert.ok(msgText.includes('Рефакторинг store.js'))
  assert.ok(msgText.includes('Продолжай работу.'))

  // Имитируем ответ агента со свежим PROGRESSDUMP
  handleSessionEvent({
    store,
    sessionId: 'session-123',
    type: 'turn/completed',
    text: [
      'Я закончил шаг 1!',
      '<<<PROGRESSDUMP',
      'Цель: Рефакторинг store.js',
      'Прогресс: Линтер пройден без ошибок',
      'Следующие шаги: Собрать релиз',
      '>>>PROGRESSDUMP',
    ].join('\n'),
  })

  const updatedTask = store.getTask(task.id)
  assert.ok(updatedTask.progressDump.includes('Линтер пройден без ошибок'))
  assert.equal(updatedTask.runs[0].result, 'succeeded')

  cleanup()
})

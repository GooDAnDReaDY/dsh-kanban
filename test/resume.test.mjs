import test from 'node:test'
import assert from 'node:assert/strict'
import { runTask, messageFor } from '../lib/launcher.js'
import { freshStore } from './helpers.mjs'
import { withDefaults } from '../lib/config.js'

test('messageFor генерирует преамбулу продолжения в режиме resume (#226)', () => {
  const task = {
    id: 'task-1',
    title: 'Resume feature',
    worktree: '/tmp/worktree/task-1',
    branch: 'task/1-resume',
  }
  const msg = messageFor(task, {}, '', { resume: true })
  assert.ok(msg.includes('### ↻ Режим продолжения работы над задачей'), 'должен содержать заголовок продолжения')
  assert.ok(msg.includes('/tmp/worktree/task-1'), 'должен указывать путь к воркдереву')
  assert.ok(msg.includes('task/1-resume'), 'должен указывать имя ветки')
  assert.ok(msg.includes('Сохраняй существующие изменения'), 'должен инструктировать сохранять изменения')
})

test('runTask с resume: true отправляет событие task-resume и фиксирует переход (#226)', async () => {
  const { store, cleanup } = freshStore()
  try {
    const createdTask = store.createTask({
      id: 'task-resume-test',
      title: 'Task to resume',
      column: 'in-progress',
      worktree: '/tmp/worktree/test',
      branch: 'task/test-branch',
    })

    const sent = []
    const agents = {
      get: () => undefined,
      create: async () => ({
        agent: {
          session: { id: 'session-resume-1' },
          whenIdle: async () => {},
          followup: (m) => sent.push(m),
        },
        dispose() {},
      }),
    }

    const out = await runTask({
      agents,
      store,
      task: createdTask,
      config: withDefaults(),
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      mintSessionId: () => 'session-resume-1',
      createMessage: (m) => m,
      cwdOf: () => process.cwd(),
      resume: true,
    })

    assert.equal(out.sessionId, 'session-resume-1')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].source.form, 'task-resume', 'сообщение должно иметь форму task-resume')
    assert.ok(sent[0].content[0].text.includes('### ↻ Режим продолжения работы над задачей'))

    const transitions = store.listTransitions(createdTask.id)
    const resumeTransition = transitions.find((t) => t.detail?.includes('продолжение работы над задачей'))
    assert.ok(resumeTransition, 'в журнале задачи должен появиться переход продолжения работы')
  } finally {
    cleanup()
  }
})
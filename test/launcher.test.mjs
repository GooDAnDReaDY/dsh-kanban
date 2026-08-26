import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers.mjs'
import { withDefaults } from '../lib/config.js'
import { buildStartMessage, resolveCwd, startTask, resolveModel } from '../lib/launcher.js'

const config = withDefaults({ defaultProjectRoot: '/projects' })

/** Заглушка службы агентов: ни одной живой сессии в тестах. */
function stubAgents(onCreate) {
  const sent = []
  const agents = {
    create: async (opts) => {
      if (onCreate) onCreate(opts)
      return {
        agent: {
          whenIdle: async () => {},
          followup: (m) => sent.push(m),
          session: { id: 'kanban-live-1' },
        },
        dispose() {},
      }
    },
  }
  return { agents, sent }
}

const createMessage = (m) => m

test('встроенный шаблон подставляет поля задачи', () => {
  const task = {
    repo: 'dsh-kanban', issueNumber: 12, title: 'Дробный индекс',
    body: 'Наивный индекс переписывает всю колонку.',
    issueUrl: 'https://example.invalid/o/r/issues/12',
  }
  const text = buildStartMessage(task, withDefaults({}))
  assert.ok(text.includes('dsh-kanban#12'))
  assert.ok(text.includes('Дробный индекс'))
  assert.ok(text.includes('Наивный индекс переписывает всю колонку.'))
  assert.ok(text.includes('https://example.invalid/o/r/issues/12'))
})

test('своя задача без issue не порождает undefined и лишний номер', () => {
  const text = buildStartMessage({ title: 'Прибраться в логах' }, withDefaults({}))
  assert.ok(!text.includes('undefined'))
  assert.ok(!text.includes('#'))
  assert.ok(!text.includes('Ссылка:'))
  assert.ok(text.includes('Прибраться в логах'))
})

test('свой шаблон вытесняет встроенный', () => {
  const text = buildStartMessage({ title: 'A', repo: 'r', issueNumber: 1 },
    withDefaults({ startPrompt: 'Сделай {title} в {repo}' }))
  assert.equal(text, 'Сделай A в r')
})

test('сообщение не называет имя ветки', () => {
  // Имя ветки выбирает агент после preflight — подсказывать его нельзя.
  const text = buildStartMessage({ repo: 'r', issueNumber: 1, title: 'A', body: '' }, withDefaults({}))
  assert.ok(!/feat\//.test(text))
  assert.ok(!/fix\//.test(text))
})

test('сообщение велит начать с preflight', () => {
  const text = buildStartMessage({ repo: 'r', issueNumber: 1, title: 'A' }, withDefaults({}))
  assert.ok(text.includes('preflight'))
})

test('cwd абсолютен и указывает на корень проекта', () => {
  const cwd = resolveCwd({ repo: 'dsh-kanban' }, config)
  assert.ok(cwd.startsWith('/'))
  assert.ok(cwd.endsWith('dsh-kanban'))
})

test('пустой корень откатывается на рабочую папку процесса', () => {
  const cwd = resolveCwd({ repo: 'x' }, withDefaults({}), () => '/где-то')
  assert.equal(cwd, '/где-то/x')
})

test('задача без репозитория запускается в самом корне', () => {
  assert.equal(resolveCwd({}, config), '/projects')
})

test('repo не может выйти за пределы корня', () => {
  // Имя приходит из данных Gitea, а не из кода.
  assert.throws(() => resolveCwd({ repo: '../../etc' }, config))
  assert.throws(() => resolveCwd({ repo: '..' }, config))
})

test('неабсолютный корень отвергается', () => {
  assert.throws(() => resolveCwd({ repo: 'x' }, withDefaults({ defaultProjectRoot: 'projects' })))
})

test('startTask поднимает сессию и переносит задачу', async () => {
  const { store, cleanup } = freshStore()
  const { agents, sent } = stubAgents()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A', repo: 'r' })
  const out = await startTask({
    agents, store, task, config, provider: 'anthropic', model: 'claude-opus-5',
    sessionId: 'kanban-1-abc', createMessage,
  })
  assert.equal(out.sessionId, 'kanban-live-1')
  const saved = store.getTask(task.id)
  assert.equal(saved.column, 'in-progress')
  assert.equal(saved.model, 'claude-opus-5')
  assert.equal(saved.sessionId, 'kanban-live-1')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].content.includes('A'))
  assert.equal(sent[0].source.plugin, 'dsh-kanban')
  const log = store.listTransitions(task.id)
  assert.equal(log[0].source, 'session')
  assert.ok(log[0].detail.includes('claude-opus-5'))
  cleanup()
})

test('startTask отдаёт агенту рабочую папку абсолютным путём', async () => {
  const { store, cleanup } = freshStore()
  let seen
  const { agents } = stubAgents((opts) => { seen = opts })
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A', repo: 'r' })
  await startTask({
    agents, store, task, config, provider: 'p', model: 'm',
    sessionId: 'kanban-1-abc', createMessage,
  })
  assert.equal(seen.meta.cwd, '/projects/r')
  assert.equal(seen.agentOptions.provider, 'p')
  assert.equal(seen.agentOptions.model, 'm')
  cleanup()
})

test('падение запуска не двигает карточку', async () => {
  const { store, cleanup } = freshStore()
  const agents = { create: async () => { throw new Error('нет провайдера') } }
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A', repo: 'r' })
  await assert.rejects(() => startTask({
    agents, store, task, config, provider: 'x', model: 'y',
    sessionId: 'kanban-1-abc', createMessage,
  }))
  const saved = store.getTask(task.id)
  assert.equal(saved.column, 'backlog')
  assert.equal(saved.sessionId, null)
  assert.equal(store.listTransitions(task.id).length, 0)
  cleanup()
})

test('повторный запуск уже идущей задачи не плодит лишний переход', async () => {
  const { store, cleanup } = freshStore()
  const { agents } = stubAgents()
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A', repo: 'r' })
  await startTask({
    agents, store, task, config, provider: 'p', model: 'm',
    sessionId: 'kanban-1-abc', createMessage,
  })
  assert.equal(store.listTransitions(task.id).length, 0)
  cleanup()
})

test('модель берётся из выбора, затем из умолчания харнесса', () => {
  assert.deepEqual(
    resolveModel({ requested: { provider: 'a', model: 'b' }, fallback: { provider: 'c', model: 'd' } }),
    { provider: 'a', model: 'b' })
  assert.deepEqual(
    resolveModel({ requested: {}, fallback: { provider: 'c', model: 'd' } }),
    { provider: 'c', model: 'd' })
})

test('без модели маршрут отказывает внятно, а не падает', () => {
  const out = resolveModel({ requested: {}, fallback: {} })
  assert.equal(out.status, 409)
  assert.equal(out.error, 'model-not-selected')
})

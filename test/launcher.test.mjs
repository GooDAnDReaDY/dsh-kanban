import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers.mjs'
import { withDefaults } from '../lib/config.js'
import { buildStartMessage, resolveCwd, runTask, obtainAgent, resolveModel } from '../lib/launcher.js'

const config = withDefaults({ defaultProjectRoot: '/projects' })

/**
 * Заглушка службы агентов.
 *
 * По умолчанию живых сессий нет и возобновление не удаётся — то есть каждый
 * запуск поднимает новую. Отдельные проверки подменяют `live` и `resumable`.
 */
function stubAgents({ onCreate, live, resumable } = {}) {
  const sent = []
  const calls = { create: 0, get: 0, resume: 0 }
  const makeAgent = (id) => ({
    whenIdle: async () => {},
    followup: (m) => sent.push(m),
    session: { id },
  })
  const agents = {
    get(id) {
      calls.get += 1
      return live === id ? makeAgent(id) : undefined
    },
    async resume({ resumeSessionId }) {
      calls.resume += 1
      if (resumable !== resumeSessionId) throw new Error('сессия не сохранена')
      return { agent: makeAgent(resumeSessionId), dispose() {} }
    },
    async create(opts) {
      calls.create += 1
      if (onCreate) onCreate(opts)
      return { agent: makeAgent('kanban-live-1'), dispose() {} }
    },
  }
  return { agents, sent, calls }
}

const mintSessionId = () => 'kanban-live-1'

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

test('своей задаче НЕ приказывают делать preflight и worktree', () => {
  // Задача «привет» не имеет ни репозитория, ни issue. Распоряжение про
  // preflight отправляло агента искать репозитории вместо работы по written.
  const text = buildStartMessage({ title: 'привет' }, withDefaults({}))
  assert.ok(!text.includes('preflight'), 'своей задаче достался хвост про воркфлоу')
  assert.ok(!text.includes('worktree'))
  assert.ok(!text.includes('origin/main'))
  assert.ok(text.includes('привет'))
})

test('задача из issue хвост про воркфлоу получает', () => {
  const text = buildStartMessage(
    { title: 'A', repo: 'r', issueNumber: 7, issueUrl: 'https://example.invalid/i/7' },
    withDefaults({}))
  assert.ok(text.includes('preflight'))
  assert.ok(text.includes('r#7'))
  assert.ok(text.includes('https://example.invalid/i/7'))
})

test('постоянная приписка добавляется к обоим видам задач', () => {
  const cfg = withDefaults({ replyInstruction: 'Отвечай по-русски.' })
  assert.ok(buildStartMessage({ title: 'привет' }, cfg).endsWith('Отвечай по-русски.'))
  assert.ok(buildStartMessage({ title: 'A', repo: 'r', issueNumber: 1 }, cfg).endsWith('Отвечай по-русски.'))
})

test('пустая приписка ничего не дописывает', () => {
  const text = buildStartMessage({ title: 'привет' }, withDefaults({ replyInstruction: '   ' }))
  assert.ok(text.startsWith('Задача: привет'))
  assert.ok(!text.includes('Отвечай'))
})

test('своей задаче воркфлоу предлагается по условию, а не приказывается', () => {
  // Задача может быть любой — «найди мне информацию» в том числе. Решает агент
  // по содержанию, а не доска заранее.
  const text = buildStartMessage({ title: 'найди мне информацию про X' }, withDefaults({}))
  assert.ok(text.includes('Если задача окажется про код проекта'))
  assert.ok(!text.includes('preflight'))
})

test('приписка добавляется и к своему шаблону', () => {
  const text = buildStartMessage({ title: 'A' },
    withDefaults({ startPrompt: 'Сделай {title}', replyInstruction: 'По-русски.' }))
  assert.ok(text.startsWith('Сделай A'))
  assert.ok(text.endsWith('По-русски.'))
  assert.ok(!text.includes('Задача:'), 'свой шаблон не должен обрастать встроенным')
})

test('между кусками нет пустых провалов', () => {
  // Пустое тело задачи не должно оставлять дыру в три перевода строки.
  const gap = String.fromCharCode(10, 10, 10)
  const text = buildStartMessage({ title: 'A', body: '' }, withDefaults({ replyInstruction: '' }))
  assert.ok(!text.includes(gap), 'в сообщении осталась пустая дыра')
})

test('свой шаблон вытесняет встроенный', () => {
  const text = buildStartMessage({ title: 'A', repo: 'r', issueNumber: 1 },
    withDefaults({ startPrompt: 'Сделай {title} в {repo}', replyInstruction: '' }))
  assert.equal(text, 'Сделай A в r')
})

test('свой шаблон не обрастает ни воркфлоу, ни условием', () => {
  const text = buildStartMessage({ title: 'A', repo: 'r', issueNumber: 1 },
    withDefaults({ startPrompt: 'Сделай {title}', replyInstruction: '' }))
  assert.ok(!text.includes('preflight'))
  assert.ok(!text.includes('Если задача окажется'))
})

test('сообщение не называет имя ветки', () => {
  // Имя ветки выбирает агент после preflight — подсказывать его нельзя.
  const text = buildStartMessage({ repo: 'r', issueNumber: 1, title: 'A', body: '' }, withDefaults({}))
  assert.ok(!/feat\//.test(text))
  assert.ok(!/fix\//.test(text))
})

test('сообщение задачи из issue велит начать с preflight', () => {
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
  const out = await runTask({
    agents, store, task, config, provider: 'anthropic', model: 'claude-opus-5',
    mintSessionId, createMessage,
  })
  assert.equal(out.sessionId, 'kanban-live-1')
  const saved = store.getTask(task.id)
  assert.equal(saved.column, 'in-progress')
  assert.equal(saved.model, 'claude-opus-5')
  assert.equal(saved.sessionId, 'kanban-live-1')
  assert.equal(sent.length, 1)
  // Проверяем именно ФОРМУ: строка тоже имеет includes, и прежняя проверка
  // пропустила бы её — а ядро на строке падает с «content.some is not a function».
  assert.ok(Array.isArray(sent[0].content), 'содержимое обязано быть массивом блоков')
  assert.equal(sent[0].content.length, 1)
  assert.equal(sent[0].content[0].type, 'text')
  assert.ok(sent[0].content[0].text.includes('A'))
  assert.equal(sent[0].source.plugin, 'dsh-kanban')
  const log = store.listTransitions(task.id)
  assert.equal(log[0].source, 'session')
  assert.ok(log[0].detail.includes('claude-opus-5'))
  cleanup()
})

test('startTask отдаёт агенту рабочую папку абсолютным путём', async () => {
  const { store, cleanup } = freshStore()
  let seen
  const { agents } = stubAgents({ onCreate: (opts) => { seen = opts } })
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A', repo: 'r' })
  await runTask({
    agents, store, task, config, provider: 'p', model: 'm',
    mintSessionId, createMessage,
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
  await assert.rejects(() => runTask({
    agents, store, task, config, provider: 'x', model: 'y',
    mintSessionId, createMessage,
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
  await runTask({
    agents, store, task, config, provider: 'p', model: 'm',
    mintSessionId, createMessage,
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

test('первое сообщение — массив блоков, а не строка', async () => {
  // Ядро перебирает содержимое как список. Строка проходит все проверки на
  // «текст внутри есть» и роняет ход уже в работе.
  const { store, cleanup } = freshStore()
  const { agents, sent } = stubAgents()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'привет', repo: 'r' })
  await runTask({
    agents, store, task, config, provider: 'p', model: 'm',
    mintSessionId, createMessage,
  })
  const content = sent[0].content
  assert.ok(Array.isArray(content))
  assert.equal(typeof content.some, 'function', 'ядро зовёт content.some — у строки его нет')
  assert.ok(content.every((b) => typeof b === 'object' && typeof b.type === 'string'))
})


// ------------------------------------------------- одна задача, один чат

test('живая сессия открывается, новая не поднимается', async () => {
  const { store, cleanup } = freshStore()
  const { agents, calls } = stubAgents({ live: 'kanban-старая' })
  const task = store.createTask({ board: 'main', column: 'review', title: 'A', repo: 'r' })
  store.updateTask(task.id, { sessionId: 'kanban-старая' })

  const out = await runTask({
    agents, store, task: store.getTask(task.id), config, provider: 'p', model: 'm',
    mintSessionId, createMessage,
  })
  assert.equal(out.mode, 'opened')
  assert.equal(out.sessionId, 'kanban-старая')
  assert.equal(calls.create, 0, 'поднята лишняя сессия')
  cleanup()
})

test('выгруженная сессия возобновляется, а не заводится заново', async () => {
  const { store, cleanup } = freshStore()
  const { agents, calls } = stubAgents({ resumable: 'kanban-сохранённая' })
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A', repo: 'r' })
  store.updateTask(task.id, { sessionId: 'kanban-сохранённая' })

  const out = await runTask({
    agents, store, task: store.getTask(task.id), config, provider: 'p', model: 'm',
    mintSessionId, createMessage,
  })
  assert.equal(out.mode, 'resumed')
  assert.equal(calls.resume, 1)
  assert.equal(calls.create, 0)
  cleanup()
})

test('удалённая сессия заменяется новой, и об этом пишут в журнал', async () => {
  // Молчаливая подмена чата — худшее: человек вернётся и не поймёт, куда
  // делась переписка.
  const { store, cleanup } = freshStore()
  const { agents } = stubAgents({})
  const task = store.createTask({ board: 'main', column: 'review', title: 'A', repo: 'r' })
  store.updateTask(task.id, { sessionId: 'kanban-исчезнувшая' })

  const out = await runTask({
    agents, store, task: store.getTask(task.id), config, provider: 'p', model: 'm',
    mintSessionId, createMessage, logger: { warn() {} },
  })
  assert.equal(out.mode, 'created')
  const log = store.listTransitions(task.id)
  assert.equal(log.length, 1)
  assert.ok(log[0].detail.includes('не возобновилась'))
  cleanup()
})

test('продолжение не откатывает карточку в «в работе»', async () => {
  // Задача в ревью, нажали «Продолжить» — она обязана остаться в ревью.
  const { store, cleanup } = freshStore()
  const { agents } = stubAgents({ live: 'kanban-старая' })
  const task = store.createTask({ board: 'main', column: 'review', title: 'A', repo: 'r' })
  store.updateTask(task.id, { sessionId: 'kanban-старая' })

  await runTask({
    agents, store, task: store.getTask(task.id), config, provider: 'p', model: 'm',
    mintSessionId, createMessage,
  })
  assert.equal(store.getTask(task.id).column, 'review')
  assert.equal(store.listTransitions(task.id).length, 0)
  cleanup()
})

test('первый запуск из бэклога карточку двигает', async () => {
  const { store, cleanup } = freshStore()
  const { agents } = stubAgents({})
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A', repo: 'r' })

  await runTask({
    agents, store, task, config, provider: 'p', model: 'm',
    mintSessionId, createMessage,
  })
  assert.equal(store.getTask(task.id).column, 'in-progress')
  cleanup()
})

test('текст человека вытесняет встроенную заготовку', async () => {
  const { store, cleanup } = freshStore()
  const { agents, sent } = stubAgents({})
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A', repo: 'r' })

  await runTask({
    agents, store, task, config, provider: 'p', model: 'm',
    mintSessionId, createMessage, text: '  посмотри ревью  ',
  })
  assert.equal(sent[0].content[0].text, 'посмотри ревью')
  cleanup()
})

test('пустой текст человека возвращает встроенную заготовку', async () => {
  const { store, cleanup } = freshStore()
  const { agents, sent } = stubAgents({})
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'привет', repo: 'r' })

  await runTask({
    agents, store, task, config, provider: 'p', model: 'm',
    mintSessionId, createMessage, text: '   ',
  })
  assert.ok(sent[0].content[0].text.includes('Задача'))
  cleanup()
})

test('идентификатор сессии мнётся только когда сессию правда поднимают', async () => {
  // Заранее занятое имя при продолжении осталось бы висеть неиспользованным.
  const { store, cleanup } = freshStore()
  const { agents } = stubAgents({ live: 'kanban-старая' })
  const task = store.createTask({ board: 'main', column: 'review', title: 'A', repo: 'r' })
  store.updateTask(task.id, { sessionId: 'kanban-старая' })

  let minted = 0
  await runTask({
    agents, store, task: store.getTask(task.id), config, provider: 'p', model: 'm',
    mintSessionId: () => { minted += 1; return 'kanban-новая' }, createMessage,
  })
  assert.equal(minted, 0)
  cleanup()
})

test('задача без сессии живого агента не ищет', async () => {
  const { store, cleanup } = freshStore()
  const { agents, calls } = stubAgents({})
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A', repo: 'r' })

  const out = await obtainAgent({
    agents, task, config, provider: 'p', model: 'm', mintSessionId,
  })
  assert.equal(out.mode, 'created')
  assert.equal(calls.get, 0)
  assert.equal(calls.resume, 0)
  cleanup()
})

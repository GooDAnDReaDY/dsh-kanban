import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers.mjs'
import { observeTask, explain, applyObservation, syncAll } from '../lib/sync.js'
import { handleSessionEvent } from '../lib/lifecycle.js'

/** Заглушка Gitea: ни одного сетевого запроса. */
function stubGitea({ issues = {}, pulls = [], branches = [], fail } = {}) {
  const calls = { pulls: 0, branches: 0, issues: 0 }
  return {
    calls,
    listPulls: async () => { calls.pulls += 1; if (fail === 'pulls') throw new Error('нет связи'); return pulls },
    listBranches: async () => { calls.branches += 1; if (fail === 'branches') throw new Error('нет связи'); return branches },
    getIssue: async ({ index }) => {
      calls.issues += 1
      if (fail === 'issue') throw new Error('нет связи')
      return issues[index]
    },
  }
}

test('наблюдение выводит колонку и найденную ветку', () => {
  const task = { issueNumber: 7, column: 'backlog' }
  const state = { branches: [{ name: 'feat/7-x' }], pulls: [] }
  const out = observeTask(task, state, { state: 'open' })
  assert.equal(out.column, 'in-progress')
  assert.equal(out.branch, 'feat/7-x')
})

test('наблюдение находит влитый PR задачи', () => {
  const task = { issueNumber: 7, column: 'review' }
  const state = {
    branches: [{ name: 'feat/7-x' }],
    pulls: [{ number: 9, head: { ref: 'feat/7-x' }, state: 'closed', merged: true, title: 'feat' }],
  }
  const out = observeTask(task, state, { state: 'open' })
  assert.equal(out.column, 'deploy')
  assert.equal(out.pull.number, 9)
})

test('пояснение к переходу читается человеком', () => {
  assert.equal(explain({ column: 'deploy', pull: { number: 9 } }), 'PR #9 влит')
  assert.equal(explain({ column: 'cleanup', branch: 'feat/7-x' }), 'issue закрыт, ветка feat/7-x ещё есть')
  assert.equal(explain({ column: 'done' }), 'issue закрыт, ветка удалена')
  assert.equal(explain({ column: 'backlog' }), '')
})

test('переход применяется и записывается в журнал', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
  })
  const out = applyObservation({
    store, task,
    observation: { column: 'in-progress', branch: 'feat/7-x', pull: undefined },
  })
  assert.equal(out.column, 'in-progress')
  const saved = store.getTask(task.id)
  assert.equal(saved.column, 'in-progress')
  assert.equal(saved.branch, 'feat/7-x', 'наблюдённая ветка обязана попасть в карточку')
  const log = store.listTransitions(task.id)
  assert.equal(log[0].source, 'gitea')
  assert.ok(log[0].detail.includes('feat/7-x'))
  cleanup()
})

test('наблюдение той же колонки не плодит записей в журнале', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'review', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
  })
  const out = applyObservation({ store, task, observation: { column: 'review' } })
  assert.equal(out, undefined)
  assert.equal(store.listTransitions(task.id).length, 0)
  cleanup()
})

test('ветка записывается в карточку даже без перевода', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'in-progress', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
  })
  applyObservation({ store, task, observation: { column: 'in-progress', branch: 'feat/7-x' } })
  assert.equal(store.getTask(task.id).branch, 'feat/7-x')
  cleanup()
})

test('сверка двигает задачу по состоянию Gitea', async () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
  })
  const gitea = stubGitea({
    issues: { 7: { state: 'open' } },
    branches: [{ name: 'feat/7-x' }],
    pulls: [{ number: 9, head: { ref: 'feat/7-x' }, state: 'open', title: 'feat: готово' }],
  })
  const out = await syncAll({ gitea, store })
  assert.equal(out.checked, 1)
  assert.equal(out.moved, 1)
  assert.equal(out.failed, 0)
  assert.equal(out.problem, undefined, 'удачный проход не должен называть беду')
  assert.equal(store.getTask(task.id).column, 'review')
  cleanup()
})

test('репозиторий читается один раз на все свои задачи', async () => {
  // Десять задач одного репозитория — это не десять одинаковых запросов.
  const { store, cleanup } = freshStore()
  for (let i = 1; i <= 4; i += 1) {
    store.createTask({ board: 'main', column: 'backlog', title: 'T' + i, owner: 'o', repo: 'r', issueNumber: i })
  }
  const gitea = stubGitea({ issues: { 1: { state: 'open' }, 2: { state: 'open' }, 3: { state: 'open' }, 4: { state: 'open' } } })
  await syncAll({ gitea, store })
  assert.equal(gitea.calls.pulls, 1)
  assert.equal(gitea.calls.branches, 1)
  assert.equal(gitea.calls.issues, 4)
  cleanup()
})

test('своя задача без issue в сверку не попадает', async () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'своя' })
  const gitea = stubGitea({})
  const out = await syncAll({ gitea, store })
  assert.equal(out.checked, 0)
  assert.equal(gitea.calls.pulls, 0)
  cleanup()
})

test('завершённая задача больше не сверяется', async () => {
  const { store, cleanup } = freshStore()
  const t = store.createTask({ board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 7 })
  store.moveTask(t.id, { column: 'done' })
  const out = await syncAll({ gitea: stubGitea({}), store })
  assert.equal(out.checked, 0)
  cleanup()
})

test('недоступный репозиторий не роняет сверку остальных', async () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'плохой', issueNumber: 1 })
  const gitea = stubGitea({ fail: 'pulls' })
  const out = await syncAll({ gitea, store, logger: { warn() {} } })
  assert.equal(out.failed, 1)
  assert.equal(out.moved, 0)
  cleanup()
})

test('падение по одной задаче не останавливает соседние', async () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 1 })
  store.createTask({ board: 'main', column: 'backlog', title: 'B', owner: 'o', repo: 'r', issueNumber: 2 })
  let seen = 0
  const gitea = {
    listPulls: async () => [],
    listBranches: async () => [{ name: 'feat/2-x' }],
    getIssue: async ({ index }) => {
      seen += 1
      if (index === 1) throw new Error('нет такого issue')
      return { state: 'open' }
    },
  }
  const out = await syncAll({ gitea, store, logger: { warn() {} } })
  assert.equal(seen, 2, 'вторая задача не была прочитана')
  assert.equal(out.failed, 1)
  assert.equal(out.moved, 1)
  cleanup()
})

test('запрос разрешения поднимает признак ожидания', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  store.updateTask(task.id, { sessionId: 'kanban-1' })
  const out = handleSessionEvent({ store, sessionId: 'kanban-1', type: 'approval/asked' })
  assert.deepEqual(out, { taskId: task.id, waiting: true })
  assert.equal(store.getTask(task.id).waiting, true)
  cleanup()
})

test('возобновление хода снимает ожидание', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A', waiting: true })
  store.updateTask(task.id, { sessionId: 'kanban-1' })
  handleSessionEvent({ store, sessionId: 'kanban-1', type: 'turn/start' })
  assert.equal(store.getTask(task.id).waiting, false)
  cleanup()
})

test('повторное событие того же смысла ничего не переписывает', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  store.updateTask(task.id, { sessionId: 'kanban-1' })
  handleSessionEvent({ store, sessionId: 'kanban-1', type: 'approval/asked' })
  const again = handleSessionEvent({ store, sessionId: 'kanban-1', type: 'question/requested' })
  assert.equal(again, undefined)
  cleanup()
})

test('событие чужой сессии проходит мимо', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  assert.equal(handleSessionEvent({ store, sessionId: 'msgw-xyz', type: 'approval/asked' }), undefined)
  cleanup()
})

test('событие не про ожидание не трогает карточку', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  store.updateTask(task.id, { sessionId: 'kanban-1' })
  assert.equal(handleSessionEvent({ store, sessionId: 'kanban-1', type: 'assistant/chunk' }), undefined)
  assert.equal(store.getTask(task.id).waiting, false)
  cleanup()
})

test('сверка чинит дату заведения у карточек, приехавших раньше', () => {
  // Карточки на доске помнят день подхвата: починить их может только сверка,
  // задним числом переписать базу нечем.
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
  })
  applyObservation({
    store, task,
    observation: { column: 'backlog' },
    issue: { title: 'A', created_at: '2025-11-03T10:15:00Z' },
  })
  assert.equal(store.getTask(task.id).createdAt, Date.parse('2025-11-03T10:15:00Z'))
  cleanup()
})

test('сверка подхватывает автора у карточек, приехавших раньше', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
  })
  applyObservation({
    store, task, observation: { column: 'backlog' },
    issue: { title: 'A', user: { login: 'vadim' } },
  })
  assert.equal(store.getTask(task.id).author, 'vadim')
  cleanup()
})

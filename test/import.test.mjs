import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers.mjs'
import {
  issueToTask, markImported, refreshPatch, giteaState,
  listImportable, importIssue, refreshTask,
} from '../lib/import.js'

/** Заглушка службы Gitea: ни одного сетевого запроса в тестах. */
function stubGitea(issues) {
  return {
    isConfigured: () => true,
    listIssues: async () => issues,
    getIssue: async ({ index }) => issues.find((i) => i.number === index),
    searchRepos: async () => [],
  }
}

test('issueToTask переносит поля issue', () => {
  const issue = {
    number: 12,
    title: 'Дробный индекс для порядка',
    body: 'Наивный индекс переписывает всю колонку.',
    labels: [{ name: 'feat' }, { name: 'p2' }],
    html_url: 'https://example.invalid/o/r/issues/12',
  }
  const task = issueToTask(issue, { owner: 'o', repo: 'r' })
  assert.equal(task.issueNumber, 12)
  assert.equal(task.title, 'Дробный индекс для порядка')
  assert.deepEqual(task.labels, ['feat', 'p2'])
  assert.equal(task.owner, 'o')
  assert.equal(task.repo, 'r')
  assert.equal(task.issueUrl, 'https://example.invalid/o/r/issues/12')
})

test('issueToTask не выдумывает ветку и сессию', () => {
  const task = issueToTask({ number: 1, title: 'A', labels: [] }, { owner: 'o', repo: 'r' })
  assert.equal(task.branch, undefined)
  assert.equal(task.worktree, undefined)
  assert.equal(task.sessionId, undefined)
})

test('issueToTask переживает issue без тела и меток', () => {
  const task = issueToTask({ number: 2, title: 'B' }, { owner: 'o', repo: 'r' })
  assert.equal(task.body, '')
  assert.deepEqual(task.labels, [])
})

test('метки принимаются и строками, и объектами', () => {
  const task = issueToTask({ number: 3, title: 'C', labels: ['bug', { name: 'p1' }, 7] }, { owner: 'o', repo: 'r' })
  assert.deepEqual(task.labels, ['bug', 'p1'])
})

test('markImported помечает issue, которые уже на доске', () => {
  const issues = [{ number: 1, title: 'A' }, { number: 2, title: 'B' }]
  const existing = [{ owner: 'o', repo: 'r', issueNumber: 2 }]
  const out = markImported(issues, existing, { owner: 'o', repo: 'r' })
  assert.equal(out[0].imported, false)
  assert.equal(out[1].imported, true)
})

test('markImported различает репозитории', () => {
  // Сравнение по одному номеру пометило бы задачу №1 из чужого репозитория.
  const issues = [{ number: 1, title: 'A' }]
  const existing = [{ owner: 'o', repo: 'other', issueNumber: 1 }]
  assert.equal(markImported(issues, existing, { owner: 'o', repo: 'r' })[0].imported, false)
})

test('markImported различает владельцев', () => {
  const issues = [{ number: 1, title: 'A' }]
  const existing = [{ owner: 'кто-то', repo: 'r', issueNumber: 1 }]
  assert.equal(markImported(issues, existing, { owner: 'o', repo: 'r' })[0].imported, false)
})

test('refresh не сбрасывает локальные поля', () => {
  const task = {
    id: 'x', column: 'in-progress', position: 'a5', sessionId: 'kanban-x-1',
    model: 'claude-opus-5', title: 'Старый', labels: [],
  }
  const patch = refreshPatch(task, { number: 12, title: 'Новый', body: 'Тело', labels: [{ name: 'bug' }] })
  assert.equal(patch.title, 'Новый')
  assert.deepEqual(patch.labels, ['bug'])
  assert.equal(patch.column, undefined)
  assert.equal(patch.sessionId, undefined)
  assert.equal(patch.position, undefined)
  assert.equal(patch.model, undefined)
})

test('состояние клиента Gitea различает отсутствие и ненастроенность', async () => {
  assert.equal(await giteaState(undefined), 'absent')
  assert.equal(await giteaState(null), 'absent')
  assert.equal(await giteaState({ isConfigured: () => false }), 'unconfigured')
  assert.equal(await giteaState({ isConfigured: () => true }), 'ready')
  assert.equal(await giteaState({ isConfigured: async () => true }), 'ready')
})

test('падение проверки готовности читается как ненастроенность, а не как отказ', async () => {
  assert.equal(await giteaState({ isConfigured: () => { throw new Error('нет службы') } }), 'unconfigured')
})

test('импорт без службы объясняет причину, а не отдаёт пустой список', async () => {
  const { store, cleanup } = freshStore()
  const out = await listImportable({ gitea: undefined, store, owner: 'o', repo: 'r' })
  assert.equal(out.status, 409)
  assert.equal(out.error, 'gitea-absent')
  cleanup()
})

test('импорт при ненастроенном Gitea объясняет причину', async () => {
  const { store, cleanup } = freshStore()
  const out = await listImportable({ gitea: { isConfigured: () => false }, store, owner: 'o', repo: 'r' })
  assert.equal(out.error, 'gitea-unconfigured')
  cleanup()
})

test('список issue помечает уже импортированные', async () => {
  const { store, cleanup } = freshStore()
  const gitea = stubGitea([{ number: 1, title: 'A' }, { number: 2, title: 'B' }])
  await importIssue({ gitea, store, owner: 'o', repo: 'r', issueNumber: 2 })
  const out = await listImportable({ gitea, store, owner: 'o', repo: 'r' })
  assert.equal(out.issues[0].imported, false)
  assert.equal(out.issues[1].imported, true)
  cleanup()
})

test('импорт заводит задачу с данными issue', async () => {
  const { store, cleanup } = freshStore()
  const gitea = stubGitea([{ number: 12, title: 'Импорт', body: 'Тело', labels: [{ name: 'feat' }] }])
  const out = await importIssue({ gitea, store, owner: 'o', repo: 'r', issueNumber: 12 })
  assert.equal(out.task.title, 'Импорт')
  assert.equal(out.task.issueNumber, 12)
  assert.deepEqual(out.task.labels, ['feat'])
  assert.equal(out.task.column, 'backlog')
  cleanup()
})

test('импорт несуществующего issue отдаёт 404', async () => {
  const { store, cleanup } = freshStore()
  const out = await importIssue({ gitea: stubGitea([]), store, owner: 'o', repo: 'r', issueNumber: 99 })
  assert.equal(out.status, 404)
  cleanup()
})

test('импорт без номера issue отвергается', async () => {
  const { store, cleanup } = freshStore()
  const out = await importIssue({ gitea: stubGitea([]), store, owner: 'o', repo: 'r' })
  assert.equal(out.status, 400)
  cleanup()
})

test('обновление задачи переписывает данные issue и хранит колонку', async () => {
  const { store, cleanup } = freshStore()
  const gitea = stubGitea([{ number: 5, title: 'Новый', body: 'Новое тело', labels: [{ name: 'bug' }] }])
  const created = await importIssue({ gitea, store, owner: 'o', repo: 'r', issueNumber: 5 })
  store.moveTask(created.task.id, { column: 'in-progress' })
  store.updateTask(created.task.id, { sessionId: 'kanban-x', title: 'Старый' })
  const out = await refreshTask({ gitea, store, id: created.task.id })
  assert.equal(out.task.title, 'Новый')
  assert.equal(out.task.column, 'in-progress')
  assert.equal(out.task.sessionId, 'kanban-x')
  cleanup()
})

test('обновление своей задачи без issue отвергается понятной ошибкой', async () => {
  const { store, cleanup } = freshStore()
  const own = store.createTask({ board: 'main', column: 'backlog', title: 'Своя' })
  const out = await refreshTask({ gitea: stubGitea([]), store, id: own.id })
  assert.equal(out.error, 'task-has-no-issue')
  cleanup()
})

test('дата задачи — дата issue, а не дата подхвата', () => {
  // Иначе задача годичной давности выглядит заведённой сегодня, и по дате на
  // карточке нельзя понять ничего.
  const { store, cleanup } = freshStore()
  const born = Date.parse('2025-11-03T10:15:00Z')
  const fields = issueToTask(
    { number: 7, title: 'A', created_at: '2025-11-03T10:15:00Z' },
    { owner: 'o', repo: 'r' },
  )
  assert.equal(fields.createdAt, born)
  const task = store.createTask(fields)
  assert.equal(task.createdAt, born)
  assert.ok(task.columnAt > born, 'в колонку задача въехала сейчас, а не тогда')
  cleanup()
})

test('без даты в issue карточка заводится сегодняшним числом', () => {
  const { store, cleanup } = freshStore()
  const before = Date.now()
  const task = store.createTask(issueToTask({ number: 7, title: 'A' }, { owner: 'o', repo: 'r' }))
  assert.ok(task.createdAt >= before, 'выдуманной датой прикрываться нечем')
  assert.equal(issueToTask({ created_at: 'позавчера' }, {}).createdAt, undefined)
  cleanup()
})

test('обновление из issue исправляет дату заведения', () => {
  const patch = refreshPatch({}, { title: 'A', created_at: '2025-11-03T10:15:00Z' })
  assert.equal(patch.createdAt, Date.parse('2025-11-03T10:15:00Z'))
})

test('автор issue доезжает до карточки', () => {
  // «Кто это завёл» видно в Gitea под задачей; на доске это было неизвестно.
  const { store, cleanup } = freshStore()
  const task = store.createTask(issueToTask(
    { number: 7, title: 'A', user: { login: 'vadim', full_name: 'Вадим' } },
    { owner: 'o', repo: 'r' },
  ))
  assert.equal(task.author, 'vadim', 'логин, а не полное имя: оно заполнено не у всех')
  cleanup()
})

test('issue без автора не выдумывает его', () => {
  const { store, cleanup } = freshStore()
  assert.equal(store.createTask(issueToTask({ number: 7 }, {})).author, '')
  assert.equal(refreshPatch({}, { title: 'A' }).author, undefined, 'пустым автором чужой не затирается')
  cleanup()
})

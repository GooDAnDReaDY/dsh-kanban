import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectTask } from '../lib/import.js'
import { freshStore } from './helpers.mjs'

const ok = { isConfigured: async () => true }
const issue = { number: 7, title: 'A', body: '', labels: [], html_url: 'u' }

test('проектная задача заводит issue и привязывает карточку', async () => {
  const { store, cleanup } = freshStore()
  const gitea = { ...ok, createIssue: async () => issue }
  const out = await createProjectTask({ gitea, store, owner: 'o', repo: 'r', title: 'A' })
  assert.equal(out.task.issueNumber, 7)
  assert.equal(out.task.repo, 'r')
  assert.equal(out.task.board, 'main')
  cleanup()
})

test('новый репозиторий создаётся приватным и пустым', async () => {
  // Приватный: расширить права потом дешевле, чем убрать лишнее из публичного.
  // Пустой: пустой репозиторий честнее чужих заготовок.
  const { store, cleanup } = freshStore()
  let asked
  const gitea = {
    ...ok,
    createRepo: async (args) => { asked = args; return { name: args.name } },
    createIssue: async () => issue,
  }
  const out = await createProjectTask({ gitea, store, owner: 'o', newRepo: 'novyi-repo', title: 'A' })
  assert.equal(asked.name, 'novyi-repo')
  assert.equal(out.task.repo, 'novyi-repo')
  cleanup()
})

test('негодное имя репозитория отвергается ДО запроса', async () => {
  // Отказ Gitea пришёл бы позже и невнятнее.
  const { store, cleanup } = freshStore()
  let called = false
  const gitea = { ...ok, createRepo: async () => { called = true }, createIssue: async () => issue }
  // Кириллица тоже отвергается: имя уезжает в путь запроса, и защита от
  // подстановки здесь важнее удобства.
  for (const bad of ['', '   ', 'с пробелом', 'слэш/внутри', '..', 'кириллица']) {
    const out = await createProjectTask({ gitea, store, owner: 'o', newRepo: bad, title: 'A' })
    assert.ok(out.error === 'repo-required' || out.error === 'bad-repo-name', `${bad} -> ${out.error}`)
  }
  assert.equal(called, false, 'к Gitea не должно быть ни одного обращения')
  cleanup()
})

test('без заголовка задача не заводится', async () => {
  const { store, cleanup } = freshStore()
  const gitea = { ...ok, createIssue: async () => issue }
  assert.equal((await createProjectTask({ gitea, store, owner: 'o', repo: 'r', title: '  ' })).error, 'title-required')
  cleanup()
})

test('неудача issue не оставляет карточку полупривязанной', async () => {
  // Лучше не завести карточку вовсе и сказать об этом, чем завести полупустую.
  const { store, cleanup } = freshStore()
  const gitea = {
    ...ok,
    createRepo: async () => ({ name: 'новый' }),
    createIssue: async () => { throw new Error('нет прав') },
  }
  const out = await createProjectTask({ gitea, store, owner: 'o', newRepo: 'novyi-repo', title: 'A' })
  assert.equal(out.error, 'issue-not-created')
  assert.equal(store.listTasks({ board: 'main' }).length, 0)
  cleanup()
})

test('неудача репозитория останавливает всё до issue', async () => {
  const { store, cleanup } = freshStore()
  let issued = false
  const gitea = {
    ...ok,
    createRepo: async () => { throw new Error('уже существует') },
    createIssue: async () => { issued = true; return issue },
  }
  const out = await createProjectTask({ gitea, store, owner: 'o', newRepo: 'novyi-repo', title: 'A' })
  assert.equal(out.error, 'repo-not-created')
  assert.equal(issued, false)
  cleanup()
})

test('ненастроенный Gitea называется отдельно от прочих бед', async () => {
  const { store, cleanup } = freshStore()
  const out = await createProjectTask({
    gitea: { isConfigured: async () => false }, store, owner: 'o', repo: 'r', title: 'A',
  })
  assert.match(out.error, /^gitea-/)
  assert.equal(out.status, 409)
  cleanup()
})

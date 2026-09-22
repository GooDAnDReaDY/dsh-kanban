// Видимое состояние сверки: доска, переставшая обновляться, не молчит.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSyncState, syncAll } from '../lib/sync.js'
import { buildBoard } from '../lib/routes.js'
import { withDefaults } from '../lib/config.js'
import { freshStore } from './helpers.mjs'
import { loadClient } from './client-load.mjs'

const config = withDefaults({})
const NOW = 1_700_000_000_000
const MIN = 60_000

/** Переводчик-заглушка: ключ плюс подставленное значение. */
const stubT = (key, vars) => {
  if (!vars) return key
  const name = Object.keys(vars)[0]
  return key + ':' + vars[name]
}

// ------------------------------------------------- состояние

test('до первого прохода состояние честно называется «сверки не было»', () => {
  // Показать «сверено только что» на пустом месте — соврать с первой секунды.
  assert.equal(createSyncState().snapshot().state, 'never')
})

test('удачный проход записывает отметку', () => {
  const st = createSyncState()
  st.finished({ checked: 3, failed: 0, at: NOW })
  const out = st.snapshot()
  assert.equal(out.state, 'ok')
  assert.equal(out.okAt, NOW)
  assert.equal(out.problem, undefined)
})

test('неудача НЕ затирает время последнего успеха', () => {
  // Иначе теряется ответ на главный вопрос: когда доска видела правду.
  const st = createSyncState()
  st.finished({ checked: 3, failed: 0, at: NOW })
  st.finished({ checked: 3, failed: 3, at: NOW + MIN, problem: { where: 'o/r', message: '404' } })
  const out = st.snapshot()
  assert.equal(out.state, 'failed')
  assert.equal(out.okAt, NOW, 'время успеха потеряно')
  assert.equal(out.failedAt, NOW + MIN)
  assert.equal(out.problem.message, '404')
})

test('удача после неудачи снимает беду', () => {
  const st = createSyncState()
  st.finished({ failed: 1, at: NOW, problem: { where: 'o/r', message: '404' } })
  st.finished({ failed: 0, at: NOW + MIN })
  const out = st.snapshot()
  assert.equal(out.state, 'ok')
  assert.equal(out.problem, undefined)
})

test('идущая сверка видна отдельно от её итога', () => {
  const st = createSyncState()
  st.started()
  assert.equal(st.snapshot().state, 'running')
  st.finished({ failed: 0, at: NOW })
  assert.equal(st.snapshot().state, 'ok')
})

test('несостоявшаяся сверка — тоже беда, и своя', () => {
  // Так выглядит неразрешённый токен: до репозиториев дело не дошло вовсе.
  const st = createSyncState()
  st.failedToStart('сверка', 'токен не разрешён')
  const out = st.snapshot()
  assert.equal(out.state, 'failed')
  assert.equal(out.problem.where, 'сверка')
  assert.match(out.problem.message, /токен/)
})

// ------------------------------------------------- отчёт прохода

test('отчёт называет причину, а не только числа', async () => {
  // «Сверено ноль из пяти» человеку ничего не говорит, «репозиторий не найден»
  // говорит всё.
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'in-progress', title: 'A', owner: 'o', repo: 'r', issueNumber: 1,
  })
  const gitea = {
    listBranches: async () => { throw new Error('репозиторий не найден') },
    listPulls: async () => [],
    getIssue: async () => ({ number: 1, state: 'open' }),
  }
  const out = await syncAll({ gitea, store, logger: { warn() {} }, now: NOW })
  assert.equal(out.reposFailed, 1)
  assert.equal(out.problem.where, 'o/r')
  assert.match(out.problem.message, /не найден/)
  assert.equal(out.at, NOW)
  assert.ok(task.id)
  cleanup()
})

test('первая беда важнее последующих', async () => {
  // При протухшем токене отвалятся все репозитории одинаково; показывать надо
  // причину, а не последний по счёту репозиторий.
  const { store, cleanup } = freshStore()
  for (const repo of ['раз', 'два']) {
    store.createTask({ board: 'main', column: 'in-progress', title: repo, owner: 'o', repo, issueNumber: 1 })
  }
  let call = 0
  const gitea = {
    listBranches: async () => { call += 1; throw new Error(`отказ ${call}`) },
    listPulls: async () => [],
    getIssue: async () => ({ number: 1, state: 'open' }),
  }
  const out = await syncAll({ gitea, store, logger: { warn() {} }, now: NOW })
  assert.equal(out.reposFailed, 2)
  assert.match(out.problem.message, /отказ 1/)
  cleanup()
})

test('удачный проход беды не называет', async () => {
  const { store, cleanup } = freshStore()
  store.createTask({
    board: 'main', column: 'in-progress', title: 'A', owner: 'o', repo: 'r', issueNumber: 1,
  })
  const gitea = {
    listBranches: async () => [],
    listPulls: async () => [],
    getIssue: async () => ({ number: 1, state: 'open' }),
  }
  const out = await syncAll({ gitea, store, logger: { warn() {} }, now: NOW })
  assert.equal(out.problem, undefined)
  assert.equal(out.reposFailed, 0)
  cleanup()
})

// ------------------------------------------------- доска

test('доска несёт состояние сверки', () => {
  const { store, cleanup } = freshStore()
  const st = createSyncState()
  st.finished({ failed: 0, at: NOW })
  assert.equal(buildBoard({ store, config, sync: st.snapshot() }).sync.state, 'ok')
  cleanup()
})

test('без состояния доска говорит «сверки не было», а не молчит', () => {
  const { store, cleanup } = freshStore()
  assert.equal(buildBoard({ store, config }).sync.state, 'never')
  cleanup()
})

// ------------------------------------------------- строка в браузере

test('строка сверки различает четыре положения', () => {
  const h = loadClient().exported.helpers
  assert.equal(h.syncLine({ state: 'never' }, NOW, stubT).text, 'sync.never')
  assert.equal(h.syncLine({ state: 'running' }, NOW, stubT).text, 'sync.running')
  assert.equal(h.syncLine({ state: 'ok', okAt: NOW - 5 * MIN }, NOW, stubT).text, 'sync.okAgo:time.min:5')
  assert.equal(h.syncLine({ state: 'failed', problem: { where: 'o/r', message: '404' } }, NOW, stubT).text, 'sync.failed')
})

test('беда выделяется, остальное — нет', () => {
  const h = loadClient().exported.helpers
  assert.equal(h.syncLine({ state: 'failed', problem: {} }, NOW, stubT).tone, 'bad')
  assert.equal(h.syncLine({ state: 'ok', okAt: NOW }, NOW, stubT).tone, 'ok')
  assert.equal(h.syncLine({ state: 'never' }, NOW, stubT).tone, 'idle')
  assert.equal(h.syncLine({ state: 'running' }, NOW, stubT).tone, 'idle')
})

test('при беде подсказка называет место, причину и время последней правды', () => {
  const h = loadClient().exported.helpers
  const line = h.syncLine(
    { state: 'failed', okAt: NOW - 3 * MIN, problem: { where: 'o/r', message: 'токен не подошёл' } },
    NOW, stubT,
  )
  assert.match(line.title, /o\/r/)
  assert.match(line.title, /токен не подошёл/)
  assert.match(line.title, /sync\.lastSeen/)
})

test('беда без единой удачной сверки говорит об этом прямо', () => {
  // Молчание тут читалось бы как «всё в порядке, просто давно».
  const h = loadClient().exported.helpers
  const line = h.syncLine({ state: 'failed', problem: { where: 'o/r', message: '404' } }, NOW, stubT)
  assert.match(line.title, /sync\.neverSeen/)
})

test('пустое состояние строку не роняет', () => {
  const h = loadClient().exported.helpers
  assert.equal(h.syncLine(undefined, NOW, stubT).text, 'sync.never')
  assert.equal(h.syncLine({}, NOW, stubT).text, 'sync.never')
})

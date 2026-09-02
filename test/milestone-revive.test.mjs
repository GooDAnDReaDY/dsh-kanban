// Выпуск задачи и возвращение к умершей сессии.
import test from 'node:test'
import assert from 'node:assert/strict'

import { issueMilestone, issueToTask, refreshPatch } from '../lib/import.js'
import { canRevive } from '../lib/routes.js'
import { revivalKind } from '../lib/launcher.js'
import { applyObservation } from '../lib/sync.js'
import { facetsOf, matchesFilters, MILESTONE, NO_MILESTONE } from '../lib/filters.js'
import { loadClient } from './client-load.mjs'
import { freshStore } from './helpers.mjs'

// ------------------------------------------------------------- выпуск (#187)

test('выпуск приезжает с issue', () => {
  assert.equal(issueMilestone({ milestone: { title: '0.2.0' } }), '0.2.0')
  assert.equal(issueMilestone({ milestone: null }), '', 'вне выпусков — тоже ответ')
  assert.equal(issueMilestone({}), '')
})

test('выпуск доезжает до карточки при подхвате', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask(issueToTask(
    { number: 7, title: 'A', milestone: { title: '0.2.0' } }, { owner: 'o', repo: 'r' },
  ))
  assert.equal(task.milestone, '0.2.0')
  cleanup()
})

test('снятие выпуска — такая же новость, как назначение', () => {
  // Иначе доска показывала бы задачу в релизе, из которого её вынули.
  assert.equal(refreshPatch({ milestone: '0.2.0' }, { title: 'A', milestone: null }).milestone, '')
  assert.equal(refreshPatch({}, { title: 'A' }).milestone, undefined, 'молчание не трогает поле')
})

test('сверка подхватывает смену выпуска', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
  })
  applyObservation({
    store, task, observation: { column: 'backlog' },
    issue: { title: 'A', milestone: { title: '0.3.0' } },
  })
  assert.equal(store.getTask(task.id).milestone, '0.3.0')
  cleanup()
})

test('выпуск становится измерением отбора', () => {
  const tasks = [{ milestone: '0.2.0' }, { milestone: '0.2.0' }, {}]
  const facet = facetsOf(tasks).find((f) => f.ns === MILESTONE)
  const counts = Object.fromEntries(facet.values.map((v) => [v.value, v.count]))
  assert.deepEqual(counts, { '0.2.0': 2, [NO_MILESTONE]: 1 })
  assert.equal(matchesFilters({ milestone: '0.2.0' }, { [MILESTONE]: ['0.2.0'] }), true)
  assert.equal(matchesFilters({}, { [MILESTONE]: [NO_MILESTONE] }), true)
})

// ------------------------------------------------ умершая сессия (#188)

test('продолжать предлагают только там, где есть что продолжать', () => {
  // У живой сессии продолжать нечего, у задачи без сессии — нечего
  // возобновлять.
  assert.equal(canRevive({ sessionId: 's1' }, undefined), true)
  assert.equal(canRevive({ sessionId: 's1' }, 'running'), false)
  assert.equal(canRevive({ sessionId: '' }, undefined), false)
  assert.equal(canRevive({}, undefined), false)
})

test('«продолжил» и «начал заново» различаются словами', () => {
  // Человек обязан видеть, осталась ли переписка: это разные исходы.
  assert.equal(revivalKind('resumed'), 'resumed')
  assert.equal(revivalKind('opened'), 'opened')
  assert.equal(revivalKind('created'), 'created')
  assert.equal(revivalKind(undefined), 'created')
})

test('кнопка возобновления есть только у остановившейся задачи', () => {
  const { src } = loadClient()
  const from = src.indexOf('menu === task.id')
  const menu = src.slice(from, src.indexOf('dkb-taskCard', from))
  assert.match(menu, /task\.state === 'stopped'/)
  assert.match(menu, /props\.onRevive\(task\)/)
})

test('исход возобновления сообщается разными словами', () => {
  const { src } = loadClient()
  assert.match(src, /out\.mode === 'created' \? 'revive\.fresh' : 'revive\.same'/)
})

test('подписи выпуска и возобновления есть в обоих словарях', () => {
  const { src } = loadClient()
  for (const key of ['card.revive', 'revive.same', 'revive.fresh']) {
    assert.equal(src.split("'" + key + "':").length - 1, 2, 'у ' + key + ' не два перевода')
  }
})

// Взгляд на доску: ждущие, порядок, пачка, групповые действия, память запуска.
import test from 'node:test'
import assert from 'node:assert/strict'

import { facetsOf, matchesFilters, AUTHOR, NO_AUTHOR } from '../lib/filters.js'
import { stopWork, STOP_DETAIL } from '../lib/commands.js'
import { loadClient } from './client-load.mjs'

const h = loadClient().exported.helpers

/** Помощники живут в песочнице `node:vm`: их массивы и объекты чужого рода. */
const plain = (value) => JSON.parse(JSON.stringify(value))

// ------------------------------------------------- отбор по автору (#136)

test('автор становится измерением отбора со своим счётчиком', () => {
  const tasks = [
    { repo: 'r', author: 'vadim' },
    { repo: 'r', author: 'vadim' },
    { repo: 'r', author: 'агент' },
  ]
  const facet = facetsOf(tasks).find((f) => f.ns === AUTHOR)
  assert.deepEqual(facet.values.map((v) => [v.value, v.count]).sort(), [['vadim', 2], ['агент', 1]])
})

test('задача без автора попадает в своё значение, а не пропадает', () => {
  // Свои задачи заводятся на доске: «никто» — тоже ответ на «кто завёл».
  const facet = facetsOf([{ repo: 'r' }]).find((f) => f.ns === AUTHOR)
  assert.deepEqual(facet.values, [{ value: NO_AUTHOR, count: 1 }])
  assert.equal(matchesFilters({ repo: 'r' }, { [AUTHOR]: [NO_AUTHOR] }), true)
  assert.equal(matchesFilters({ author: 'vadim' }, { [AUTHOR]: [NO_AUTHOR] }), false)
})

test('отбор по автору складывается с остальными', () => {
  const task = { repo: 'r', author: 'vadim', labels: ['type/feature'] }
  assert.equal(matchesFilters(task, { [AUTHOR]: ['vadim'], type: ['feature'] }), true)
  assert.equal(matchesFilters(task, { [AUTHOR]: ['vadim'], type: ['bug'] }), false)
})

// ------------------------------------------------- порядок в колонке (#137)

test('ручной порядок не трогается вовсе', () => {
  const tasks = [{ id: 'a', createdAt: 3 }, { id: 'b', createdAt: 1 }]
  assert.equal(h.sortTasks(tasks, 'manual'), tasks, 'тот же массив, без копии')
})

test('сортировка по дате не ломает группировку по проектам', () => {
  // Иначе заголовки проектов пришлось бы рисовать над каждой карточкой.
  const tasks = [
    { id: 'a1', repo: 'a', createdAt: 30 },
    { id: 'a2', repo: 'a', createdAt: 10 },
    { id: 'b1', repo: 'b', createdAt: 20 },
  ]
  assert.deepEqual(plain(h.sortTasks(tasks, 'old')).map((x) => x.id), ['a2', 'a1', 'b1'])
  assert.deepEqual(plain(h.sortTasks(tasks, 'new')).map((x) => x.id), ['a1', 'a2', 'b1'])
})

test('живое остаётся наверху своей группы при любой сортировке', () => {
  const tasks = [
    { id: 'старая', repo: 'a', createdAt: 1 },
    { id: 'идёт', repo: 'a', createdAt: 99, state: 'running' },
  ]
  assert.deepEqual(plain(h.sortTasks(tasks, 'old')).map((x) => x.id), ['идёт', 'старая'])
})

// ------------------------------------------------- пачка на карточке (#138)

test('пачка нумеруется в порядке очереди', () => {
  const tasks = [
    { id: 'c', sessionId: 's1', queuedAt: 20 },
    { id: 'a', sessionId: 's1', queuedAt: 0 },
    { id: 'b', sessionId: 's1', queuedAt: 10 },
  ]
  const out = plain(h.packInfo(tasks))
  assert.deepEqual(out.a, { at: 1, total: 3 })
  assert.deepEqual(out.b, { at: 2, total: 3 })
  assert.deepEqual(out.c, { at: 3, total: 3 })
})

test('одиночная задача пачкой не считается', () => {
  // Отметка «1 из 1» не сообщает ничего.
  assert.deepEqual(plain(h.packInfo([{ id: 'a', sessionId: 's1' }, { id: 'b' }])), {})
})

// ------------------------------------------------- остановка (#134)

test('остановка прерывает ход и не двигает карточку', () => {
  const calls = []
  const agent = { status: 'running', cancel: (why) => calls.push(why) }
  const out = stopWork({ agents: { get: () => agent }, task: { id: 't', sessionId: 's1', column: 'in-progress' } })
  assert.equal(out.acted, 'stopped')
  assert.deepEqual(calls, [{ kind: 'user' }])
  assert.match(STOP_DETAIL.stopped, /остановил/)
})

test('останавливать нечего, если агент не идёт или его нет', () => {
  // Молчаливое «готово» на месте «он и так стоял» — ложь о случившемся.
  assert.equal(stopWork({ agents: { get: () => ({ status: 'idle' }) }, task: { sessionId: 's1' } }).acted, 'idle')
  assert.equal(stopWork({ agents: { get: () => undefined }, task: { sessionId: 's1' } }).acted, 'no-session')
  assert.equal(stopWork({ agents: { get: () => ({}) }, task: {} }).acted, 'no-session')
})

test('отказ ядра на отмену не выдаётся за остановку', () => {
  const agent = { status: 'running', cancel: () => { throw new Error('нельзя') } }
  assert.equal(stopWork({ agents: { get: () => agent }, task: { id: 't', sessionId: 's1' } }).acted, 'idle')
})

// ------------------------------------------------- групповые действия (#139)

test('групповое действие идёт по всем и считает отказы', () => {
  // Молчаливо съеденный отказ — это карточка, про которую человек уверен, что
  // она в архиве.
  return h.applyToEach(['a', 'b', 'c'], async (id) => {
    if (id === 'b') throw new Error('нельзя')
  }).then((out) => assert.deepEqual(plain(out), { done: 2, failed: 1 }))
})

test('пустой выбор ничего не делает и ни о чём не врёт', async () => {
  assert.deepEqual(plain(await h.applyToEach([], async () => {})), { done: 0, failed: 0 })
})

// ------------------------------------------------- память запуска (#140)

test('подставляется только то, что всё ещё предлагают', () => {
  // Исчезнувший уровень доступа значил бы запуск не с теми правами.
  assert.equal(h.stillOffered('danger-full-access', ['read-only'], 'read-only'), 'read-only')
  assert.equal(h.stillOffered('read-only', ['read-only', 'x'], 'x'), 'read-only')
  assert.equal(h.stillOffered(undefined, ['a'], 'a'), 'a')
})

test('недоступное хранилище браузера не роняет окно запуска', () => {
  // Закрытое окно и запрет на данные сайта — обычное дело, а окно запуска
  // обязано открыться и без памяти.
  const blocked = loadClient({
    storage: {
      getItem() { throw new Error('заблокировано') },
      setItem() { throw new Error('заблокировано') },
    },
  }).exported.helpers
  assert.deepEqual(plain(blocked.recallLaunch('main')), {})
  blocked.rememberLaunch('main', { provider: 'p' })
})

test('разные доски помнят своё', () => {
  const box = {}
  const kept = loadClient({
    storage: { getItem: (k) => box[k] ?? null, setItem: (k, v) => { box[k] = v } },
  }).exported.helpers
  kept.rememberLaunch('main', { provider: 'a' })
  kept.rememberLaunch('simple', { provider: 'b' })
  assert.equal(kept.recallLaunch('main').provider, 'a')
  assert.equal(kept.recallLaunch('simple').provider, 'b')
})

// ------------------------------------------------- подписи

test('новые подписи есть в обоих словарях', () => {
  const { src } = loadClient()
  const keys = ['facet.author', 'board.waitCount', 'board.waitCountHint', 'order.manual',
    'order.old', 'order.new', 'card.stop', 'card.pack', 'card.packHint',
    'stop.idle', 'stop.no-session', 'board.pickArchive', 'board.pickUnqueue',
    'board.pickMove', 'board.someFailed']
  for (const key of keys) {
    assert.equal(src.split("'" + key + "':").length - 1, 2, 'у ' + key + ' не два перевода')
  }
})

// План агента и состояние задачи.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parsePlan, serializePlan, applyPlan, planProgress, planItems, taskState,
  MAX_ITEMS, MAX_ITEM_LENGTH,
} from '../lib/plan.js'
import { boardPlanDefinition } from '../lib/board-tool.js'
import { buildBoard } from '../lib/routes.js'
import { freshStore } from './helpers.mjs'
import { loadClient } from './client-load.mjs'
import { withDefaults } from '../lib/config.js'

const config = withDefaults({})

/** Переводчик-заглушка: подставляет числа, остальное отдаёт ключом. */
const stubT = (key, vars) => (key === 'plan.counter' ? vars.done + ' из ' + vars.total : key)

test('пустой и испорченный план читаются как отсутствие плана', () => {
  // Испорченное поле не должно ронять чтение всей доски.
  for (const raw of ['', undefined, 'не json', '{"items":42}', '[]']) {
    assert.deepEqual(parsePlan(raw).items, [], 'сломалось на ' + String(raw))
  }
})

test('план переживает запись и чтение', () => {
  const plan = applyPlan(undefined, { items: ['раз', 'два'], current: 2 })
  assert.deepEqual(parsePlan(serializePlan(plan)), plan)
})

test('пункты без списка сохраняются, двигается только указатель', () => {
  // Гонять весь список ради одного числа незачем: агент публикует план один
  // раз, дальше шлёт только номер.
  const first = applyPlan(undefined, { items: ['раз', 'два', 'три'], current: 1 })
  const next = applyPlan(first, { current: 3 })
  assert.deepEqual(next.items, first.items)
  assert.equal(next.current, 3)
})

test('мусор в пунктах вычищается, длина ограничена', () => {
  const plan = applyPlan(undefined, {
    items: ['  много   пробелов  ', '', '   ', 'x'.repeat(MAX_ITEM_LENGTH + 40)],
  })
  assert.equal(plan.items[0], 'много пробелов')
  assert.equal(plan.items.length, 2, 'пустые пункты остались')
  assert.equal(plan.items[1].length, MAX_ITEM_LENGTH)
})

test('слишком длинный план обрезается', () => {
  const items = Array.from({ length: MAX_ITEMS + 20 }, (_, i) => 'шаг ' + i)
  assert.equal(applyPlan(undefined, { items }).items.length, MAX_ITEMS)
})

test('указатель не уходит за границы плана', () => {
  const items = ['раз', 'два']
  assert.equal(applyPlan(undefined, { items, current: -5 }).current, 0)
  assert.equal(applyPlan(undefined, { items, current: 99 }).current, 3, 'дальше конца — только «всё сделано»')
  assert.equal(applyPlan(undefined, { items, current: 'нет' }).current, 0)
})

// ------------------------------------------------- что видно снаружи

test('текущий пункт и счётчик', () => {
  const plan = applyPlan(undefined, { items: ['раз', 'два', 'три'], current: 2 })
  assert.deepEqual(planProgress(plan), { total: 3, done: 1, current: 2, text: 'два' })
})

test('план из одного пункта и план из двадцати описываются одинаково', () => {
  for (const total of [1, 20]) {
    const items = Array.from({ length: total }, (_, i) => 'шаг ' + (i + 1))
    const progress = planProgress(applyPlan(undefined, { items, current: 1 }))
    assert.equal(progress.total, total)
    assert.equal(progress.current, 1)
    assert.equal(progress.text, 'шаг 1')
  }
})

test('законченный план не держит последний пункт текущим', () => {
  // Иначе доделанная задача вечно показывала бы «пишу тесты».
  const progress = planProgress(applyPlan(undefined, { items: ['раз', 'два'], current: 3 }))
  assert.equal(progress.text, '')
  assert.equal(progress.done, 2)
})

test('плана нет — показывать нечего', () => {
  assert.equal(planProgress(parsePlan('')), undefined)
})

test('отметки пунктов: сделано, идёт, ещё нет', () => {
  const plan = applyPlan(undefined, { items: ['раз', 'два', 'три'], current: 2 })
  assert.deepEqual(planItems(plan), [
    { text: 'раз', done: true, active: false },
    { text: 'два', done: false, active: true },
    { text: 'три', done: false, active: false },
  ])
})

// ------------------------------------------------- состояние

test('состояние выводится из живого агента, а не из тишины', () => {
  const task = { sessionId: 's1', waiting: false }
  assert.equal(taskState({ task, live: 'running' }), 'running')
  assert.equal(taskState({ task, live: 'idle' }), 'idle')
  // Перезапустили харнесс: сессия записана, живого агента нет.
  assert.equal(taskState({ task, live: undefined }), 'stopped')
})

test('ожидание человека важнее хода', () => {
  // Агент технически «работает», но без ответа не сдвинется.
  assert.equal(taskState({ task: { sessionId: 's1', waiting: true }, live: 'running' }), 'waiting')
})

test('задача без сессии состояния не имеет', () => {
  assert.equal(taskState({ task: { sessionId: '' }, live: undefined }), 'none')
})

// ------------------------------------------------- инструмент

test('инструмент публикует план и двигает указатель', async () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  store.updateTask(task.id, { sessionId: 's1' })
  const tool = boardPlanDefinition({ store })
  const exec = { agent: { session: { id: 's1' } } }

  const said = await tool.execute({ items: ['раз', 'два', 'три'], current: 1 }, exec)
  assert.match(said, /1 of 3/)
  await tool.execute({ current: 3 }, exec)
  assert.deepEqual(parsePlan(store.getTask(task.id).plan), { items: ['раз', 'два', 'три'], current: 3 })
  cleanup()
})

test('инструмент отвергает пустой план и чужую сессию', async () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  store.updateTask(task.id, { sessionId: 's1' })
  const tool = boardPlanDefinition({ store })
  assert.match(await tool.execute({ current: 1 }, { agent: { session: { id: 's1' } } }), /at least one step/)
  assert.match(await tool.execute({ items: ['раз'] }, { agent: { session: { id: 'чужая' } } }), /no kanban task/)
  cleanup()
})

test('перечисление пунктов объявлено массивом строк', () => {
  // Схема значений — не JSON Schema, но массив в ней есть, и без items
  // модель получила бы «любой JSON».
  const { parameters } = boardPlanDefinition({ store: {} })
  assert.equal(parameters.items.type, 'array')
  assert.equal(parameters.items.items.type, 'string')
  assert.equal(parameters.items.required, undefined, 'список обязан быть необязательным')
})

// ------------------------------------------------- доска

test('доска отдаёт разобранный план и состояние', () => {
  // Браузерная половина — отдельный бандл и позвать lib/plan.js не может,
  // поэтому разбор обязан приехать готовым.
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  store.updateTask(task.id, {
    sessionId: 's1',
    plan: serializePlan(applyPlan(undefined, { items: ['раз', 'два'], current: 2 })),
  })

  const out = buildBoard({ store, config, liveOf: () => 'running' }).tasks.find((x) => x.id === task.id)
  assert.equal(out.state, 'running')
  assert.equal(out.plan.progress.total, 2)
  assert.equal(out.plan.items[1].active, true)
  assert.equal(typeof out.plan, 'object', 'сырая строка плана уехала наружу')
  cleanup()
})

test('доска не падает, когда реестр агентов отвечает отказом', () => {
  const { store, cleanup } = freshStore()
  store.updateTask(store.createTask({ board: 'main', column: 'in-progress', title: 'A' }).id, { sessionId: 's1' })
  const board = buildBoard({
    store,
    config,
    liveOf: () => { throw new Error('реестр недоступен') },
  })
  assert.equal(board.tasks.length, 1)
  cleanup()
})

// ------------------------------------------------- строка на карточке

test('строка карточки: номер идущего пункта, а не число сделанных', () => {
  const h = loadClient().exported.helpers
  const line = h.planLine({
    plan: { progress: { total: 7, done: 2, current: 3, text: 'пишу тесты' } },
  }, stubT)
  assert.equal(line, '3 из 7 · пишу тесты')
})

test('строка карточки на законченном и на пустом плане', () => {
  const h = loadClient().exported.helpers
  assert.equal(h.planLine({ plan: { progress: { total: 4, done: 4, current: 5, text: '' } } }, stubT), '4 из 4')
  assert.equal(h.planLine({ plan: { progress: undefined } }, stubT), '')
  assert.equal(h.planLine({}, stubT), '')
})

test('подпись состояния молчит там, где уже говорит точка ожидания', () => {
  const h = loadClient().exported.helpers
  assert.equal(h.stateLabel({ state: 'running' }, stubT), 'state.running')
  assert.equal(h.stateLabel({ state: 'stopped' }, stubT), 'state.stopped')
  assert.equal(h.stateLabel({ state: 'waiting' }, stubT), '')
  assert.equal(h.stateLabel({ state: 'none' }, stubT), '')
})

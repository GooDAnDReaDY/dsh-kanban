// Отборы доски: сбор пространств, складывание, переключение.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  splitLabel, facetsOf, matchesFilters, anySelected, toggleValue, clearFilters,
  KNOWN_ORDER, REPO, labelColor, colorsOfIssue,
} from '../lib/filters.js'
import { applyObservation } from '../lib/sync.js'
import { freshStore } from './helpers.mjs'
import { loadClient } from './client-load.mjs'

const TASKS = [
  { id: 'a', repo: 'dsh-kanban', labels: ['type/bug', 'priority/high', 'hotfix'] },
  { id: 'b', repo: 'dsh-kanban', labels: ['type/feature', 'priority/low', 'status/ready'] },
  { id: 'c', repo: 'memory-brain', labels: ['type/feature', 'epic'] },
  { id: 'd', repo: '', labels: [] },
]

const nsOf = (tasks) => facetsOf(tasks).map((f) => f.ns)

// ------------------------------------------------- разбор метки

test('метка делится на пространство и значение по первой косой черте', () => {
  assert.deepEqual(splitLabel('type/bug'), { ns: 'type', value: 'bug' })
  assert.deepEqual(splitLabel('scope/agent-tools'), { ns: 'scope', value: 'agent-tools' })
})

test('метка без пространства пространства не получает', () => {
  // epic и hotfix видны на карточках и находятся поиском, но своего отбора не
  // имеют: список из двух значений ради двух меток — мебель.
  for (const wrong of ['hotfix', 'epic', '', '/значение', 'пространство/', undefined, null, 42]) {
    assert.equal(splitLabel(wrong), undefined, String(wrong))
  }
})

test('вторая косая черта остаётся в значении', () => {
  assert.deepEqual(splitLabel('scope/ci/build'), { ns: 'scope', value: 'ci/build' })
})

// ------------------------------------------------- сбор отборов

test('пространства собираются из меток на карточках, а не из зашитого списка', () => {
  assert.deepEqual(nsOf(TASKS), [REPO, 'type', 'priority', 'status'])
})

test('репозиторий идёт первым, известные пространства — в своём порядке', () => {
  const tasks = [{ repo: 'r', labels: ['release/next', 'type/bug', 'risk/breaking', 'priority/high'] }]
  assert.deepEqual(nsOf(tasks), [REPO, 'type', 'priority', 'risk', 'release'])
})

test('незнакомое пространство дописывается в конец по алфавиту', () => {
  // Заведут в Gitea новое — оно появится само, без правки кода и без релиза.
  const tasks = [{ repo: 'r', labels: ['выдумка/раз', 'type/bug', 'ещё-выдумка/два'] }]
  assert.deepEqual(nsOf(tasks), [REPO, 'type', 'выдумка', 'ещё-выдумка'])
})

test('значения идут по алфавиту и со счётчиком', () => {
  const type = facetsOf(TASKS).find((f) => f.ns === 'type')
  assert.deepEqual(type.values, [
    { value: 'bug', count: 1 },
    { value: 'feature', count: 2 },
  ])
})

test('пустой репозиторий в отбор не попадает', () => {
  // Задача простой доски репозитория не имеет, и пустая строка в списке
  // выглядела бы как отдельный проект без названия.
  const repo = facetsOf(TASKS).find((f) => f.ns === REPO)
  assert.deepEqual(repo.values.map((v) => v.value), ['dsh-kanban', 'memory-brain'])
})

test('счётчик значения считает всё, а не отобранное', () => {
  // Иначе цифра рядом со значением отвечала бы на вопрос «сколько осталось
  // после моего же выбора», а не «сколько там всего».
  const type = facetsOf(TASKS).find((f) => f.ns === 'type')
  assert.equal(type.values.reduce((n, v) => n + v.count, 0), 3)
})

test('пустая доска отборов не даёт', () => {
  assert.deepEqual(facetsOf([]), [])
  assert.deepEqual(facetsOf(undefined), [])
})

// ------------------------------------------------- складывание

test('внутри пространства — ИЛИ', () => {
  // Срочность у задачи одна: «И» внутри пространства всегда давало бы пусто.
  const out = TASKS.filter((t) => matchesFilters(t, { type: ['bug', 'feature'] }))
  assert.deepEqual(out.map((t) => t.id), ['a', 'b', 'c'])
})

test('между пространствами — И', () => {
  const out = TASKS.filter((t) => matchesFilters(t, { type: ['feature'], priority: ['low'] }))
  assert.deepEqual(out.map((t) => t.id), ['b'])
})

test('репозиторий отбирает наравне с метками', () => {
  const out = TASKS.filter((t) => matchesFilters(t, { [REPO]: ['dsh-kanban'], type: ['feature'] }))
  assert.deepEqual(out.map((t) => t.id), ['b'])
})

test('несколько репозиториев — тоже ИЛИ', () => {
  const out = TASKS.filter((t) => matchesFilters(t, { [REPO]: ['dsh-kanban', 'memory-brain'] }))
  assert.deepEqual(out.map((t) => t.id), ['a', 'b', 'c'])
})

test('пустой отбор доску не сужает', () => {
  for (const empty of [{}, undefined, { type: [] }]) {
    assert.equal(TASKS.filter((t) => matchesFilters(t, empty)).length, TASKS.length)
  }
})

test('метка без пространства ничего не отбирает', () => {
  // hotfix есть на задаче a, но отбора по нему нет вовсе.
  assert.deepEqual(TASKS.filter((t) => matchesFilters(t, { hotfix: ['hotfix'] })), [])
})

test('задача без меток отсекается любым отбором по меткам', () => {
  assert.equal(matchesFilters({ repo: 'r', labels: [] }, { type: ['bug'] }), false)
  assert.equal(matchesFilters({ repo: 'r' }, { type: ['bug'] }), false)
})

// ------------------------------------------------- переключение

test('переключение добавляет и снимает', () => {
  const one = toggleValue({}, 'type', 'bug')
  assert.deepEqual(one, { type: ['bug'] })
  const two = toggleValue(one, 'type', 'feature')
  assert.deepEqual(two.type, ['bug', 'feature'])
  assert.deepEqual(toggleValue(two, 'type', 'bug').type, ['feature'])
})

test('снятие последнего значения убирает пространство целиком', () => {
  // Иначе в карте копились бы пустые списки, и «выбрано ли что-нибудь»
  // отвечало бы «да» на пустоте.
  assert.deepEqual(toggleValue({ type: ['bug'] }, 'type', 'bug'), {})
})

test('переключение не правит прежнюю карту на месте', () => {
  // Состояние отборов живёт в React: правка на месте не вызвала бы перерисовку.
  const before = { type: ['bug'] }
  toggleValue(before, 'type', 'feature')
  assert.deepEqual(before, { type: ['bug'] })
})

test('признак «выбрано что-нибудь»', () => {
  assert.equal(anySelected({}), false)
  assert.equal(anySelected({ type: [] }), false)
  assert.equal(anySelected(undefined), false)
  assert.equal(anySelected({ type: ['bug'] }), true)
})

test('сброс снимает всё', () => {
  assert.deepEqual(clearFilters(), {})
  assert.equal(anySelected(clearFilters()), false)
})

test('известный порядок содержит все семь пространств разметки', () => {
  assert.deepEqual(KNOWN_ORDER, ['type', 'priority', 'status', 'scope', 'risk', 'signal', 'release'])
})

// ------------------------------------------------- метки обязаны обновляться

test('сверка забирает метки и заголовок из Gitea', () => {
  // Отбор по устаревшим меткам хуже отсутствия отбора: он выглядит рабочим и
  // молча врёт.
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'in-progress', title: 'старое имя',
    owner: 'o', repo: 'r', issueNumber: 1, labels: ['type/bug'],
  })
  applyObservation({
    store,
    task: store.getTask(task.id),
    observation: { column: undefined, branch: undefined, pull: undefined },
    issue: { title: 'новое имя', labels: [{ name: 'type/bug' }, { name: 'priority/high' }] },
  })
  const out = store.getTask(task.id)
  assert.equal(out.title, 'новое имя')
  assert.deepEqual(out.labels, ['type/bug', 'priority/high'])
  cleanup()
})

test('снятая в Gitea метка исчезает и с карточки', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'in-progress', title: 'A',
    owner: 'o', repo: 'r', issueNumber: 1, labels: ['type/bug', 'priority/high'],
  })
  applyObservation({
    store,
    task: store.getTask(task.id),
    observation: { column: undefined, branch: undefined, pull: undefined },
    issue: { title: 'A', labels: [{ name: 'type/bug' }] },
  })
  assert.deepEqual(store.getTask(task.id).labels, ['type/bug'])
  cleanup()
})

test('тело задачи сверка НЕ трогает', () => {
  // Тело правит человек заметкой из чипа, и сверка, затирающая его каждые две
  // минуты, съедала бы заметки.
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'in-progress', title: 'A', body: 'моя заметка',
    owner: 'o', repo: 'r', issueNumber: 1, labels: [],
  })
  applyObservation({
    store,
    task: store.getTask(task.id),
    observation: { column: undefined, branch: undefined, pull: undefined },
    issue: { title: 'A', body: 'тело из Gitea', labels: [] },
  })
  assert.equal(store.getTask(task.id).body, 'моя заметка')
  cleanup()
})

test('совпавшие метки лишней записи не делают', () => {
  // Лишняя запись поднимает updatedAt, а по нему разрешается спор о том, кто
  // двигал задачу позже.
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'in-progress', title: 'A',
    owner: 'o', repo: 'r', issueNumber: 1, labels: ['type/bug'],
  })
  const before = store.getTask(task.id)
  applyObservation({
    store,
    task: before,
    observation: { column: undefined, branch: undefined, pull: undefined },
    // Тот же набор в другом порядке — это не изменение.
    issue: { title: 'A', labels: [{ name: 'type/bug' }] },
  })
  assert.deepEqual(store.getTask(task.id).labels, ['type/bug'])
  cleanup()
})

test('issue без меток и заголовка карточку не портит', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'in-progress', title: 'A',
    owner: 'o', repo: 'r', issueNumber: 1, labels: ['type/bug'],
  })
  applyObservation({
    store,
    task: store.getTask(task.id),
    observation: { column: undefined, branch: undefined, pull: undefined },
    issue: undefined,
  })
  const out = store.getTask(task.id)
  assert.equal(out.title, 'A')
  assert.deepEqual(out.labels, ['type/bug'])
  cleanup()
})

// ------------------------------------------------- те же правила в браузере

test('браузер сверяет разобранные метки, а не разбирает их сам', () => {
  // Разбор живёт на сервере: написанный в браузере во второй раз, он однажды
  // разойдётся с первым.
  const h = loadClient().exported.helpers
  const task = { repo: 'dsh-kanban', facets: { type: ['bug'], priority: ['high'] } }
  assert.equal(h.matchesFilters(task, { type: ['bug'] }), true)
  assert.equal(h.matchesFilters(task, { type: ['feature'] }), false)
  assert.equal(h.matchesFilters(task, { type: ['bug'], priority: ['low'] }), false)
  assert.equal(h.matchesFilters(task, { type: ['bug', 'feature'] }), true)
})

test('браузер отбирает по репозиторию так же, как по метке', () => {
  const h = loadClient().exported.helpers
  const task = { repo: 'dsh-kanban', facets: {} }
  assert.equal(h.matchesFilters(task, { repo: ['dsh-kanban'] }), true)
  assert.equal(h.matchesFilters(task, { repo: ['memory-brain'] }), false)
  assert.equal(h.matchesFilters({ facets: {} }, { repo: ['dsh-kanban'] }), false)
})

test('пустой отбор в браузере доску не сужает', () => {
  const h = loadClient().exported.helpers
  const task = { repo: 'r', facets: {} }
  for (const empty of [{}, undefined, { type: [] }]) {
    assert.equal(h.matchesFilters(task, empty), true)
  }
})

test('переключение в браузере ведёт себя как на сервере', () => {
  const h = loadClient().exported.helpers
  const one = h.toggleValue({}, 'type', 'bug')
  assert.deepEqual(Array.from(one.type), ['bug'])
  assert.deepEqual(Object.keys(h.toggleValue(one, 'type', 'bug')), [])
  assert.equal(h.anySelected({}), false)
  assert.equal(h.anySelected(one), true)
})

// ------------------------------------------------- цвета меток (#107)

test('цвет принимается только шестнадцатеричным кодом', () => {
  // Значение приходит из Gitea и попадает прямо в стиль: пускать туда что
  // попало нельзя.
  assert.equal(labelColor('0e8a16'), '0e8a16')
  assert.equal(labelColor('#FF6600'), 'ff6600')
  for (const wrong of ['красный', '', '12345', '1234567', 'ggghhh', undefined, null, 42]) {
    assert.equal(labelColor(wrong), undefined, String(wrong))
  }
})

test('карта цветов собирается из меток issue', () => {
  const out = colorsOfIssue([
    { name: 'type/feature', color: '0e8a16' },
    { name: 'без цвета' },
    { name: 'мусорный цвет', color: 'нет' },
    'строкой',
  ])
  assert.deepEqual(out, { 'type/feature': '0e8a16' })
})

test('метка без цвета в карту не попадает', () => {
  // Иначе на карточке появится чёрный прямоугольник вместо нейтральной метки.
  assert.deepEqual(colorsOfIssue([{ name: 'epic' }]), {})
  assert.deepEqual(colorsOfIssue(undefined), {})
})

test('цвет доезжает от issue до карточки и обновляется сверкой', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 1,
    labels: ['type/bug'], labelColors: { 'type/bug': 'd73a4a' },
  })
  assert.equal(store.getTask(task.id).labelColors['type/bug'], 'd73a4a')

  applyObservation({
    store,
    task: store.getTask(task.id),
    observation: { column: undefined, branch: undefined, pull: undefined },
    issue: { title: 'A', labels: [{ name: 'type/bug', color: '111111' }] },
  })
  assert.equal(store.getTask(task.id).labelColors['type/bug'], '111111')
  cleanup()
})

test('испорченная карта цветов не роняет чтение доски', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.updateTask(task.id, { labelColors: undefined })
  assert.deepEqual(store.getTask(task.id).labelColors, {})
  cleanup()
})

test('текст на светлом фоне тёмный, на тёмном — светлый', () => {
  const h = loadClient().exported.helpers
  assert.equal(h.readableOn('ffffff'), '#111')
  assert.equal(h.readableOn('0e8a16'), '#fff')
  assert.equal(h.readableOn('000000'), '#fff')
  // Насыщенный зелёный по яркости тёмный — белый текст на нём верен, и так же
  // считает сам Gitea. Тёмного текста требует по-настоящему светлый фон.
  assert.equal(h.readableOn('00aa00'), '#fff')
  assert.equal(h.readableOn('c2e0c6'), '#111', 'бледно-зелёный требует тёмного текста')
  assert.equal(h.readableOn('нет цвета'), '')
})

test('метка без цвета остаётся нейтральной', () => {
  const h = loadClient().exported.helpers
  assert.equal(h.tagStyle({ labelColors: {} }, 'epic'), undefined)
  assert.equal(h.tagStyle({}, 'epic'), undefined)
  const style = h.tagStyle({ labelColors: { 'type/bug': 'd73a4a' } }, 'type/bug')
  assert.equal(style.background, '#d73a4a')
  assert.equal(style.color, '#fff')
})

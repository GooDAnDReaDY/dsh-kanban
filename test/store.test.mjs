import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore, reopenStore } from './helpers.mjs'

test('обе доски заводятся сразу', () => {
  // Пустое хранилище без единой доски выглядит в интерфейсе как поломка.
  const { store, cleanup } = freshStore()
  const boards = store.listBoards()
  assert.deepEqual(boards.map((b) => b.id), ['main', 'simple'])
  assert.deepEqual(boards.map((b) => b.kind), ['project', 'simple'])
  cleanup()
})

test('createTask кладёт задачу в конец колонки', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'Первая' })
  const b = store.createTask({ board: 'main', column: 'backlog', title: 'Вторая' })
  assert.deepEqual(store.listTasks({ board: 'main' }).map((t) => t.title), ['Первая', 'Вторая'])
  assert.ok(a.position < b.position)
  cleanup()
})

test('moveTask между соседями не трогает соседей', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  const b = store.createTask({ board: 'main', column: 'backlog', title: 'B' })
  const c = store.createTask({ board: 'main', column: 'backlog', title: 'C' })
  const posA = a.position
  const posB = b.position
  store.moveTask(c.id, { column: 'backlog', afterId: a.id, beforeId: b.id })
  assert.equal(store.getTask(a.id).position, posA, 'сосед слева переписан')
  assert.equal(store.getTask(b.id).position, posB, 'сосед справа переписан')
  assert.deepEqual(store.listTasks({ board: 'main' }).map((t) => t.title), ['A', 'C', 'B'])
  cleanup()
})

test('moveTask в другую колонку ставит в конец', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  const b = store.createTask({ board: 'main', column: 'backlog', title: 'B' })
  store.moveTask(b.id, { column: 'in-progress' })
  const inProgress = store.listTasks({ board: 'main' }).filter((t) => t.column === 'in-progress')
  assert.deepEqual(inProgress.map((t) => t.title), ['A', 'B'])
  cleanup()
})

test('moveTask без колонки оставляет карточку в своей колонке', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'review', title: 'A' })
  const moved = store.moveTask(a.id, {})
  assert.equal(moved.column, 'review')
  cleanup()
})

test('labels отдаются массивом, а не строкой', () => {
  const { store, cleanup } = freshStore()
  const t1 = store.createTask({ board: 'main', column: 'backlog', title: 'A', labels: ['bug', 'p2'] })
  assert.deepEqual(store.getTask(t1.id).labels, ['bug', 'p2'])
  cleanup()
})

test('задача без меток отдаёт пустой массив', () => {
  const { store, cleanup } = freshStore()
  const t1 = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  assert.deepEqual(store.getTask(t1.id).labels, [])
  cleanup()
})

test('updateTask правит разрешённые поля и не трогает порядок', () => {
  const { store, cleanup } = freshStore()
  const t1 = store.createTask({ board: 'main', column: 'backlog', title: 'Старый' })
  const before = store.getTask(t1.id)
  const after = store.updateTask(t1.id, { title: 'Новый', labels: ['feat'] })
  assert.equal(after.title, 'Новый')
  assert.deepEqual(after.labels, ['feat'])
  assert.equal(after.position, before.position)
  assert.equal(after.column, before.column)
  cleanup()
})

test('updateTask не даёт переписать колонку и позицию в обход moveTask', () => {
  const { store, cleanup } = freshStore()
  const t1 = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  const after = store.updateTask(t1.id, { column: 'done', position: 'zzz' })
  assert.equal(after.column, 'backlog')
  assert.notEqual(after.position, 'zzz')
  cleanup()
})

test('updateTask по несуществующей задаче отвергается', () => {
  const { store, cleanup } = freshStore()
  assert.throws(() => store.updateTask('нет-такой', { title: 'A' }))
  cleanup()
})

test('фильтр по репозиторию отбирает задачи одного репозитория', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'one' })
  store.createTask({ board: 'main', column: 'backlog', title: 'B', owner: 'o', repo: 'two' })
  assert.deepEqual(store.listTasks({ board: 'main', repo: 'one' }).map((t) => t.title), ['A'])
  cleanup()
})

test('задача находится по идентификатору сессии', () => {
  const { store, cleanup } = freshStore()
  const t1 = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.updateTask(t1.id, { sessionId: 'kanban-1-abc' })
  assert.equal(store.findTaskBySession('kanban-1-abc').id, t1.id)
  assert.equal(store.findTaskBySession('msgw-xyz'), undefined)
  cleanup()
})

test('перезапуск задачи перекрывает старую сессию', () => {
  const { store, cleanup } = freshStore()
  const t1 = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.updateTask(t1.id, { sessionId: 'kanban-1-old' })
  store.updateTask(t1.id, { sessionId: 'kanban-1-new' })
  assert.equal(store.findTaskBySession('kanban-1-new').id, t1.id)
  assert.equal(store.findTaskBySession('kanban-1-old'), undefined)
  cleanup()
})

test('журнал переходов пишется и читается по времени', () => {
  const { store, cleanup } = freshStore()
  const t1 = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.addTransition({ taskId: t1.id, fromCol: 'backlog', toCol: 'in-progress', source: 'manual' })
  store.addTransition({ taskId: t1.id, fromCol: 'in-progress', toCol: 'review', source: 'gitea', detail: 'PR #9' })
  const log = store.listTransitions(t1.id)
  assert.equal(log.length, 2)
  assert.equal(log[0].toCol, 'in-progress')
  assert.equal(log[1].source, 'gitea')
  assert.equal(log[1].detail, 'PR #9')
  cleanup()
})

test('неизвестный источник перехода отвергается', () => {
  const { store, cleanup } = freshStore()
  const t1 = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  assert.throws(() => store.addTransition({ taskId: t1.id, toCol: 'done', source: 'откуда-то' }))
  cleanup()
})

test('счётчик колонки считает только свою колонку', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  store.createTask({ board: 'main', column: 'in-progress', title: 'B' })
  store.createTask({ board: 'main', column: 'backlog', title: 'C' })
  assert.equal(store.countInColumn('main', 'in-progress'), 2)
  assert.equal(store.countInColumn('main', 'backlog'), 1)
  cleanup()
})

test('удаление убирает задачу', () => {
  const { store, cleanup } = freshStore()
  const t1 = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.deleteTask(t1.id)
  assert.equal(store.getTask(t1.id), undefined)
  cleanup()
})

test('порядок держится после переоткрытия базы', () => {
  const { store, dir, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.createTask({ board: 'main', column: 'backlog', title: 'B' })
  store.close()
  // Открываем заново тот же каталог: данные обязаны пережить перезапуск.
  const again = reopenStore(dir)
  assert.deepEqual(again.listTasks({ board: 'main' }).map((t) => t.title), ['A', 'B'])
  again.close()
  cleanup()
})

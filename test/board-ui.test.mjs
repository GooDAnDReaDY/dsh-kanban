import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, stubCtx } from './client-load.mjs'

/**
 * Значения рождены внутри vm-контекста: у них другой прототип, и строгое
 * сравнение отвергло бы совпадающее содержимое. Переносим в свой контекст.
 */
const pair = (o) => ({ afterId: o.afterId, beforeId: o.beforeId })

const { exported } = loadClient()
const h = exported.helpers
const column = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

test('перенос в начало колонки: соседа слева нет', () => {
  assert.deepEqual(pair(h.neighboursFor(column, 'c', 0)), { afterId: undefined, beforeId: 'a' })
})

test('перенос в конец колонки: соседа справа нет', () => {
  assert.deepEqual(pair(h.neighboursFor(column, 'c', 2)), { afterId: 'b', beforeId: undefined })
})

test('перенос в середину даёт обоих соседей', () => {
  assert.deepEqual(pair(h.neighboursFor(column, 'c', 1)), { afterId: 'a', beforeId: 'b' })
})

test('перетаскиваемая карточка не может быть своим же соседом', () => {
  const out = pair(h.neighboursFor(column, 'b', 1))
  assert.notEqual(out.afterId, 'b')
  assert.notEqual(out.beforeId, 'b')
  assert.deepEqual(out, { afterId: 'a', beforeId: 'c' })
})

test('индекс за пределами списка прижимается к краю', () => {
  assert.deepEqual(pair(h.neighboursFor(column, 'a', 99)), { afterId: 'c', beforeId: undefined })
  assert.deepEqual(pair(h.neighboursFor(column, 'a', -5)), { afterId: undefined, beforeId: 'b' })
})

test('перенос в пустую колонку не даёт соседей', () => {
  assert.deepEqual(pair(h.neighboursFor([], 'a', 0)), { afterId: undefined, beforeId: undefined })
})

test('карточки колонки отбираются по колонке', () => {
  const tasks = [{ id: '1', column: 'backlog' }, { id: '2', column: 'review' }, { id: '3', column: 'backlog' }]
  assert.deepEqual(Array.from(h.tasksOf(tasks, 'backlog')).map((t) => t.id), ['1', '3'])
  assert.equal(Array.from(h.tasksOf(tasks, 'done')).length, 0)
})

test('подпись карточки показывает репозиторий и номер issue', () => {
  assert.equal(h.cardRef({ repo: 'dsh-kanban', issueNumber: 12 }), 'dsh-kanban#12')
  assert.equal(h.cardRef({ repo: 'dsh-kanban' }), 'dsh-kanban')
  assert.equal(h.cardRef({}), '')
  assert.equal(h.cardRef(undefined), '')
})

test('строка состояния собирается из заполненных полей', () => {
  assert.equal(h.cardStatus({ model: 'claude-opus-5', branch: 'feat/x' }), 'claude-opus-5 · feat/x')
  assert.equal(h.cardStatus({ model: 'claude-opus-5' }), 'claude-opus-5')
  assert.equal(h.cardStatus({}), '')
})

test('пустой ответ доски всё равно даёт шесть колонок', () => {
  const out = h.normalizeBoard(undefined)
  assert.deepEqual(Array.from(out.columns).map((c) => c.id),
    ['backlog', 'in-progress', 'review', 'deploy', 'cleanup', 'done'])
  assert.equal(Array.from(out.tasks).length, 0)
})

test('фильтр репозиториев собирается из задач без повторов', () => {
  assert.deepEqual(Array.from(h.reposOf([{ repo: 'b' }, { repo: 'a' }, { repo: 'b' }, {}, { repo: '' }])), ['a', 'b'])
})

test('каждой ошибке маршрута отвечает свой ключ перевода', () => {
  assert.equal(h.errorKey('gitea-absent'), 'error.giteaAbsent')
  assert.equal(h.errorKey('gitea-unconfigured'), 'error.giteaUnconfigured')
  assert.equal(h.errorKey('task-has-no-issue'), 'error.taskHasNoIssue')
  assert.equal(h.errorKey('что-то новое'), 'error.unknown')
})

test('при живом слоте плагинов карточка встаёт именно туда', () => {
  const { ctx, registered } = stubCtx({ available: ['settings.plugin.item', 'app.section'] })
  exported.apply(ctx)
  const card = registered.find((e) => e.name === 'settings.plugin.item')
  assert.ok(card, 'карточка не зарегистрирована')
  assert.equal(card.key, 'dsh-kanban', 'ключ слота не равен пространству настроек')
  assert.equal(card.locale, 'dsh-kanban', 'без locale компонент не получит props.t')
})

test('без слота плагинов карточка уходит в запасной раздел', () => {
  // Соседний плагин делает так же: если настроечного слота в сборке нет,
  // регистрация не пройдёт, и настройки просто пропали бы.
  const { ctx, registered } = stubCtx({ available: ['settings.section'] })
  exported.apply(ctx)
  assert.ok(registered.some((e) => e.name === 'settings.section'))
})

test('доска встаёт в раздел верхнего уровня, когда он есть', () => {
  const { ctx, registered } = stubCtx({ available: ['settings.plugin.item', 'app.section'] })
  exported.apply(ctx)
  const board = registered.find((e) => e.id === '@goodandready/dsh-kanban.board')
  assert.ok(board)
  assert.equal(board.name, 'app.section')
})

test('доска не теряется, даже если раздела верхнего уровня нет', () => {
  const { ctx, registered } = stubCtx({ available: ['settings.section'] })
  exported.apply(ctx)
  const board = registered.find((e) => e.id === '@goodandready/dsh-kanban.board')
  assert.ok(board, 'доска не зарегистрирована ни в один слот')
})

test('когда ни одного слота нет, регистрация не роняет плагин', () => {
  const { ctx, registered } = stubCtx({ available: [] })
  assert.doesNotThrow(() => exported.apply(ctx))
  assert.equal(registered.length, 0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, stubCtx } from './client-load.mjs'

const { exported, src } = loadClient()
const h = exported.helpers

test('константы посадки строки плагина соответствуют канону и cordis.patch.yml', () => {
  assert.equal(h.PKG, '@goodandready/dsh-kanban')
  assert.equal(h.ROW_ID, 'dsh-kanban')
  assert.equal(h.ROW_CONFIG_KEY, '@goodandready/dsh-kanban#dsh-kanban')
  assert.equal(h.ROW_CONFIG_KEY, `${h.PKG}#${h.ROW_ID}`)
})

test('порядок посадок: сначала plugins.row.config, затем plugins.item, затем settings.plugin.item (#274)', () => {
  const { ctx, registered } = stubCtx({
    available: ['plugins.row.config', 'plugins.item', 'settings.plugin.item'],
  })
  exported.apply(ctx)

  const names = registered.map((e) => e.name)
  assert.deepEqual(names, ['plugins.row.config', 'plugins.item', 'settings.plugin.item'])

  // 1. Посадка строки в Plugin Manager (DSH 0.1.6-alpha.2)
  const rowSeat = registered[0]
  assert.equal(rowSeat.name, 'plugins.row.config')
  assert.equal(rowSeat.key, '@goodandready/dsh-kanban#dsh-kanban')
  assert.equal(rowSeat.locale, 'dsh-kanban')

  // 2. Посадка в официальный список плагинов
  const itemSeat = registered[1]
  assert.equal(itemSeat.name, 'plugins.item')
  assert.equal(itemSeat.id, 'dsh-kanban')
  assert.equal(itemSeat.order, 60)
  assert.equal(itemSeat.label(), 'Kanban')
  assert.equal(itemSeat.locale, 'dsh-kanban')

  // 3. Фолбэк для прежних версий ядра
  const legacySeat = registered[2]
  assert.equal(legacySeat.name, 'settings.plugin.item')
  assert.equal(legacySeat.key, 'dsh-kanban')
  assert.equal(legacySeat.locale, 'dsh-kanban')
})

test('отсутствие нового слота plugins.row.config не срывает регистрацию фолбэка settings.plugin.item', () => {
  const { ctx, registered } = stubCtx({
    available: ['settings.plugin.item'],
  })
  assert.doesNotThrow(() => exported.apply(ctx))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'settings.plugin.item')
  assert.equal(registered[0].key, 'dsh-kanban')
})

test('KanbanSettingsCard: вид summary отдаёт однострочник без карточки (#274)', () => {
  const v = h.KanbanSettingsCard({ view: 'summary', t: (k) => k })
  assert.ok(v, 'компонент ничего не вернул')
  assert.equal(v.type, 'span')
  assert.equal(v.props.className, 'dkb-sub')
})

test('KanbanSettingsCard: вид page рендерит форму bare без своего head (#274)', () => {
  const v = h.KanbanSettingsCard({ view: 'page', t: (k) => k })
  assert.ok(v, 'компонент ничего не вернул')
  assert.equal(v.type, 'div')
  assert.equal(v.props.className, 'dkb-page')
  // Внутри находится dkb-body, но нет внешней кнопки-шапки dkb-head
  const children = Array.isArray(v.children) ? v.children : [v.children]
  const hasHead = children.some((c) => c && c.props && c.props.className === 'dkb-head')
  assert.equal(hasHead, false, 'вид page не должен иметь кнопку-заголовок dkb-head')
})

test('KanbanSettingsCard: обычный вид рендерит закрытую карточку с заголовком dkb-head', () => {
  const v = h.KanbanSettingsCard({ t: (k) => k })
  assert.ok(v, 'компонент ничего не вернул')
  assert.equal(v.type, 'li')
  assert.equal(v.props.className, 'dkb-card')
  const head = v.children && v.children[0]
  assert.ok(head, 'нет дочернего элемента')
  assert.equal(head.props.className, 'dkb-head')
})

test('плагин никогда не регистрирует раздел настроек settings.section', () => {
  assert.doesNotMatch(src, /name:\s*['"]settings\.section['"]/)
})

// Регрессия на контракт `defineTool` из dsh-tools: он безусловно читает
// `options.output.render`, а `parameters` разбирает как карту свойств.
// Прежнее определение board_move давало здесь TypeError, и падала не карточка
// инструмента, а загрузка всего профиля web.
import test from 'node:test'
import assert from 'node:assert/strict'
import { boardMoveDefinition, sessionIdFromExec } from '../lib/board-tool.js'
import { COLUMN_ORDER } from '../lib/config.js'
import { TOOL_FORBIDDEN_COLUMNS } from '../lib/commands.js'
import { freshStore } from './helpers.mjs'

const stubStore = { listTasksBySession: () => [], findTaskBySession: () => undefined, moveTask() {}, addTransition() {} }

test('output объявлен: render есть и отдаёт части содержимого', () => {
  const def = boardMoveDefinition({ store: stubStore })
  assert.equal(typeof def.output?.render, 'function', 'без output.render defineTool роняет весь профиль')
  assert.deepEqual(def.output.schema.type, 'string')
  assert.deepEqual(def.output.render({}, 'Card moved to done.'),
    [{ type: 'text', text: 'Card moved to done.' }])
})

test('parameters — карта свойств, а не JSON Schema с корнем object', () => {
  const { parameters } = boardMoveDefinition({ store: stubStore })
  assert.equal(parameters.type, undefined, 'корень type: object отвергается value schema DSL')
  assert.equal(parameters.properties, undefined)
  // `done` вырезан намеренно: завершение задачи не должно опираться на
  // заявление инструмента, см. lib/commands.js.
  assert.deepEqual(parameters.column.enum,
    COLUMN_ORDER.filter((c) => !TOOL_FORBIDDEN_COLUMNS.includes(c)))
})

test('обязательность выражается только через required: true', () => {
  const { parameters } = boardMoveDefinition({ store: stubStore })
  assert.equal(parameters.column.required, true)
  // `required: false`, `optional` и `nullable` DSL отвергает — необязательное
  // поле просто не несёт признака.
  assert.equal('required' in parameters.detail, false)
  assert.equal('optional' in parameters.detail, false)
  assert.equal('nullable' in parameters.detail, false)
})

test('сессия читается и из agent.session, и из session', () => {
  assert.equal(sessionIdFromExec({ agent: { session: { id: 'a' } } }), 'a')
  assert.equal(sessionIdFromExec({ session: { id: 'b' } }), 'b')
  assert.equal(sessionIdFromExec(undefined), '')
})

test('execute двигает карточку сессии по новому месту контекста', async () => {
  const { store, cleanup } = freshStore()
  try {
    const sessionId = 'session-board-tool'
    store.createTask({ title: 'проверка', column: COLUMN_ORDER[0], sessionId })

    const def = boardMoveDefinition({ store })
    const target = COLUMN_ORDER[1]
    const said = await def.execute({ column: target }, { agent: { session: { id: sessionId } } })

    assert.match(said, new RegExp(target))
    assert.equal(store.findTaskBySession(sessionId).column, target)
  } finally { cleanup() }
})

test('без карточки за сессией инструмент отвечает отказом, а не бросает', async () => {
  const def = boardMoveDefinition({ store: stubStore })
  const said = await def.execute({ column: COLUMN_ORDER[1] }, {})
  assert.match(said, /no kanban task/)
})

// Перенос карточки как команда агенту: таблица последствий, остановка хода,
// граница инструмента.
import test from 'node:test'
import assert from 'node:assert/strict'

import { commandFor, columnsOfKind, dispatchMove, MOVE_DETAIL, TOOL_FORBIDDEN_COLUMNS } from '../lib/commands.js'
import { COLUMN_ORDER } from '../lib/config.js'
import { boardMoveDefinition } from '../lib/board-tool.js'
import { loadClient } from './client-load.mjs'

const createMessage = (m) => m

/** Заглушка агента: помнит, чем его отменяли и что ему отправили. */
function stubAgent(status = 'running') {
  const sent = []
  const cancelled = []
  return {
    sent,
    cancelled,
    agent: {
      status,
      cancel: (cause) => cancelled.push(cause),
      followup: (m) => sent.push(m),
    },
  }
}

const agentsWith = (agent) => ({ get: () => agent })

test('у каждой колонки проектной доски есть команда', () => {
  // Добавить колонку и забыть, что она означает, — значит подарить человеку
  // перенос без последствий и без объяснения.
  for (const column of COLUMN_ORDER) {
    const command = commandFor(column)
    assert.notEqual(command, undefined, `нет команды для ${column}`)
    const named = command.stops || command.humanOnly || command.instruction !== ''
    assert.ok(named, `колонка ${column} ничего не означает`)
  }
})

test('колонки простой доски — подмножество проектных', () => {
  for (const column of columnsOfKind('simple')) {
    assert.ok(COLUMN_ORDER.includes(column), `простая доска знает чужую колонку ${column}`)
    assert.notEqual(commandFor(column, 'simple'), undefined)
  }
})

test('перенос в Deploy назван разрешением на выкатку', () => {
  // Воркфлоу требует явного «ок» перед deploy. Если инструкция об этом молчит,
  // агент спросит разрешение, которое уже получил движением карточки.
  assert.match(commandFor('deploy').instruction, /ок/)
})

test('бэклог останавливает, done — решение человека', () => {
  assert.equal(commandFor('backlog').stops, true)
  assert.equal(commandFor('backlog').instruction, '')
  assert.equal(commandFor('done').humanOnly, true)
})

test('незнакомая колонка команды не имеет', () => {
  assert.equal(commandFor('нет-такой'), undefined)
  assert.equal(commandFor('deploy', 'нет-такой-доски'), undefined)
})

// ------------------------------------------------- исполнение команды

test('перенос в бэклог прерывает идущий ход', () => {
  const { agent, cancelled } = stubAgent('running')
  const out = dispatchMove({
    agents: agentsWith(agent), task: { id: 't1', column: 'in-progress', sessionId: 's1' },
    column: 'backlog', createMessage,
  })
  assert.equal(out.acted, 'stopped')
  assert.deepEqual(cancelled, [{ kind: 'user' }])
})

test('останавливать нечего, если агент не работает', () => {
  const { agent, cancelled } = stubAgent('idle')
  const out = dispatchMove({
    agents: agentsWith(agent), task: { id: 't1', column: 'in-progress', sessionId: 's1' },
    column: 'backlog', createMessage,
  })
  assert.equal(out.acted, 'idle')
  assert.equal(cancelled.length, 0)
})

test('карточка без сессии просто двигается', () => {
  const out = dispatchMove({
    agents: { get: () => undefined }, task: { id: 't1', column: 'backlog', sessionId: '' },
    column: 'in-progress', createMessage,
  })
  assert.equal(out.acted, 'no-session')
})

test('команда уходит в чат задачи массивом блоков', () => {
  // Строка вместо массива роняет ход целиком: ядро перебирает содержимое.
  const { agent, sent } = stubAgent('idle')
  const out = dispatchMove({
    agents: agentsWith(agent), task: { id: 't1', column: 'in-progress', sessionId: 's1' },
    column: 'review', createMessage,
  })
  assert.equal(out.acted, 'sent')
  assert.equal(sent.length, 1)
  assert.ok(Array.isArray(sent[0].content))
  assert.equal(sent[0].content[0].type, 'text')
  assert.equal(sent[0].content[0].text, commandFor('review').instruction)
})

test('перенос в done агенту ничего не поручает', () => {
  const { agent, sent, cancelled } = stubAgent('running')
  const out = dispatchMove({
    agents: agentsWith(agent), task: { id: 't1', column: 'deploy', sessionId: 's1' },
    column: 'done', createMessage,
  })
  assert.equal(out.acted, 'human')
  assert.equal(sent.length, 0)
  assert.equal(cancelled.length, 0)
})

test('павший агент не роняет перенос', () => {
  const out = dispatchMove({
    agents: { get: () => { throw new Error('реестр недоступен') } },
    task: { id: 't1', column: 'in-progress', sessionId: 's1' },
    column: 'review', createMessage,
  })
  assert.equal(out.acted, 'no-session')
})

test('у каждого исхода есть пояснение для журнала', () => {
  for (const acted of ['stopped', 'sent', 'idle', 'no-session', 'human', 'unknown']) {
    assert.equal(typeof MOVE_DETAIL[acted], 'string', `нет пояснения для ${acted}`)
  }
})

// ------------------------------------------------- граница инструмента

test('инструмент не предлагает done и отвергает его', async () => {
  const tool = boardMoveDefinition({ store: { listTasksBySession: () => [{ id: 't1', column: 'deploy' }] } })
  for (const forbidden of TOOL_FORBIDDEN_COLUMNS) {
    assert.ok(!tool.parameters.column.enum.includes(forbidden), `${forbidden} остался в перечислении`)
    const said = await tool.execute({ column: forbidden }, { agent: { session: { id: 's1' } } })
    assert.match(said, /not finished by moving/)
  }
})

test('разрешённые колонки инструмент по-прежнему двигает', async () => {
  const moved = []
  const store = {
    listTasksBySession: () => [{ id: 't1', column: 'in-progress' }],
    moveTask: (id, patch) => moved.push([id, patch.column]),
    addTransition: () => {},
  }
  const tool = boardMoveDefinition({ store })
  await tool.execute({ column: 'review' }, { agent: { session: { id: 's1' } } })
  assert.deepEqual(moved, [['t1', 'review']])
})

// ------------------------------------------------- окно подтверждения

test('последствия перевода описаны на обоих языках', () => {
  // Окно без описания последствий превращается в «вы уверены?», ради которого
  // подтверждение и не заводили.
  const { src } = loadClient()
  for (const column of COLUMN_ORDER) {
    const matches = src.split(`'move.${column}':`).length - 1
    assert.equal(matches, 2, `у move.${column} не два перевода, а ${matches}`)
  }
})

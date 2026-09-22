// Профиль агента и уровень доступа при запуске задачи.
import test from 'node:test'
import assert from 'node:assert/strict'

import { obtainAgent, applyPermission } from '../lib/launcher.js'
import { withDefaults } from '../lib/config.js'
import { loadClient } from './client-load.mjs'

const config = withDefaults({ defaultProjectRoot: '/projects' })

/** Заглушка реестра агентов: помнит, с чем создавали. */
function stubAgents() {
  const seen = []
  const agent = { status: 'idle', session: { id: 's1' }, whenIdle: async () => {}, followup() {} }
  let disposed = 0
  return {
    seen,
    disposedCount: () => disposed,
    agents: {
      get: () => undefined,
      create: async (options) => { seen.push(options); return { agent, dispose: () => { disposed += 1 } } },
    },
  }
}

test('выбранный профиль едет в создание сессии', async () => {
  // Профиль — факт создания: у идущей сессии его не сменить.
  const { agents, seen } = stubAgents()
  await obtainAgent({
    agents, task: {}, config, provider: 'p', model: 'm',
    mintSessionId: () => 's1', agentPreset: 'reviewer',
    permissions: { set() {} }, permission: '',
  })
  assert.equal(seen[0].meta.agentPreset, 'reviewer')
  assert.equal(seen[0].meta.cwd, '/projects', 'рабочая папка на месте')
})

test('без выбора профиля поле не подставляется вовсе', async () => {
  // Пустая строка вместо отсутствия сорвала бы сборку сессии: такого профиля
  // у ядра нет, а «по умолчанию» — это именно отсутствие поля.
  const { agents, seen } = stubAgents()
  await obtainAgent({
    agents, task: {}, config, provider: 'p', model: 'm', mintSessionId: () => 's1', agentPreset: '',
  })
  assert.equal('agentPreset' in seen[0].meta, false)
})

test('уровень доступа ставится выбранной сессии', () => {
  const calls = []
  const out = applyPermission({
    permissions: { set: (session, name) => calls.push([session.id, name]) },
    agent: { session: { id: 's1' } },
    name: 'workspace-write',
  })
  assert.deepEqual(out, { applied: 'workspace-write' })
  assert.deepEqual(calls, [['s1', 'workspace-write']])
})

test('без выбора доступа службу не трогают', () => {
  assert.deepEqual(applyPermission({ permissions: undefined, agent: {}, name: '' }), { skipped: 'not-picked' })
})

test('выбран доступ, а поставить нечем — задача НЕ запускается', async () => {
  // Иначе сессия пошла бы с правами по умолчанию, то есть, возможно,
  // бо́льшими, чем просили. Молчаливое расширение прав хуже отказа.
  const { agents, disposedCount } = stubAgents()
  await assert.rejects(
    obtainAgent({
      agents, task: {}, config, provider: 'p', model: 'm', mintSessionId: () => 's1',
      permission: 'workspace-write', permissions: undefined,
    }),
    (error) => error.key === 'permission-unavailable' && error.status === 409,
  )
  assert.equal(disposedCount(), 1, 'поднятая сессия убрана за собой')
})

test('отказ службы доступа тоже останавливает запуск', async () => {
  const { agents } = stubAgents()
  await assert.rejects(
    obtainAgent({
      agents, task: {}, config, provider: 'p', model: 'm', mintSessionId: () => 's1',
      permission: 'нет-такого',
      permissions: { set: () => { throw new Error('unknown preset') } },
    }),
    (error) => error.key === 'permission-refused',
  )
})

test('у живой сессии профиль и доступ не спрашиваются заново', async () => {
  // Продолжение — не новый запуск: профиль сессии уже выбран и неизменен.
  const live = { status: 'running', session: { id: 's1' } }
  const out = await obtainAgent({
    agents: { get: () => live }, task: { sessionId: 's1' }, config,
    provider: 'p', model: 'm', mintSessionId: () => 'иное', agentPreset: 'reviewer',
  })
  assert.equal(out.mode, 'opened')
})

test('поля выбора подписаны на обоих языках', () => {
  const { src } = loadClient()
  for (const key of ['panel.agentPreset', 'panel.presetDefault', 'panel.permission',
    'error.permission-unavailable', 'error.permission-refused']) {
    assert.equal(src.split(`'${key}':`).length - 1, 2, `у ${key} не два перевода`)
  }
})

test('одни и те же поля стоят и в окне задачи, и в окне пачки', () => {
  // Пачка идёт одной сессией: профиль и доступ у неё один, и две копии полей
  // разошлись бы при первой правке.
  const { src } = loadClient()
  assert.equal(src.split('React.createElement(LaunchFields').length - 1, 2)
  assert.ok(src.includes('provider, model, text: draftText, agentPreset, permission'))
  assert.ok(src.includes('ids: dialog.ids, provider, model, agentPreset, permission'))
})

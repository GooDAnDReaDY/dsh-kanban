import test from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_DEFAULTS } from '../lib/config.js'

test('autoSyncSessions выключен по умолчанию в CONFIG_DEFAULTS (#225)', () => {
  assert.equal(CONFIG_DEFAULTS.autoSyncSessions, false)
})

test('autoSyncSessions фильтрует канбан-сессии и субагенты (#225)', () => {
  function shouldSyncSession({ session, sessionId, config }) {
    if (config.autoSyncSessions !== true) return false
    const sessionIdStr = String(sessionId || '')
    if (
      !session ||
      session.isSubagent ||
      session.origin === 'subagent' ||
      session.parentId !== undefined ||
      session.meta?.origin === 'subagent' ||
      sessionIdStr.startsWith('kanban-') ||
      sessionIdStr.startsWith('kanban_')
    ) {
      return false
    }
    return true
  }

  const enabledConfig = { autoSyncSessions: true }
  const disabledConfig = { autoSyncSessions: false }

  // Обычная внешняя сессия при включенной настройке
  assert.equal(shouldSyncSession({ session: { id: 'chat-1' }, sessionId: 'chat-1', config: enabledConfig }), true)

  // При выключенной настройке
  assert.equal(shouldSyncSession({ session: { id: 'chat-1' }, sessionId: 'chat-1', config: disabledConfig }), false)

  // Внутренняя сессия канбана игнорируется
  assert.equal(shouldSyncSession({ session: { id: 'kanban-queued-123' }, sessionId: 'kanban-queued-123', config: enabledConfig }), false)

  // Субагент игнорируется
  assert.equal(shouldSyncSession({ session: { id: 'chat-2', isSubagent: true }, sessionId: 'chat-2', config: enabledConfig }), false)
  assert.equal(shouldSyncSession({ session: { id: 'chat-3', origin: 'subagent' }, sessionId: 'chat-3', config: enabledConfig }), false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const clientSource = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('client.js includes RemoteConnectionSection component (#390)', () => {
  assert.ok(clientSource.includes('function RemoteConnectionSection(props)'))
  assert.ok(clientSource.includes('/api/dsh-kanban/remote/test'))
  assert.ok(clientSource.includes('remote-test-card'))
})

test('client.js adds RemoteConnectionSection to settings rows (#390)', () => {
  assert.ok(clientSource.includes("rows.push(h(RemoteConnectionSection, { t, key: 'remote-test' }))"))
})

test('client.js includes remote mode badge in board header (#390)', () => {
  assert.ok(clientSource.includes('state && state.remoteMode'))
  assert.ok(clientSource.includes("t('remote.badge')"))
})

test('client.js onOpenChat opens remote chat session in remote mode (#390)', () => {
  assert.ok(clientSource.includes('if (state && state.remoteMode && x.sessionId)'))
  assert.ok(clientSource.includes('window.open('))
})

test('client.js includes all 10 remote fields in FIELDS (#390)', () => {
  const remoteFields = [
    'remoteMode',
    'remoteHost',
    'remotePort',
    'remoteUser',
    'remoteAuthType',
    'remoteKeyPath',
    'remoteSudoUser',
    'remoteRoot',
    'remoteServerUrl',
    'remoteServerToken',
  ]
  for (const field of remoteFields) {
    assert.ok(
      clientSource.includes("field: '" + field + "', kind:"),
      "missing field in FIELDS: " + field
    )
  }
})

test('client.js includes remote localization keys in en and zh dictionaries (#390)', () => {
  const keys = [
    'group.remote',
    'remote.testBtn',
    'remote.testing',
    'remote.badge',
  ]
  for (const k of keys) {
    assert.ok(clientSource.includes("'" + k + "':"), "missing translation key: " + k)
  }
})

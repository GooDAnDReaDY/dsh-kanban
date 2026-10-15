import test from 'node:test'
import assert from 'node:assert/strict'
import { isNewerVersion, isTrustedUpdateRequest, registerPluginUpdater } from '../lib/updater.js'

test('updater: isNewerVersion correctly compares semver strings', () => {
  assert.equal(isNewerVersion('0.10.22', '0.10.23'), true)
  assert.equal(isNewerVersion('0.10.22', '0.11.0'), true)
  assert.equal(isNewerVersion('0.10.22', '1.0.0'), true)
  assert.equal(isNewerVersion('0.10.22', '0.10.22'), false)
  assert.equal(isNewerVersion('0.10.23', '0.10.22'), false)
  assert.equal(isNewerVersion('0.10.22', '0.10.21'), false)
  assert.equal(isNewerVersion('0.10.22', ''), false)
  assert.equal(isNewerVersion('', '0.10.23'), false)
  assert.equal(isNewerVersion('invalid', '0.10.23'), false)
})

test('updater: isTrustedUpdateRequest validates headers and remote address', () => {
  const validLoopback = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      'x-dsh-plugin-update': '1',
      'sec-fetch-site': 'same-origin',
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
    },
  }
  assert.equal(isTrustedUpdateRequest(validLoopback), true)

  const validLan = {
    socket: { remoteAddress: '10.0.0.100' },
    headers: {
      'x-dsh-plugin-update': '1',
      'sec-fetch-site': 'same-origin',
      host: '10.0.0.100:3000',
      origin: 'http://10.0.0.100:3000',
    },
  }
  assert.equal(isTrustedUpdateRequest(validLan), true)

  // Missing sec-fetch-site rejected (#349)
  assert.equal(isTrustedUpdateRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      'x-dsh-plugin-update': '1',
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
    },
  }), false)

  // Cross-site sec-fetch-site rejected (#349)
  assert.equal(isTrustedUpdateRequest({
    ...validLoopback,
    headers: {
      ...validLoopback.headers,
      'sec-fetch-site': 'cross-site',
    },
  }), false)

  // Same-site and none sec-fetch-site accepted (#349)
  assert.equal(isTrustedUpdateRequest({
    ...validLoopback,
    headers: {
      ...validLoopback.headers,
      'sec-fetch-site': 'same-site',
    },
  }), true)
  assert.equal(isTrustedUpdateRequest({
    ...validLoopback,
    headers: {
      ...validLoopback.headers,
      'sec-fetch-site': 'none',
    },
  }), true)

  // Missing update header
  assert.equal(isTrustedUpdateRequest({
    ...validLoopback,
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
  }), false)

  // Untrusted public IP
  assert.equal(isTrustedUpdateRequest({
    socket: { remoteAddress: '8.8.8.8' },
    headers: {
      'x-dsh-plugin-update': '1',
      host: '8.8.8.8:3000',
      origin: 'http://8.8.8.8:3000',
    },
  }), false)

  // Origin mismatch
  assert.equal(isTrustedUpdateRequest({
    ...validLoopback,
    headers: {
      'x-dsh-plugin-update': '1',
      host: '127.0.0.1:3000',
      origin: 'http://evil.com',
    },
  }), false)
})

test('updater: registerPluginUpdater binds route to ctx.webServer', async () => {
  const registered = []
  const mockCtx = {
    webServer: {
      register(spec) {
        registered.push(spec)
        return () => {}
      },
    },
  }

  const cleanup = registerPluginUpdater(mockCtx, {
    endpoint: '/api/dsh-kanban/update',
    packageName: '@goodandready/dsh-kanban',
    manifestUrl: new URL('../package.json', import.meta.url),
  })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'exact')
  assert.equal(registered[0].path, '/api/dsh-kanban/update')
  assert.equal(typeof registered[0].handler, 'function')
  assert.equal(typeof cleanup, 'function')
})

test('updater: installExact does not override minimumReleaseAge (#369)', async () => {
  const fs = await import('node:fs/promises')
  const updaterSrc = await fs.readFile(new URL('../lib/updater.js', import.meta.url), 'utf8')
  assert.equal(updaterSrc.includes('minimumReleaseAge'), false, 'updater must not bypass minimum release age')
})

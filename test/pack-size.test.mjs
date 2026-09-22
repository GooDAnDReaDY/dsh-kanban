import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// #264: the DSH Store rejects any package file above 262144 bytes and the
// project keeps a practical 250 KiB threshold; AGENTS.md and index.md are
// never publishable. This test turns the pre-release manual check into CI.

test('npm pack stays within the DSH Store size limit and the publish allowlist (#264)', () => {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url))
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const data = JSON.parse(out)
  const entry = Object.values(data)[0]
  const files = entry.files || []
  assert.ok(files.length > 0, 'pack produced files')

  // Strict DSH Store limit: 256 KiB = 262144 bytes
  const blocked = files.filter((f) => f.size > 262144).map((f) => `${f.path} (${f.size} B)`)
  assert.deepEqual(blocked, [], 'files above the 256 KiB DSH Store limit: ' + blocked.join(', '))

  // Practical threshold: 250 KiB = 256000 bytes
  const warn = files.filter((f) => f.size > 256000 && f.size <= 262144).map((f) => `${f.path} (${f.size} B)`)
  assert.deepEqual(warn, [], 'files above the 250 KiB practical threshold: ' + warn.join(', '))

  // Verification that client.js is tracked and safely within the budget
  const clientFile = files.find((f) => f.path === 'lib/client.js')
  assert.ok(clientFile, 'lib/client.js must be present in npm pack')
  assert.ok(clientFile.size < 256000, `lib/client.js must stay below 250 KiB (got ${clientFile.size} bytes)`)

  const paths = files.map((f) => f.path)
  for (const forbidden of ['AGENTS.md', 'index.md', '.env', 'pnpm-lock.yaml']) {
    assert.ok(!paths.includes(forbidden), forbidden + ' must not be published')
  }
  for (const required of ['README.md', 'LICENSE', 'package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js']) {
    assert.ok(paths.includes(required), required + ' must ship in the package')
  }
})

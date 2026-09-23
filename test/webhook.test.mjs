import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifySignature, detectWebhookProvider, parseEvent } from '../lib/webhook.js'

test('verifySignature: проверяет подпись GitHub с префиксом sha256= (#296)', () => {
  const secret = 'my-github-secret-123'
  const body = JSON.stringify({ action: 'opened', issue: { number: 42 } })
  const hmac = createHmac('sha256', secret).update(body).digest('hex')
  const githubSig = `sha256=${hmac}`

  assert.equal(verifySignature(secret, body, githubSig), true)
  assert.equal(verifySignature(secret, body, `sha256=${'0'.repeat(64)}`), false)
  assert.equal(verifySignature(secret, body, 'sha256=invalid-hex'), false)
})

test('detectWebhookProvider: определяет провайдера по заголовкам запроса (#296)', () => {
  // GitHub headers
  assert.equal(detectWebhookProvider({ 'x-github-event': 'issues' }), 'github')
  assert.equal(detectWebhookProvider({ 'x-hub-signature-256': 'sha256=abc' }), 'github')

  // Gitea headers
  assert.equal(detectWebhookProvider({ 'x-gitea-event': 'issues' }), 'gitea')
  assert.equal(detectWebhookProvider({ 'x-gitea-signature': 'abc' }), 'gitea')

  // Fallback
  assert.equal(detectWebhookProvider({}), 'gitea')
  assert.equal(detectWebhookProvider(undefined), 'gitea')
})

test('parseEvent: корректно извлекает репозиторий и номер из GitHub payloads', () => {
  // Issue event
  const issueEvent = {
    repository: { name: 'dsh-kanban', owner: { login: 'goodandready' } },
    issue: { number: 101 },
  }
  assert.deepEqual(parseEvent(issueEvent), { owner: 'goodandready', repo: 'dsh-kanban', issueNumber: 101 })

  // Pull Request event
  const prEvent = {
    repository: { name: 'dsh-kanban', owner: { login: 'goodandready' } },
    pull_request: { number: 202 },
  }
  assert.deepEqual(parseEvent(prEvent), { owner: 'goodandready', repo: 'dsh-kanban', issueNumber: 202 })

  // Push event (without issue)
  const pushEvent = {
    repository: { name: 'dsh-kanban', owner: { login: 'goodandready' } },
  }
  assert.deepEqual(parseEvent(pushEvent), { owner: 'goodandready', repo: 'dsh-kanban' })
})

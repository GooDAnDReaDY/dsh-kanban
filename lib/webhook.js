// Webhook ingestion for Gitea and GitHub.
// Webhooks trigger immediate sync alongside periodic polling.
// Pure module: parsing and signature verification without network or database.

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify delivery signature (supports Gitea X-Gitea-Signature and GitHub X-Hub-Signature-256).
 * Constant-time comparison to prevent timing attacks.
 *
 * @param {string} secret shared secret
 * @param {string|Buffer} body raw request body
 * @param {string} signature header value of X-Gitea-Signature or X-Hub-Signature-256
 */
export function verifySignature(secret, body, signature) {
  if (!secret) return false
  let provided = String(signature ?? '').trim().toLowerCase()
  if (provided.startsWith('sha256=')) {
    provided = provided.slice(7).trim()
  }
  if (!/^[0-9a-f]{64}$/.test(provided)) return false
  const expected = createHmac('sha256', secret).update(body ?? '').digest('hex')
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'))
}

/**
 * Detect webhook provider from incoming request headers.
 *
 * @param {object} headers HTTP request headers
 * @returns {'github'|'gitea'}
 */
export function detectWebhookProvider(headers) {
  if (!headers || typeof headers !== 'object') return 'gitea'
  if (headers['x-github-event'] || headers['x-hub-signature-256']) {
    return 'github'
  }
  return 'gitea'
}

/**
 * Identifies which task was affected by the event.
 *
 * Returns task coordinates rather than a transition verdict: deciding
 * where to move the card belongs to sync logic which holds the complete state.
 * Webhook merely notifies: 'an event occurred here, inspect now'.
 *
 * @returns {{owner: string, repo: string, issueNumber?: number}|undefined}
 */
export function parseEvent(payload) {
  const repository = payload?.repository
  const owner = repository?.owner?.login ?? repository?.owner?.username
  const repo = repository?.name
  if (typeof owner !== 'string' || owner === '' || typeof repo !== 'string' || repo === '') return undefined

  // Issue number format varies depending on event payload; PR is also an issue
  // with matching number.
  const number = payload?.issue?.number
    ?? payload?.pull_request?.number
    ?? (typeof payload?.number === 'number' ? payload.number : undefined)

  const out = { owner, repo }
  if (typeof number === 'number') out.issueNumber = number
  return out
}

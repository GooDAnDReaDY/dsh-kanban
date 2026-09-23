// Приём событий Gitea и GitHub.
//
// Вебхук даёт мгновенную сверку вместо ожидания следующего опроса. Опрос при
// этом остаётся: вебхук может быть не настроен, недоступен снаружи или просто
// потерян по дороге. Мгновенность — ускорение, а не замена надёжности.
//
// Модуль чистый: разбор и проверка подписи без сети и без хранилища.

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Проверить подпись доставки (поддерживает Gitea X-Gitea-Signature и GitHub X-Hub-Signature-256).
 *
 * Сравнение постоянного времени: обычное посимвольное сравнение по времени
 * ответа выдаёт, сколько первых байтов угадано, и подпись подбирается за
 * считанные попытки.
 *
 * @param {string} secret общий секрет
 * @param {string|Buffer} body сырое тело запроса
 * @param {string} signature значение заголовка X-Gitea-Signature или X-Hub-Signature-256
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
 * Определить провайдера вебхука по входящим заголовкам запроса.
 *
 * @param {object} headers заголовки HTTP-запроса
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
 * Что за задачу затронуло событие.
 *
 * Возвращается адрес задачи, а не готовое решение: решать, куда двинуть
 * карточку, — дело сверки, у которой перед глазами полная картина. Вебхук
 * только говорит «вот здесь что-то произошло, посмотри сейчас, а не потом».
 *
 * @returns {{owner: string, repo: string, issueNumber?: number}|undefined}
 */
export function parseEvent(payload) {
  const repository = payload?.repository
  const owner = repository?.owner?.login ?? repository?.owner?.username
  const repo = repository?.name
  if (typeof owner !== 'string' || owner === '' || typeof repo !== 'string' || repo === '') return undefined

  // Номер issue приходит по-разному в зависимости от события; PR при этом сам
  // является issue с тем же номером.
  const number = payload?.issue?.number
    ?? payload?.pull_request?.number
    ?? (typeof payload?.number === 'number' ? payload.number : undefined)

  const out = { owner, repo }
  if (typeof number === 'number') out.issueNumber = number
  return out
}

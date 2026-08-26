// Приём событий Gitea.
//
// Вебхук даёт мгновенную сверку вместо ожидания следующего опроса. Опрос при
// этом остаётся: вебхук может быть не настроен, недоступен снаружи или просто
// потерян по дороге. Мгновенность — ускорение, а не замена надёжности.
//
// Модуль чистый: разбор и проверка подписи без сети и без хранилища.

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Проверить подпись доставки.
 *
 * Сравнение постоянного времени: обычное посимвольное сравнение по времени
 * ответа выдаёт, сколько первых байтов угадано, и подпись подбирается за
 * считанные попытки.
 *
 * @param {string} secret общий секрет
 * @param {string|Buffer} body сырое тело запроса
 * @param {string} signature значение заголовка X-Gitea-Signature
 */
export function verifySignature(secret, body, signature) {
  if (!secret) return false
  const provided = String(signature ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(provided)) return false
  const expected = createHmac('sha256', secret).update(body ?? '').digest('hex')
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'))
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

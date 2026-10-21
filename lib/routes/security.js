import crypto from 'node:crypto'

export const MAX_BODY_BYTES = 256 * 1024

export function isLoopbackAddress(addr) {
  if (!addr || typeof addr !== 'string') return false
  const clean = addr.toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
  return (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === 'localhost' ||
    clean === 'localhost.' ||
    clean.startsWith('127.')
  )
}

export function isLanAddress(addr) {
  if (!addr || typeof addr !== 'string') return false
  const clean = addr.toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
  if (isLoopbackAddress(clean)) return true
  if (clean.startsWith('10.') || clean.startsWith('192.168.')) return true
  const m = clean.match(/^172\.(\d+)\./)
  if (m) {
    const octet = parseInt(m[1], 10)
    if (octet >= 16 && octet <= 31) return true
  }
  return false
}

export function isTrustedHost(host) {
  if (!host || typeof host !== 'string') return false
  let hostname = host.trim()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    if (end > 0) hostname = hostname.slice(1, end)
  } else {
    hostname = hostname.split(':')[0]
  }
  hostname = hostname.toLowerCase()
  if (!hostname) return false
  if (hostname === 'localhost' || hostname === 'localhost.' || hostname.endsWith('.local')) return true
  if (isLoopbackAddress(hostname) || isLanAddress(hostname)) return true
  return false
}

export function normalizeIp(addr) {
  if (!addr || typeof addr !== 'string') return ''
  return addr.toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
}

export function cookieNameForAuthority(authority) {
  if (!authority || typeof authority !== 'string') return ''
  const hash = crypto.createHash('sha256').update(authority.trim()).digest('base64url')
  return 'dsh-auth-' + hash
}

export function isLoopbackCookieName(name, host = '') {
  if (!name || typeof name !== 'string' || !name.startsWith('dsh-auth-')) return false
  const authorities = [
    host,
    '127.0.0.1:3000',
    '127.0.0.1:3080',
    '127.0.0.1:3082',
    '127.0.0.1',
    'localhost:3000',
    'localhost:3080',
    'localhost:3082',
    'localhost',
    '[::1]:3000',
    '[::1]',
  ]
  for (const auth of authorities) {
    if (auth && isLoopbackAddress(auth.split(':')[0])) {
      if (cookieNameForAuthority(auth) === name) return true
    }
  }
  return false
}

export function hasClientCredentials(req) {
  if (!req || !req.headers) return false
  if (req.headers.authorization) return true
  if (req.headers['x-dsh-lan-pin']) return true
  const cookie = req.headers.cookie
  if (!cookie || typeof cookie !== 'string') return false
  if (cookie.includes('dsh_token=') || cookie.includes('dsh_lan_pin=')) return true

  const parts = cookie.split(';')
  for (const part of parts) {
    const trimmed = part.trim()
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const name = trimmed.slice(0, eqIdx).trim()
    if (name.startsWith('dsh-auth-')) {
      if (!isLoopbackCookieName(name, req.headers.host)) {
        return true
      }
    }
  }
  return false
}

export function getClientIp(req) {
  const socketAddress =
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    req?.info?.remoteAddress ||
    ''
  const socketIp = normalizeIp(socketAddress)
  const xff = req?.headers?.['x-forwarded-for']
  if (xff && typeof xff === 'string' && (isLoopbackAddress(socketIp) || !socketIp)) {
    const first = xff.split(',')[0].trim()
    if (first) {
      return normalizeIp(first)
    }
  }
  return socketIp
}

/**
 * Cross-site request, DNS rebinding, and authentication validation (#261, #369, #384).
 *
 * Requirements:
 * 1. If DSH connection service is available (options.connection), requestRejection(req)
 *    is the authoritative gate for browser session authentication and trusted network access.
 *    If rejection is returned, the numeric status (e.g. 401 or 403) is returned.
 * 2. Host header is required and must target a trusted host (loopback, LAN, .local).
 * 3. Cross-site requests ('sec-fetch-site: cross-site' or origin mismatch) are rejected with 403.
 * 4. Origin & Referer headers (if present) must match Host or a trusted host.
 * 5. Network boundary validation:
 *    - Loopback callers (127.0.0.1, ::1) are allowed.
 *    - Non-loopback / LAN callers require valid connection authentication (fail-closed, return 401).
 *    - Unknown remote address (socket present but empty remoteAddress) fails closed with 403.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ connection?: { requestRejection?: (req: any) => number | undefined } }} [options]
 * @returns {number|undefined} Rejection HTTP status code (401, 403), or undefined if allowed.
 */
export function getRejectionStatus(req, options = {}) {
  const connection = options?.connection
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        if (typeof rejection === 'number' && Number.isInteger(rejection) && rejection >= 400 && rejection < 600) {
          return rejection
        }
        return rejection === 401 ? 401 : 403
      }
    } catch {
      // Fail closed if connection service throws
      return 403
    }
  }

  if (!req || !req.headers) return 403

  const host = req.headers.host
  if (!host || !isTrustedHost(host)) {
    return 403
  }

  const site = req.headers['sec-fetch-site']

  // 1. Explicit cross-site or same-site requests are rejected
  if (site === 'cross-site' || site === 'same-site') {
    return 403
  }

  // 2. Validate origin against trusted hosts and host header
  const origin = req.headers.origin
  if (origin !== undefined) {
    if (origin === 'null' || !origin) return 403
    try {
      const parsed = new URL(origin)
      if (!isTrustedHost(parsed.hostname)) return 403
      if (parsed.host && parsed.host !== host) return 403
    } catch {
      return 403
    }
  }

  // 3. Validate referer against trusted hosts and host header if present
  const referer = req.headers.referer
  if (referer !== undefined && referer) {
    try {
      const parsedRef = new URL(referer)
      if (!isTrustedHost(parsedRef.hostname)) return 403
      if (parsedRef.host && parsedRef.host !== host) return 403
    } catch {
      return 403
    }
  }

  // 4. Validate remote address and network boundary
  const hasSocket = !!(req.socket || req.connection)
  const remote = getClientIp(req)

  if (hasSocket) {
    if (!remote) {
      return 403
    }
    if (!isLoopbackAddress(remote) && !isLanAddress(remote)) {
      return 403
    }
    // Remote / LAN callers without connection authentication are rejected (#384)
    if (!isLoopbackAddress(remote)) {
      if (!connection) {
        return 401
      }
      // If request was forwarded through a reverse proxy (x-forwarded-for),
      // the proxy may have injected loopback credentials. Validate that the client
      // itself supplied authentic credentials (bearer token, PIN, or client session cookie).
      const xff = req.headers['x-forwarded-for']
      if (xff && !hasClientCredentials(req)) {
        return 401
      }
    }
  } else {
    // Synthetic mock request without socket
    const xff = req.headers['x-forwarded-for']
    if (xff) {
      const first = xff.split(',')[0].trim()
      if (first && !isLoopbackAddress(normalizeIp(first))) {
        if (!connection || !hasClientCredentials(req)) {
          return 401
        }
      }
    } else if (!connection) {
      const hostname = String(host).split(':')[0].toLowerCase()
      if (!isLoopbackAddress(hostname) && hostname !== 'localhost') {
        return 401
      }
    }
  }

  // 5. Browser request with declared site:
  // Must be same-origin or none
  if (site && site !== 'same-origin' && site !== 'none') {
    return 403
  }

  // 6. Request without declared site from non-loopback requires connection
  if (!site && remote && !isLoopbackAddress(remote) && !connection) {
    return 401
  }

  return undefined
}

export function isTrustedRequest(req, options = {}) {
  return getRejectionStatus(req, options) === undefined
}

export function rejectUntrustedRequest(req, res, options = {}) {
  const status = getRejectionStatus(req, options)
  if (status !== undefined) {
    try {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(
        JSON.stringify({
          error: status === 401 ? 'unauthorized' : 'cross-site',
        })
      )
    } catch {
      /* socket closed */
    }
    return true
  }
  return false
}

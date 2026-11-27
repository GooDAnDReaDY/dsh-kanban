/**
 * Remote DSH server relay client (#390).
 * Proxies board state, task actions, and sessions between local client and remote DSH server.
 * Zero Cyrillic literals in lib/ according to Issue #366 standard.
 */

/**
 * Check whether requests should be relayed to remote DSH server.
 *
 * @param {object} config
 * @returns {boolean}
 */
export function shouldRelay(config) {
  return Boolean(config && config.remoteMode && config.remoteServerUrl)
}

/**
 * Resolve target URL on remote DSH server.
 *
 * @param {object} config
 * @param {string} path
 * @returns {string}
 */
export function getRemoteServerUrl(config, path = '') {
  const base = String(config?.remoteServerUrl || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  const cleanPath = path ? (path.startsWith('/') ? path : '/' + path) : ''
  return `${base}${cleanPath}`
}

/**
 * Build request headers including DSH auth token and cookies.
 *
 * @param {object} config
 * @param {object} [originalHeaders]
 * @returns {Record<string, string>}
 */
export function buildRemoteHeaders(config, originalHeaders = {}, resolvedToken = '') {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
  }

  if (originalHeaders && typeof originalHeaders === 'object') {
    if (originalHeaders['content-type']) {
      headers['Content-Type'] = originalHeaders['content-type']
    }
  }

  const token = (resolvedToken || String(config?.resolvedRemoteServerToken || config?.remoteServerToken || '')).trim()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
    headers['Cookie'] = `dsh_token=${token}`
  }

  return headers
}

/**
 * Relay an HTTP request to remote DSH server.
 *
 * @param {{
 *   config: object,
 *   path: string,
 *   method?: string,
 *   body?: any,
 *   headers?: object,
 *   timeoutMs?: number
 * }} options
 * @returns {Promise<{ status: number, body: any, headers?: object }>}
 */
export async function relayRequest({ config, path, urlPath, method = 'GET', body, headers, timeoutMs = 15000, resolveToken }) {
  const targetPath = urlPath || path || ''
  const url = getRemoteServerUrl(config, targetPath)
  if (!url) {
    return {
      status: 400,
      body: { error: 'not-configured', detail: 'remoteServerUrl is not configured' },
    }
  }
  let resolvedToken = ''
  const tokenRef = String(config?.remoteServerToken || '').trim()
  if (typeof resolveToken === 'function' && tokenRef) {
    try {
      resolvedToken = (await resolveToken(tokenRef)) || tokenRef
    } catch {
      resolvedToken = tokenRef
    }
  } else {
    resolvedToken = tokenRef
  }
  const reqHeaders = buildRemoteHeaders(config, headers, resolvedToken)

  const fetchOptions = {
    method,
    headers: reqHeaders,
    signal: AbortSignal.timeout(timeoutMs),
  }

  if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
    if (typeof body === 'string') {
      fetchOptions.body = body
      if (!fetchOptions.headers['Content-Type']) {
        fetchOptions.headers['Content-Type'] = 'application/json'
      }
    } else {
      fetchOptions.body = JSON.stringify(body)
      fetchOptions.headers['Content-Type'] = 'application/json'
    }
  }

  try {
    const res = await fetch(url, fetchOptions)
    const contentType = res.headers.get('content-type') || ''
    let parsedBody
    if (contentType.includes('application/json')) {
      parsedBody = await res.json()
    } else {
      parsedBody = await res.text()
    }

    return {
      status: res.status,
      body: parsedBody,
    }
  } catch (err) {
    return {
      status: 503,
      body: {
        error: 'remote-server-unavailable',
        detail: `Failed to reach remote DSH server at ${url}: ${err.message}`,
      },
    }
  }
}

/**
 * Probe remote DSH server connection and kanban board endpoint.
 *
 * @param {object} config
 * @returns {Promise<{ ok: boolean, latencyMs?: number, status?: number, error?: string }>}
 */
export async function testRemoteServer(config, { resolveToken } = {}) {
  const startTime = Date.now()
  const res = await relayRequest({
    config,
    urlPath: '/dsh-kanban/board',
    method: 'GET',
    timeoutMs: 8000,
    resolveToken,
  })

  const latencyMs = Date.now() - startTime

  if (res.status === 200) {
    return {
      ok: true,
      latencyMs,
      status: res.status,
    }
  }

  return {
    ok: false,
    latencyMs,
    status: res.status,
    error: res.body?.detail || res.body?.error || `HTTP ${res.status}`,
  }
}

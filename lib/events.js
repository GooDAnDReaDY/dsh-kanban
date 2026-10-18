// Broadcaster for Server-Sent Events (SSE) (#222).

export class KanbanEventHub {
  constructor(options = {}) {
    this.clients = new Set()
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 15000
    this.heartbeatTimer = null
    this._startHeartbeat()
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      this._pingAll()
    }, this.heartbeatIntervalMs)
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref()
    }
  }

  _pingAll() {
    for (const client of this.clients) {
      try {
        client.write(':keepalive\n\n')
      } catch {
        this.clients.delete(client)
      }
    }
  }

  handleSseRequest(req, res, { isTrustedRequest } = {}) {
    if (typeof isTrustedRequest === 'function' && !isTrustedRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('forbidden')
      return () => {}
    }

    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
    const origin = req?.headers?.origin
    if (origin && origin !== 'null') {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Vary'] = 'Origin'
    }

    res.writeHead(200, headers)

    res.write(':connected\n\n')
    this.clients.add(res)

    const cleanup = () => {
      this.clients.delete(res)
      try { res.end() } catch { /* client already disconnected */ }
    }

    if (typeof req.on === 'function') req.on('close', cleanup)
    if (typeof req.on === 'function') req.on('error', cleanup)
    if (typeof res.on === 'function') res.on('error', cleanup)

    return cleanup
  }

  broadcast(eventType, payload = {}) {
    const data = JSON.stringify(payload)
    const message = `event: ${eventType}\ndata: ${data}\n\n`
    let sentCount = 0

    for (const client of this.clients) {
      try {
        client.write(message)
        sentCount++
      } catch {
        this.clients.delete(client)
      }
    }

    return sentCount
  }

  getClientCount() {
    return this.clients.size
  }

  closeAll() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const client of this.clients) {
      try {
        client.write('event: close\ndata: {}\n\n')
        client.end()
      } catch { /* client already closed */ }
    }
    this.clients.clear()
  }
}

export const eventHub = new KanbanEventHub()

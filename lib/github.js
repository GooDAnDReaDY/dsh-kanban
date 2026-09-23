// Клиент GitHub REST API v3.
//
// Выполняет те же операции, что и GiteaClient: чтение issues, pull requests,
// веток, репозиториев, создание PR и комментирование.
// Дополнительно поддерживает условные запросы с ETag (If-None-Match) для защиты
// от исчерпания часового лимита запросов GitHub (5 000 req/hr).
//
// Модуль изолирован от файловой системы и DSH: токен и конфигурация
// передаются фабрикой createGitHubClient.

const DEFAULT_BASE_URL = 'https://api.github.com'

export function normalizeGithubUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return DEFAULT_BASE_URL
  const match = s.match(/^https?:\/\/[^\s/]+/i)
  return match ? match[0].replace(/\/+$/, '') : DEFAULT_BASE_URL
}

export function safeSegment(value) {
  const s = String(value ?? '').trim()
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..') || s.includes('\0')) {
    return undefined
  }
  return s
}

export function isCredentialName(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 0 && !/[\s/]/.test(trimmed)
}

/**
 * Создать клиент GitHub API.
 *
 * @param {object} options
 * @param {() => object} options.getConfig функция получения конфигурации
 * @param {(name: string) => Promise<string>} options.resolveToken получение токена
 * @param {typeof fetch} [options.fetchImpl] реализация fetch
 * @param {number} [options.timeoutMs] таймаут запроса в мс
 */
export function createGitHubClient({ getConfig, resolveToken, fetchImpl = fetch, timeoutMs = 30_000 }) {
  // Кэш условных запросов ETag: url -> { etag, data }
  const etagCache = new Map()

  async function request(method, path, body, { useEtag = false } = {}) {
    const config = getConfig()
    const baseUrl = normalizeGithubUrl(config?.githubUrl)
    const tokenRef = config?.githubTokenRef || 'GITHUB_TOKEN'

    const token = await resolveToken(tokenRef)
    if (!token) {
      throw Object.assign(new Error('GitHub credential token is not configured'), { code: 'unconfigured' })
    }

    const url = `${baseUrl}${path}`
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-kanban',
    }

    let cacheEntry
    if (useEtag && method === 'GET') {
      cacheEntry = etagCache.get(url)
      if (cacheEntry?.etag) {
        headers['If-None-Match'] = cacheEntry.etag
      }
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })

      if (res.status === 304 && cacheEntry) {
        return cacheEntry.data
      }

      const text = await res.text()
      let payload
      try { payload = text.trim() === '' ? null : JSON.parse(text) } catch { payload = null }

      if (!res.ok) {
        throw Object.assign(new Error(`GitHub HTTP error ${res.status}`), {
          code: 'http',
          status: res.status,
          detail: payload?.message,
        })
      }

      if (useEtag && method === 'GET') {
        const etag = res.headers?.get?.('etag') || res.headers?.etag
        if (etag) {
          etagCache.set(url, { etag, data: payload })
        }
      }

      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  function repoPath(owner, repo, suffix = '') {
    const o = safeSegment(owner)
    const r = safeSegment(repo)
    if (o === undefined || r === undefined) {
      throw Object.assign(new Error('Invalid owner or repository segment'), { code: 'bad-segment' })
    }
    return `/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}${suffix}`
  }

  async function collectPages({ buildPath, limit = 50, maxPages = 10, useEtag = false }) {
    const size = Math.min(Math.max(Number(limit) || 50, 1), 100)
    const out = []
    for (let page = 1; page <= maxPages; page += 1) {
      const rows = await request('GET', buildPath(page, size), undefined, { useEtag: useEtag && page === 1 })
      if (!Array.isArray(rows)) break
      out.push(...rows)
      if (rows.length < size) break
    }
    return out
  }

  let configuredCache
  const configuredKey = () => {
    const config = getConfig()
    return `${normalizeGithubUrl(config?.githubUrl)}\u0000${String(config?.githubTokenRef ?? 'GITHUB_TOKEN')}`
  }

  return {
    provider: 'github',

    /** Проверен ли токен доступа. */
    async isConfigured() {
      const key = configuredKey()
      if (configuredCache?.key === key) return configuredCache.value
      const config = getConfig()
      const tokenRef = config?.githubTokenRef || 'GITHUB_TOKEN'
      const value = isCredentialName(tokenRef)
        && await resolveToken(tokenRef).then(Boolean).catch(() => false)
      configuredCache = { key, value }
      return value
    },

    /** Очистить кэш ETag (например, при явном ручном обновлении). */
    clearCache() {
      etagCache.clear()
    },

    /** Список issues репозитория (без PR). */
    async listIssues({ owner, repo, state = 'open', limit = 50 }) {
      const rows = await collectPages({
        limit,
        useEtag: true,
        buildPath: (page, size) => repoPath(owner, repo,
          `/issues?state=${encodeURIComponent(state)}&page=${page}&per_page=${size}&sort=updated&direction=desc`),
      })
      return rows.filter((r) => !r.pull_request)
    },

    /** Получить один issue по номеру. */
    async getIssue({ owner, repo, index }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('invalid issue number'), { code: 'bad-segment' })
      return request('GET', repoPath(owner, repo, `/issues/${n}`))
    },

    /** Оставить комментарий в issue. */
    async comment({ owner, repo, index, body }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('invalid issue number'), { code: 'bad-segment' })
      return request('POST', repoPath(owner, repo, `/issues/${n}/comments`), { body })
    },

    /** Создать новый issue. */
    async createIssue({ owner, repo, title, body }) {
      const name = String(title ?? '').trim()
      if (name === '') throw Object.assign(new Error('empty issue title'), { code: 'bad-title' })
      return request('POST', repoPath(owner, repo, '/issues'), { title: name, body: String(body ?? '') })
    },

    /** Закрыть issue. */
    async closeIssue({ owner, repo, index }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('invalid issue number'), { code: 'bad-segment' })
      return request('PATCH', repoPath(owner, repo, `/issues/${n}`), { state: 'closed' })
    },

    /**
     * Назначить ответственных за issue.
     * В GitHub REST API PATCH /issues/{n} со свойством assignees заменяет ответственных целиком.
     */
    async setAssignees({ owner, repo, index, logins }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('invalid issue number'), { code: 'bad-segment' })
      const list = (Array.isArray(logins) ? logins : [])
        .filter((one) => typeof one === 'string' && one !== '')
      return request('PATCH', repoPath(owner, repo, `/issues/${n}`), { assignees: list })
    },

    /** Логин текущего пользователя токена. */
    async me() {
      const row = await request('GET', '/user')
      const login = row?.login
      return typeof login === 'string' ? login : ''
    },

    /** Организации, доступные токену. */
    async listOrgs() {
      const rows = await request('GET', '/user/orgs?per_page=50')
      return (Array.isArray(rows) ? rows : [])
        .map((o) => String(o?.login ?? o?.name ?? ''))
        .filter((name) => name !== '')
    },

    /** Репозитории организации с числом открытых задач. */
    async listOrgRepos({ owner, limit = 100 }) {
      const rows = await collectPages({
        limit,
        useEtag: true,
        buildPath: (page, size) => `/orgs/${encodeURIComponent(safeSegment(owner))}/repos?page=${page}&per_page=${size}`,
      })
      return rows.map((r) => ({
        name: String(r?.name ?? ''),
        openIssues: Number(r?.open_issues_count ?? 0),
        archived: r?.archived === true,
      })).filter((r) => r.name !== '')
    },

    /** Pull requests репозитория. */
    async listPulls({ owner, repo, state = 'all', limit = 50 }) {
      return collectPages({
        limit,
        useEtag: true,
        buildPath: (page, size) => repoPath(owner, repo,
          `/pulls?state=${encodeURIComponent(state)}&page=${page}&per_page=${size}&sort=updated&direction=desc`),
      })
    },

    /** Создать Pull Request. */
    async createPullRequest({ owner, repo, title, body, head, base = 'main' }) {
      const name = String(title ?? '').trim()
      if (name === '') throw Object.assign(new Error('empty PR title'), { code: 'bad-title' })
      const h = String(head ?? '').trim()
      const b = String(base ?? 'main').trim()
      if (!h) throw Object.assign(new Error('head branch is required'), { code: 'bad-head' })
      return request('POST', repoPath(owner, repo, '/pulls'), {
        title: name,
        body: String(body ?? ''),
        head: h,
        base: b,
      })
    },

    /** Список веток репозитория. */
    async listBranches({ owner, repo, limit = 100 }) {
      const rows = await collectPages({
        limit,
        buildPath: (page, size) => repoPath(owner, repo, `/branches?page=${page}&per_page=${size}`),
      })
      return rows.map((b) => ({ name: String(b?.name ?? '') })).filter((b) => b.name !== '')
    },

    /** Поиск репозиториев. */
    async searchRepos({ query, limit = 50, maxPages = 5 }) {
      const q = encodeURIComponent(String(query || ''))
      const size = Math.min(Math.max(Number(limit) || 50, 1), 50)
      const out = []
      for (let page = 1; page <= maxPages; page += 1) {
        const rows = await request('GET', `/search/repositories?q=${q}&per_page=${size}&page=${page}`)
        const data = Array.isArray(rows?.items) ? rows.items : []
        for (const r of data) {
          out.push({
            name: String(r?.name ?? ''),
            fullName: String(r?.full_name ?? ''),
            description: String(r?.description ?? ''),
            openIssues: Number(r?.open_issues_count ?? 0),
            updatedAt: r?.updated_at ? new Date(r.updated_at).getTime() : 0,
            stars: Number(r?.stargazers_count ?? 0),
            provider: 'github',
          })
        }
        if (data.length < size) break
      }
      return out
    },
  }
}

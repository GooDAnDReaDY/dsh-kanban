// Gitea HTTP API client.
//
// Standalone module without external dependencies, communicating directly with Gitea v1 API.
// Network calls use injectable fetch (`fetchImpl`), and token resolution is provided via callback.
// The client can be unit tested without making real network requests.
//
// Secrets are not stored in settings; only the credential name is stored.
// Token values are never emitted to logs or error messages.

/** Strip trailing slashes from base URL. */
export function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

/**
 * Path segment sanitized for URL interpolation.
 *
 * `owner`, `repo`, and issue index originate from external data or user input.
 * Sanitization prevents directory traversal or path manipulation.
 *
 * @returns {string|undefined} encoded segment or undefined if invalid
 */
export function safeSegment(value) {
  const s = String(value ?? '').trim()
  if (s === '' || s === '.' || s === '..') return undefined
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return undefined
  return encodeURIComponent(s)
}

/** Credential reference name (e.g. env var name), distinct from the raw secret. */
export function isCredentialName(value) {
  const str = String(value || '')
  if (looksLikeSecret(str)) return false
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(str)
}

/** Check if value looks like a raw token secret rather than a credential reference name. */
export function looksLikeSecret(value) {
  const str = String(value || '').trim()
  if (str === '') return false
  if (/^(ghp_|gho_|github_pat_|glpat-|bearer\s+|token\s+)/i.test(str)) return true
  if (/^[0-9a-f]{40}$/i.test(str)) return true
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(str)) return true
  // Raw alphanumeric token >= 32 characters without underscores
  if (/^[A-Za-z0-9]{32,}$/.test(str)) return true
  return false
}

/**
 * Rank repositories by activity.
 *
 * Places active repositories with open tasks and recent updates at the top.
 * Archived repositories are sorted to the bottom.
 */
export function rankRepos(repos) {
  const rank = (r) => {
    if (r.archived) return 3
    if ((r.openIssues ?? 0) > 0) return 0
    return 1
  }
  return [...(repos ?? [])].sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    const byTime = String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    if (byTime !== 0) return byTime
    return String(a.fullName || '').localeCompare(String(b.fullName || ''))
  })
}

/**
 * Gitea client factory.
 *
 * @param {object} options
 * @param {() => object} options.getConfig current plugin configuration
 * @param {(name: string) => Promise<string>} options.resolveToken credential resolver callback
 * @param {Function} [options.fetchImpl] fetch implementation
 * @param {number} [options.timeoutMs]
 */
export function createGiteaClient({ getConfig, resolveToken, fetchImpl = fetch, timeoutMs = 30_000 }) {
  async function request(method, path, body) {
    const config = getConfig()
    const baseUrl = normalizeBaseUrl(config?.giteaUrl)
    if (baseUrl === '') throw Object.assign(new Error('Gitea URL is not configured'), { code: 'unconfigured' })

    const token = await resolveToken(config?.giteaTokenRef)
    if (!token) throw Object.assign(new Error('Gitea credential token is not configured'), { code: 'unconfigured' })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${baseUrl}/api/v1${path}`, {
        method,
        headers: {
          // Use header authorization rather than basic auth to avoid 'Missing API key' on private instances.
          'Authorization': `token ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      let payload
      try { payload = text.trim() === '' ? null : JSON.parse(text) } catch { payload = null }
      if (!res.ok) {
        // Do not leak raw response body in error messages to prevent echoing sensitive headers.
        throw Object.assign(new Error(`Gitea HTTP error ${res.status}`), { code: 'http', status: res.status })
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
    return `/repos/${o}/${r}${suffix}`
  }

  /**
   * Paginate and collect all items from Gitea endpoints up to maxPages.
   *
   * @param {object} options
   * @param {(page: number, size: number) => string} options.buildPath page path builder
   * @param {number} [options.limit] page size
   * @param {number} [options.maxPages] maximum pages to retrieve
   * @returns {Promise<Array>} concatenated results from all pages
   */
  async function collectPages({ buildPath, limit, maxPages = 10 }) {
    const size = Math.min(Math.max(Number(limit) || 50, 1), 50)
    const out = []
    for (let page = 1; page <= maxPages; page += 1) {
      const rows = await request('GET', buildPath(page, size))
      if (!Array.isArray(rows)) break
      out.push(...rows)
      if (rows.length < size) break
    }
    return out
  }

  // Cache configuration check result keyed on URL and token reference to avoid
  // repeated credential lookups on hot paths.
  let configuredCache
  const configuredKey = () => {
    const config = getConfig()
    return `${normalizeBaseUrl(config?.giteaUrl)}\u0000${String(config?.giteaTokenRef ?? '')}`
  }

  return {
    /** Check whether access is configured. Token value is never exposed. */
    async isConfigured() {
      const key = configuredKey()
      if (configuredCache?.key === key) return configuredCache.value
      const config = getConfig()
      const value = normalizeBaseUrl(config?.giteaUrl) !== ''
        && isCredentialName(config?.giteaTokenRef)
        && await resolveToken(config.giteaTokenRef).then(Boolean).catch(() => false)
      configuredCache = { key, value }
      return value
    },

    async listIssues({ owner, repo, state = 'open', limit = 50 }) {
      // API returns issues and PRs together; filter out pull requests and paginate completely.
      const rows = await collectPages({
        limit,
        buildPath: (page, size) => repoPath(owner, repo,
          `/issues?state=${encodeURIComponent(state)}&page=${page}&limit=${size}`),
      })
      return rows.filter((i) => i.pull_request === undefined)
    },

    async getIssue({ owner, repo, index }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('invalid issue number'), { code: 'bad-segment' })
      return request('GET', repoPath(owner, repo, `/issues/${n}`))
    },

    async comment({ owner, repo, index, body }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('invalid issue number'), { code: 'bad-segment' })
      return request('POST', repoPath(owner, repo, `/issues/${n}/comments`), { body })
    },

    /** Create issue. Labels are omitted here to respect repository conventions. */
    async createIssue({ owner, repo, title, body }) {
      const name = String(title ?? '').trim()
      if (name === '') throw Object.assign(new Error('empty title'), { code: 'bad-title' })
      return request('POST', repoPath(owner, repo, '/issues'), { title: name, body: String(body ?? '') })
    },

    /** Create private, empty repository in organization. */
    async createRepo({ owner, name, description = '' }) {
      const safe = safeSegment(name)
      if (safe === undefined) throw Object.assign(new Error('invalid name'), { code: 'bad-segment' })
      return request('POST', `/orgs/${safeSegment(owner)}/repos`, {
        name: safe, description, private: true, auto_init: false,
      })
    },

    async closeIssue({ owner, repo, index }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('invalid issue number'), { code: 'bad-segment' })
      return request('PATCH', repoPath(owner, repo, `/issues/${n}`), { state: 'closed' })
    },

    /** Set issue assignees. Empty array clears assignees. */
    async setAssignees({ owner, repo, index, logins }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('invalid issue number'), { code: 'bad-segment' })
      const list = (Array.isArray(logins) ? logins : [])
        .filter((one) => typeof one === 'string' && one !== '')
      return request('PATCH', repoPath(owner, repo, `/issues/${n}`), { assignees: list })
    },

    /** Authenticated user identity for the token. */
    async me() {
      const row = await request('GET', '/user')
      const login = row?.login
      return typeof login === 'string' ? login : ''
    },

    /** List organizations accessible to the token. */
    async listOrgs() {
      const rows = await request('GET', '/user/orgs?limit=50')
      return (Array.isArray(rows) ? rows : [])
        .map((o) => String(o?.username ?? o?.name ?? ''))
        .filter((name) => name !== '')
    },

    /** List organization repositories with open issue counts, paginating to handle large orgs. */
    async listOrgRepos({ owner, limit = 100 }) {
      const rows = await collectPages({
        limit,
        buildPath: (page, size) => `/orgs/${safeSegment(owner)}/repos?page=${page}&limit=${size}`,
      })
      return rows.map((r) => ({
        name: String(r?.name ?? ''),
        openIssues: Number(r?.open_issues_count ?? 0),
        archived: r?.archived === true,
      })).filter((r) => r.name !== '')
    },

    /** List pull requests for repository. */
    async listPulls({ owner, repo, state = 'all', limit = 50 }) {
      return collectPages({
        limit,
        buildPath: (page, size) => repoPath(owner, repo,
          `/pulls?state=${encodeURIComponent(state)}&page=${page}&limit=${size}&sort=recentupdate`),
      })
    },

    /** Create pull request in repository. */
    async createPullRequest({ owner, repo, title, body, head, base = 'main' }) {
      const name = String(title ?? '').trim()
      if (name === '') throw Object.assign(new Error('empty title'), { code: 'bad-title' })
      const h = String(head ?? '').trim()
      const b = String(base ?? 'main').trim()
      if (!h) throw Object.assign(new Error('head branch required'), { code: 'bad-head' })
      return request('POST', repoPath(owner, repo, '/pulls'), {
        title: name,
        body: String(body ?? ''),
        head: h,
        base: b,
      })
    },

    /** List repository branches with pagination to avoid false negatives when detecting active branches. */
    async listBranches({ owner, repo, limit = 100 }) {
      const rows = await collectPages({
        limit,
        buildPath: (page, size) => repoPath(owner, repo, `/branches?page=${page}&limit=${size}`),
      })
      return rows.map((b) => ({ name: b?.name ?? '' })).filter((b) => b.name !== '')
    },

    /** Search repositories across instance with pagination up to maxPages. */
    async searchRepos({ query, limit = 50, maxPages = 10 }) {
      const q = encodeURIComponent(String(query || ''))
      const size = Math.min(Math.max(Number(limit) || 50, 1), 50)
      const out = []
      for (let page = 1; page <= maxPages; page += 1) {
        const rows = await request('GET', `/repos/search?q=${q}&limit=${size}&page=${page}`)
        const data = Array.isArray(rows?.data) ? rows.data : []
        for (const r of data) {
          out.push({
            owner: r.owner?.login ?? '',
            repo: r.name ?? '',
            fullName: r.full_name ?? '',
            openIssues: typeof r.open_issues_count === 'number' ? r.open_issues_count : 0,
            updatedAt: typeof r.updated_at === 'string' ? r.updated_at : '',
            archived: r.archived === true,
          })
        }
        if (data.length < size) break
      }
      return rankRepos(out)
    },
  }
}

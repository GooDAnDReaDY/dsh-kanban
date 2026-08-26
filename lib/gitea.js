// Клиент Gitea для доски.
//
// Своего клиента канбан держит намеренно: токен всё равно живёт в службе
// учётных данных ядра, а не в соседнем плагине, и шесть вызовов REST дешевле,
// чем зависимость от чужого выпуска.
//
// Сеть приходит параметром (`fetchImpl`), токен — функцией разрешения.
// Поэтому клиент проверяется без единого реального запроса.
//
// Токен в настройках не хранится: там только ИМЯ учётной записи. Наружу
// значение не отдаётся никогда, включая сообщения об ошибках.

/** Убрать хвостовые слэши: адрес приходит из поля, куда человек пишет как хочет. */
export function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

/**
 * Сегмент пути, пригодный для подстановки в URL.
 *
 * `owner`, `repo` и номер приходят из данных Gitea и из браузера, а не из
 * кода. Без проверки сюда подставится `..` или слэш, и запрос уйдёт не туда,
 * куда собирались.
 *
 * @returns {string|undefined} закодированный сегмент либо undefined
 */
export function safeSegment(value) {
  const s = String(value ?? '').trim()
  if (s === '' || s === '.' || s === '..') return undefined
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return undefined
  return encodeURIComponent(s)
}

/** Имя учётной записи — имя переменной окружения, а не сам секрет. */
export function isCredentialName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || ''))
}

/** Похоже на сам токен, а не на его имя. */
export function looksLikeSecret(value) {
  return /^[A-Za-z0-9_-]{32,}$/.test(String(value || '').trim())
}

/**
 * Упорядочить репозитории по актуальности.
 *
 * Сверху те, где работа идёт прямо сейчас. Признак «идёт» выбран самый честный
 * из доступных без лишних запросов: есть открытые задачи И репозиторий недавно
 * трогали. Архивные уходят вниз всегда — там работы не ведут по определению.
 *
 * Точного «ведётся прямо сейчас» инстанс не знает, и выдумывать его не из чего;
 * это приближение, а не истина.
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
 * Клиент Gitea.
 *
 * @param {object} options
 * @param {() => object} options.getConfig текущие настройки плагина
 * @param {(name: string) => Promise<string>} options.resolveToken разрешение учётной записи
 * @param {Function} [options.fetchImpl] реализация fetch
 * @param {number} [options.timeoutMs]
 */
export function createGiteaClient({ getConfig, resolveToken, fetchImpl = fetch, timeoutMs = 30_000 }) {
  async function request(method, path, body) {
    const config = getConfig()
    const baseUrl = normalizeBaseUrl(config?.giteaUrl)
    if (baseUrl === '') throw Object.assign(new Error('адрес Gitea не задан'), { code: 'unconfigured' })

    const token = await resolveToken(config?.giteaTokenRef)
    if (!token) throw Object.assign(new Error('учётная запись с токеном не настроена'), { code: 'unconfigured' })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${baseUrl}/api/v1${path}`, {
        method,
        headers: {
          // Заголовком, а не basic-авторизацией: на внутренних сетях basic
          // отдаёт «Missing API key».
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
        // Тело ответа наружу не выносим: в нём может быть эхо заголовков.
        throw Object.assign(new Error(`Gitea ответил ${res.status}`), { code: 'http', status: res.status })
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
      throw Object.assign(new Error('недопустимый владелец или репозиторий'), { code: 'bad-segment' })
    }
    return `/repos/${o}/${r}${suffix}`
  }

  return {
    /** Настроен ли доступ. Значение токена наружу не отдаётся. */
    async isConfigured() {
      const config = getConfig()
      if (normalizeBaseUrl(config?.giteaUrl) === '') return false
      if (!isCredentialName(config?.giteaTokenRef)) return false
      try {
        return Boolean(await resolveToken(config.giteaTokenRef))
      } catch {
        return false
      }
    },

    async listIssues({ owner, repo, state = 'open', page = 1, limit = 50 }) {
      const query = `?state=${encodeURIComponent(state)}&page=${Number(page) || 1}` +
        `&limit=${Number(limit) || 50}&sort=updated&direction=desc`
      const rows = await request('GET', repoPath(owner, repo, `/issues${query}`))
      // API отдаёт issue и pull request одним списком; доске нужны только issue.
      return (Array.isArray(rows) ? rows : []).filter((r) => !r.pull_request)
    },

    async getIssue({ owner, repo, index }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('недопустимый номер issue'), { code: 'bad-segment' })
      return request('GET', repoPath(owner, repo, `/issues/${n}`))
    },

    async comment({ owner, repo, index, body }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('недопустимый номер issue'), { code: 'bad-segment' })
      return request('POST', repoPath(owner, repo, `/issues/${n}/comments`), { body })
    },

    async setLabels({ owner, repo, index, labels }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('недопустимый номер issue'), { code: 'bad-segment' })
      return request('PUT', repoPath(owner, repo, `/issues/${n}/labels`), { labels })
    },

    async closeIssue({ owner, repo, index }) {
      const n = safeSegment(index)
      if (n === undefined) throw Object.assign(new Error('недопустимый номер issue'), { code: 'bad-segment' })
      return request('PATCH', repoPath(owner, repo, `/issues/${n}`), { state: 'closed' })
    },

    /** Pull request-ы репозитория. */
    async listPulls({ owner, repo, state = 'all', limit = 50 }) {
      const query = `?state=${encodeURIComponent(state)}&limit=${Number(limit) || 50}&sort=recentupdate`
      const rows = await request('GET', repoPath(owner, repo, `/pulls${query}`))
      return Array.isArray(rows) ? rows : []
    },

    /** Ветки репозитория: по ним видно, начата ли работа и сделан ли cleanup. */
    async listBranches({ owner, repo, limit = 100 }) {
      const rows = await request('GET', repoPath(owner, repo, `/branches?limit=${Number(limit) || 100}`))
      return (Array.isArray(rows) ? rows : []).map((b) => ({ name: b?.name ?? '' })).filter((b) => b.name !== '')
    },

    /**
     * Репозитории инстанса, все страницы.
     *
     * Одной страницы не хватает: Gitea отдаёт их порциями, и запрос без
     * перелистывания молча теряет хвост. Верхний предел стоит, чтобы очень
     * большой инстанс не превратил открытие диалога в долгую загрузку.
     *
     * Число открытых задач и время правки приходят в том же ответе — считать
     * их отдельными запросами не нужно.
     */
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

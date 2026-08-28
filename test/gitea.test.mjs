import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createGiteaClient, normalizeBaseUrl, safeSegment, isCredentialName, looksLikeSecret, rankRepos,
} from '../lib/gitea.js'

/** Клиент с подменённой сетью: ни одного реального запроса в тестах. */
function stubClient(respond, config = {}) {
  const calls = []
  const gitea = createGiteaClient({
    getConfig: () => ({ giteaUrl: 'https://example.invalid', giteaTokenRef: 'GITEA_TOKEN', ...config }),
    resolveToken: async () => 'секрет',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return respond(url, options)
    },
  })
  return { gitea, calls }
}

const okJson = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
})

test('адрес нормализуется без хвостовых слэшей', () => {
  assert.equal(normalizeBaseUrl('https://example.invalid///'), 'https://example.invalid')
  assert.equal(normalizeBaseUrl('  https://example.invalid  '), 'https://example.invalid')
  assert.equal(normalizeBaseUrl(''), '')
  assert.equal(normalizeBaseUrl(undefined), '')
})

test('сегмент пути отвергает выход за пределы и слэши', () => {
  // owner и repo приходят из данных Gitea и из браузера, а не из кода.
  assert.equal(safeSegment('..'), undefined)
  assert.equal(safeSegment('.'), undefined)
  assert.equal(safeSegment('a/b'), undefined)
  assert.equal(safeSegment('a\\b'), undefined)
  assert.equal(safeSegment(''), undefined)
  assert.equal(safeSegment('dsh-kanban'), 'dsh-kanban')
  assert.equal(safeSegment(12), '12')
})

test('имя учётной записи отличается от самого секрета', () => {
  assert.equal(isCredentialName('GITEA_TOKEN'), true)
  assert.equal(isCredentialName('9f3a'), false)
  assert.equal(looksLikeSecret('0123456789abcdef0123456789abcdef0123'), true)
  assert.equal(looksLikeSecret('GITEA_TOKEN'), false)
})

test('токен уходит заголовком, а не в адресе', async () => {
  const { gitea, calls } = stubClient(() => okJson([]))
  await gitea.listIssues({ owner: 'o', repo: 'r' })
  assert.equal(calls[0].options.headers.Authorization, 'token секрет')
  assert.ok(!calls[0].url.includes('секрет'), 'секрет попал в адрес запроса')
})

test('список issue отбрасывает pull request', async () => {
  // API отдаёт issue и PR одним списком; доске нужны только issue.
  const { gitea } = stubClient(() => okJson([
    { number: 1, title: 'issue' },
    { number: 2, title: 'pr', pull_request: { merged: false } },
  ]))
  const rows = await gitea.listIssues({ owner: 'o', repo: 'r' })
  assert.deepEqual(rows.map((r) => r.number), [1])
})

test('issue по номеру запрашивается по правильному пути', async () => {
  const { gitea, calls } = stubClient(() => okJson({ number: 12, title: 'A' }))
  const issue = await gitea.getIssue({ owner: 'o', repo: 'r', index: 12 })
  assert.equal(issue.number, 12)
  assert.ok(calls[0].url.endsWith('/api/v1/repos/o/r/issues/12'))
})

test('подделанный репозиторий отвергается до запроса', async () => {
  const { gitea, calls } = stubClient(() => okJson({}))
  await assert.rejects(() => gitea.getIssue({ owner: 'o', repo: '../../etc', index: 1 }))
  assert.equal(calls.length, 0, 'запрос всё-таки ушёл')
})

test('без адреса инстанса запрос не уходит', async () => {
  const { gitea, calls } = stubClient(() => okJson({}), { giteaUrl: '' })
  await assert.rejects(() => gitea.listIssues({ owner: 'o', repo: 'r' }), /адрес/)
  assert.equal(calls.length, 0)
})

test('без токена запрос не уходит', async () => {
  const calls = []
  const gitea = createGiteaClient({
    getConfig: () => ({ giteaUrl: 'https://example.invalid', giteaTokenRef: 'GITEA_TOKEN' }),
    resolveToken: async () => '',
    fetchImpl: async (u, o) => { calls.push({ u, o }); return okJson({}) },
  })
  await assert.rejects(() => gitea.listIssues({ owner: 'o', repo: 'r' }))
  assert.equal(calls.length, 0)
})

test('ошибка сервера не выносит наружу тело ответа', async () => {
  const { gitea } = stubClient(() => ({
    ok: false, status: 401,
    text: async () => JSON.stringify({ message: 'token abcdef0123456789 rejected' }),
  }))
  await assert.rejects(
    () => gitea.listIssues({ owner: 'o', repo: 'r' }),
    (e) => e.status === 401 && !/abcdef/.test(e.message),
  )
})

test('готовность требует и адреса, и токена', async () => {
  const ready = createGiteaClient({
    getConfig: () => ({ giteaUrl: 'https://example.invalid', giteaTokenRef: 'GITEA_TOKEN' }),
    resolveToken: async () => 'секрет',
    fetchImpl: async () => okJson({}),
  })
  assert.equal(await ready.isConfigured(), true)

  const noUrl = createGiteaClient({
    getConfig: () => ({ giteaUrl: '', giteaTokenRef: 'GITEA_TOKEN' }),
    resolveToken: async () => 'секрет',
    fetchImpl: async () => okJson({}),
  })
  assert.equal(await noUrl.isConfigured(), false)

  const noToken = createGiteaClient({
    getConfig: () => ({ giteaUrl: 'https://example.invalid', giteaTokenRef: 'GITEA_TOKEN' }),
    resolveToken: async () => '',
    fetchImpl: async () => okJson({}),
  })
  assert.equal(await noToken.isConfigured(), false)
})

test('в поле имени вписали сам токен — готовностью это не считается', async () => {
  // Частая ошибка: человек вставляет секрет туда, где ждут ИМЯ учётной записи.
  // Имя переменной окружения не начинается с цифры, поэтому проверка имени
  // такую подстановку отвергает, и секрет не уезжает в настройки.
  const gitea = createGiteaClient({
    getConfig: () => ({ giteaUrl: 'https://example.invalid', giteaTokenRef: '0123456789abcdef0123456789abcdef' }),
    resolveToken: async () => 'секрет',
    fetchImpl: async () => okJson({}),
  })
  assert.equal(await gitea.isConfigured(), false)
})

test('поиск репозиториев разбирает ответ инстанса', async () => {
  const { gitea } = stubClient(() => okJson({
    data: [{
      name: 'dsh-kanban', full_name: 'goodandready/dsh-kanban', owner: { login: 'goodandready' },
      open_issues_count: 3, updated_at: '2026-08-26T10:00:00Z', archived: false,
    }],
  }))
  const rows = await gitea.searchRepos({ query: 'kanban' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].owner, 'goodandready')
  assert.equal(rows[0].repo, 'dsh-kanban')
  assert.equal(rows[0].fullName, 'goodandready/dsh-kanban')
  assert.equal(rows[0].openIssues, 3)
  assert.equal(rows[0].archived, false)
})

test('отсутствие счётчика в ответе читается как ноль, а не как undefined', async () => {
  const { gitea } = stubClient(() => okJson({
    data: [{ name: 'r', full_name: 'o/r', owner: { login: 'o' } }],
  }))
  const rows = await gitea.searchRepos({ query: '' })
  assert.equal(rows[0].openIssues, 0)
  assert.equal(rows[0].archived, false)
})

test('комментарий уходит нужным методом', async () => {
  const { gitea, calls } = stubClient(() => okJson({ id: 1 }))
  await gitea.comment({ owner: 'o', repo: 'r', index: 3, body: 'привет' })
  assert.equal(calls[0].options.method, 'POST')
  assert.match(calls[0].url, /\/issues\/3\/comments$/)
})

test('пустое тело ответа не роняет разбор', async () => {
  const { gitea } = stubClient(() => ({ ok: true, status: 204, text: async () => '' }))
  assert.equal(await gitea.closeIssue({ owner: 'o', repo: 'r', index: 3 }), null)
})

test('репозитории с открытыми задачами идут первыми', () => {
  const out = rankRepos([
    { fullName: 'o/тихий', openIssues: 0, updatedAt: '2026-08-26T10:00:00Z' },
    { fullName: 'o/живой', openIssues: 3, updatedAt: '2026-08-01T10:00:00Z' },
  ])
  assert.deepEqual(out.map((r) => r.fullName), ['o/живой', 'o/тихий'])
})

test('при равном признаке решает время последней правки', () => {
  const out = rankRepos([
    { fullName: 'o/старый', openIssues: 2, updatedAt: '2026-08-01T10:00:00Z' },
    { fullName: 'o/свежий', openIssues: 5, updatedAt: '2026-08-26T10:00:00Z' },
  ])
  assert.deepEqual(out.map((r) => r.fullName), ['o/свежий', 'o/старый'])
})

test('архивные уходят вниз, даже если в них есть задачи', () => {
  const out = rankRepos([
    { fullName: 'o/архив', openIssues: 9, updatedAt: '2026-08-26T10:00:00Z', archived: true },
    { fullName: 'o/тихий', openIssues: 0, updatedAt: '2026-01-01T10:00:00Z' },
  ])
  assert.deepEqual(out.map((r) => r.fullName), ['o/тихий', 'o/архив'])
})

test('ранжирование не портит исходный массив', () => {
  const input = [{ fullName: 'b', openIssues: 0 }, { fullName: 'a', openIssues: 1 }]
  rankRepos(input)
  assert.deepEqual(input.map((r) => r.fullName), ['b', 'a'])
})

test('ранжирование переживает пустоту и нехватку полей', () => {
  assert.deepEqual(rankRepos(undefined), [])
  assert.equal(rankRepos([{ fullName: 'a' }, { fullName: 'b' }]).length, 2)
})

test('репозитории собираются со всех страниц', async () => {
  // Одной страницы мало: без перелистывания хвост теряется молча.
  const pages = {
    1: Array.from({ length: 50 }, (_, i) => ({ name: 'r' + i, full_name: 'o/r' + i, owner: { login: 'o' } })),
    2: [{ name: 'хвост', full_name: 'o/хвост', owner: { login: 'o' }, open_issues_count: 1 }],
  }
  const seen = []
  const gitea = createGiteaClient({
    getConfig: () => ({ giteaUrl: 'https://example.invalid', giteaTokenRef: 'GITEA_TOKEN' }),
    resolveToken: async () => 'секрет',
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'))
      seen.push(page)
      return okJson({ data: pages[page] ?? [] })
    },
  })
  const rows = await gitea.searchRepos({ query: '' })
  assert.deepEqual(seen, [1, 2])
  assert.equal(rows.length, 51)
  assert.equal(rows[0].fullName, 'o/хвост', 'репозиторий с задачами обязан быть первым')
})

test('число открытых задач берётся из того же ответа', async () => {
  const gitea = createGiteaClient({
    getConfig: () => ({ giteaUrl: 'https://example.invalid', giteaTokenRef: 'GITEA_TOKEN' }),
    resolveToken: async () => 'секрет',
    fetchImpl: async () => okJson({ data: [{ name: 'r', full_name: 'o/r', owner: { login: 'o' }, open_issues_count: 7 }] }),
  })
  const rows = await gitea.searchRepos({ query: '' })
  assert.equal(rows[0].openIssues, 7)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createGitHubClient, normalizeGithubUrl, safeSegment, isCredentialName } from '../lib/github.js'

test('normalizeGithubUrl: по умолчанию отдаёт api.github.com', () => {
  assert.equal(normalizeGithubUrl(''), 'https://api.github.com')
  assert.equal(normalizeGithubUrl(undefined), 'https://api.github.com')
  assert.equal(normalizeGithubUrl('   '), 'https://api.github.com')
  assert.equal(normalizeGithubUrl('https://github.mycompany.com/api/v3/'), 'https://github.mycompany.com')
})

test('safeSegment: фильтрует опасные символы путей', () => {
  assert.equal(safeSegment('goodandready'), 'goodandready')
  assert.equal(safeSegment('dsh-kanban'), 'dsh-kanban')
  assert.equal(safeSegment('foo/bar'), undefined)
  assert.equal(safeSegment('../evil'), undefined)
  assert.equal(safeSegment(''), undefined)
})

test('isCredentialName: проверяет имя учётной записи', () => {
  assert.equal(isCredentialName('GITHUB_TOKEN'), true)
  assert.equal(isCredentialName('my_token_ref'), true)
  assert.equal(isCredentialName(''), false)
  assert.equal(isCredentialName('bad token'), false)
})

test('isConfigured: отдаёт true только при валидном токене', async () => {
  const client = createGitHubClient({
    getConfig: () => ({ githubTokenRef: 'GH_TOKEN' }),
    resolveToken: async (ref) => (ref === 'GH_TOKEN' ? 'ghp_secret123' : ''),
  })
  assert.equal(await client.isConfigured(), true)

  const emptyClient = createGitHubClient({
    getConfig: () => ({ githubTokenRef: 'NO_TOKEN' }),
    resolveToken: async () => '',
  })
  assert.equal(await emptyClient.isConfigured(), false)
})

test('listIssues: передаёт заголовок Bearer, User-Agent и отсекает pull_request (#296)', async () => {
  let capturedUrl
  let capturedHeaders

  const fakeFetch = async (url, opts) => {
    capturedUrl = url
    capturedHeaders = opts.headers
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'W/"etag-123"' },
      text: async () => JSON.stringify([
        { number: 1, title: 'Bug report' },
        { number: 2, title: 'PR title', pull_request: { html_url: '...' } },
        { number: 3, title: 'Feature request' },
      ]),
    }
  }

  const client = createGitHubClient({
    getConfig: () => ({ githubTokenRef: 'GH_TOKEN' }),
    resolveToken: async () => 'ghp_test_token',
    fetchImpl: fakeFetch,
  })

  const issues = await client.listIssues({ owner: 'goodandready', repo: 'dsh-kanban' })
  assert.equal(issues.length, 2)
  assert.equal(issues[0].number, 1)
  assert.equal(issues[1].number, 3)
  assert.equal(capturedHeaders.Authorization, 'Bearer ghp_test_token')
  assert.equal(capturedHeaders.Accept, 'application/vnd.github+json')
  assert.equal(capturedHeaders['User-Agent'], 'dsh-kanban')
  assert.ok(capturedUrl.includes('/repos/goodandready/dsh-kanban/issues'))
})

test('listIssues: использует ETag и возвращает кэшированные данные при 304 Not Modified', async () => {
  let callCount = 0
  const fakeFetch = async (url, opts) => {
    callCount += 1
    if (opts.headers['If-None-Match'] === 'W/"etag-abc"') {
      return { ok: true, status: 304, text: async () => '' }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'etag' ? 'W/"etag-abc"' : null) },
      text: async () => JSON.stringify([{ number: 42, title: 'Cached Issue' }]),
    }
  }

  const client = createGitHubClient({
    getConfig: () => ({ githubTokenRef: 'GH_TOKEN' }),
    resolveToken: async () => 'token123',
    fetchImpl: fakeFetch,
  })

  // Первый вызов — 200 с etag
  const first = await client.listIssues({ owner: 'org', repo: 'repo' })
  assert.equal(first.length, 1)
  assert.equal(first[0].number, 42)
  assert.equal(callCount, 1)

  // Второй вызов — отправляет If-None-Match, получает 304, возвращает из кэша
  const second = await client.listIssues({ owner: 'org', repo: 'repo' })
  assert.equal(second.length, 1)
  assert.equal(second[0].number, 42)
  assert.equal(callCount, 2)
})

test('createPullRequest: отправляет POST с head, base и title', async () => {
  let postedBody
  let postedMethod

  const fakeFetch = async (url, opts) => {
    postedMethod = opts.method
    postedBody = JSON.parse(opts.body)
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ number: 99, html_url: 'https://github.com/o/r/pull/99' }),
    }
  }

  const client = createGitHubClient({
    getConfig: () => ({ githubTokenRef: 'GH_TOKEN' }),
    resolveToken: async () => 'token123',
    fetchImpl: fakeFetch,
  })

  const pr = await client.createPullRequest({
    owner: 'goodandready',
    repo: 'dsh-kanban',
    title: 'New PR',
    body: 'PR description',
    head: 'feat/test',
    base: 'main',
  })

  assert.equal(postedMethod, 'POST')
  assert.equal(postedBody.head, 'feat/test')
  assert.equal(postedBody.base, 'main')
  assert.equal(postedBody.title, 'New PR')
  assert.equal(pr.number, 99)
})

test('closeIssue и setAssignees формируют валидные PATCH-запросы', async () => {
  const calls = []
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null })
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
  }

  const client = createGitHubClient({
    getConfig: () => ({ githubTokenRef: 'GH_TOKEN' }),
    resolveToken: async () => 'token123',
    fetchImpl: fakeFetch,
  })

  await client.closeIssue({ owner: 'org', repo: 'repo', index: 15 })
  assert.equal(calls[0].method, 'PATCH')
  assert.deepEqual(calls[0].body, { state: 'closed' })
  assert.ok(calls[0].url.endsWith('/repos/org/repo/issues/15'))

  await client.setAssignees({ owner: 'org', repo: 'repo', index: 15, logins: ['vadim'] })
  assert.equal(calls[1].method, 'PATCH')
  assert.deepEqual(calls[1].body, { assignees: ['vadim'] })
})

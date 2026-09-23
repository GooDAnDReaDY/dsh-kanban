import test from 'node:test'
import assert from 'node:assert/strict'
import { createGitProvider } from '../lib/git-provider.js'

function stubForge(name, configured = true) {
  return {
    provider: name,
    async isConfigured() { return configured },
    async me() { return name + '-user' },
    async listIssues(opts) { return [{ provider: name, opts }] },
    async getIssue(opts) { return { provider: name, opts } },
    async createIssue(opts) { return { provider: name, created: true, opts } },
    async closeIssue(opts) { return { provider: name, closed: true, opts } },
    async comment(opts) { return { provider: name, commented: true, opts } },
    async setAssignees(opts) { return { provider: name, assigned: true, opts } },
    async listPulls(opts) { return [{ provider: name, pulls: true, opts }] },
    async createPullRequest(opts) { return { provider: name, pr: true, opts } },
    async listBranches(opts) { return [{ provider: name, name: 'main' }] },
    async listOrgs() { return [name + '-org'] },
    async listOrgRepos(opts) { return [{ provider: name, name: 'repo-1' }] },
    async searchRepos(opts) { return [{ provider: name, name: 'found-in-' + name }] },
  }
}

test('gitProvider: направляет вызовы по task.provider (gitea vs github)', async () => {
  const gitea = stubForge('gitea')
  const github = stubForge('github')
  const provider = createGitProvider({
    gitea,
    github,
    getConfig: () => ({ gitProvider: 'auto' }),
  })

  // Задача с provider: 'github'
  const ghRes = await provider.getIssue({ owner: 'o', repo: 'r', index: 1, provider: 'github' })
  assert.equal(ghRes.provider, 'github')

  // Задача с provider: 'gitea'
  const gtRes = await provider.getIssue({ owner: 'o', repo: 'r', index: 1, provider: 'gitea' })
  assert.equal(gtRes.provider, 'gitea')
})

test('gitProvider: определяет GitHub по ссылке issueUrl (github.com)', async () => {
  const gitea = stubForge('gitea')
  const github = stubForge('github')
  const provider = createGitProvider({
    gitea,
    github,
    getConfig: () => ({ gitProvider: 'auto' }),
  })

  const res = await provider.closeIssue({
    issueUrl: 'https://github.com/goodandready/dsh-kanban/issues/10',
    owner: 'goodandready',
    repo: 'dsh-kanban',
    index: 10,
  })
  assert.equal(res.provider, 'github')
})

test('gitProvider: уважает настройку gitProvider: github / gitea', async () => {
  const gitea = stubForge('gitea')
  const github = stubForge('github')

  const ghOnly = createGitProvider({
    gitea,
    github,
    getConfig: () => ({ gitProvider: 'github' }),
  })
  assert.equal((await ghOnly.me()).startsWith('github'), true)

  const gtOnly = createGitProvider({
    gitea,
    github,
    getConfig: () => ({ gitProvider: 'gitea' }),
  })
  assert.equal((await gtOnly.me()).startsWith('gitea'), true)
})

test('gitProvider: searchRepos агрегирует результаты обоих настроенных провайдеров', async () => {
  const gitea = stubForge('gitea', true)
  const github = stubForge('github', true)
  const provider = createGitProvider({
    gitea,
    github,
    getConfig: () => ({ gitProvider: 'auto' }),
  })

  const results = await provider.searchRepos({ query: 'kanban' })
  assert.equal(results.length, 2)
  const names = results.map((r) => r.provider)
  assert.ok(names.includes('gitea'))
  assert.ok(names.includes('github'))
})

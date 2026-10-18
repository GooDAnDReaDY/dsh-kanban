// Composite router for Git providers (Gitea and GitHub).
//
// Exposes unified interface across both platforms:
// - routes task queries to appropriate provider (task.provider / issueUrl);
// - in 'auto' mode queries configured provider or merges search results;
// - supports Gitea-only, GitHub-only, or simultaneous dual-forge operations.

export function createGitProvider({ gitea, github, getConfig }) {
  async function resolveActiveProvider(hint) {
    if (hint && typeof hint === 'object') {
      if (hint.forge === 'github' || hint.provider === 'github') return github
      if (hint.forge === 'gitea' || hint.provider === 'gitea') return gitea
      if (typeof hint.issueUrl === 'string' && hint.issueUrl.includes('github.com')) {
        return github
      }
    } else if (hint === 'github') {
      return github
    } else if (hint === 'gitea') {
      return gitea
    }

    const mode = String(getConfig()?.gitProvider || 'auto').toLowerCase()
    if (mode === 'github') return github
    if (mode === 'gitea') return gitea

    // In 'auto' mode: check provider availability
    const giteaReady = await gitea.isConfigured()
    const githubReady = await github.isConfigured()
    if (githubReady && !giteaReady) return github
    return gitea
  }

  function forTarget(target) {
    if (target === github || target?.provider === 'github') return github
    if (target === gitea || target?.provider === 'gitea') return gitea
    return undefined
  }

  return {
    gitea,
    github,

    /** Resolve provider for task or context. */
    resolve: resolveActiveProvider,

    /** Whether any or specific provider is configured. */
    async isConfigured(providerName) {
      if (providerName === 'github') return github.isConfigured()
      if (providerName === 'gitea') return gitea.isConfigured()
      const gReady = await gitea.isConfigured()
      if (gReady) return true
      return github.isConfigured()
    },

    /** Current user login. */
    async me(target) {
      const p = forTarget(target) || await resolveActiveProvider(target)
      return p.me()
    },

    /** Create repository. */
    async createRepo(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      if (typeof p?.createRepo !== 'function') {
        throw Object.assign(new Error('Repository creation not supported by provider'), { code: 'not-supported' })
      }
      return p.createRepo(options)
    },

    /** List issues. */
    async listIssues(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.listIssues(options)
    },

    /** Get issue by number. */
    async getIssue(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.getIssue(options)
    },

    /** Create issue. */
    async createIssue(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.createIssue(options)
    },

    /** Close issue. */
    async closeIssue(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.closeIssue(options)
    },

    /** Comment on issue. */
    async comment(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.comment(options)
    },

    /** Assign responsible users. */
    async setAssignees(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.setAssignees(options)
    },

    /** List Pull Requests. */
    async listPulls(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.listPulls(options)
    },

    /** Create Pull Request. */
    async createPullRequest(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.createPullRequest(options)
    },

    /** List repository branches. */
    async listBranches(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.listBranches(options)
    },

    /** List organizations. */
    async listOrgs(target) {
      const p = forTarget(target) || await resolveActiveProvider(target)
      return p.listOrgs()
    },

    /** Organization repositories. */
    async listOrgRepos(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.listOrgRepos(options)
    },

    /**
     * Search repositories: queries target provider or aggregates results
     * from both if enabled.
     */
    async searchRepos(options) {
      const target = forTarget(options?.provider)
      if (target) {
        return target.searchRepos(options)
      }

      const mode = String(getConfig()?.gitProvider || 'auto').toLowerCase()
      if (mode === 'github') return github.searchRepos(options)
      if (mode === 'gitea') return gitea.searchRepos(options)

      // If 'auto' / 'both' mode, query both configured providers
      const [giteaConfigured, githubConfigured] = await Promise.all([
        gitea.isConfigured(),
        github.isConfigured(),
      ])

      const requests = []
      if (giteaConfigured) requests.push(gitea.searchRepos(options).catch(() => []))
      if (githubConfigured) requests.push(github.searchRepos(options).catch(() => []))

      if (requests.length === 0) return []
      const results = await Promise.all(requests)
      return results.flat()
    },
  }
}

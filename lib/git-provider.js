// Композитный маршрутизатор Git-провайдеров (Gitea и GitHub).
//
// Предоставляет единый интерфейс к обеим системам:
// - прозрачно направляет запросы задач в соответствующий провайдер (task.provider / issueUrl);
// - в режиме 'auto' опрашивает настроенный провайдер или объединяет результаты поиска;
// - позволяет доске бесшовно работать как только с Gitea, так и только с GitHub или с обоими сразу.

export function createGitProvider({ gitea, github, getConfig }) {
  async function resolveActiveProvider(hint) {
    if (hint && typeof hint === 'object') {
      if (hint.provider === 'github') return github
      if (hint.provider === 'gitea') return gitea
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

    // В режиме 'auto': проверяем доступность провайдеров
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

    /** Определить провайдера для задачи или контекста. */
    resolve: resolveActiveProvider,

    /** Настроен ли хотя бы один или конкретный провайдер. */
    async isConfigured(providerName) {
      if (providerName === 'github') return github.isConfigured()
      if (providerName === 'gitea') return gitea.isConfigured()
      const gReady = await gitea.isConfigured()
      if (gReady) return true
      return github.isConfigured()
    },

    /** Логин текущего пользователя. */
    async me(target) {
      const p = forTarget(target) || await resolveActiveProvider(target)
      return p.me()
    },

    /** Список issues. */
    async listIssues(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.listIssues(options)
    },

    /** Получить issue по номеру. */
    async getIssue(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.getIssue(options)
    },

    /** Создать issue. */
    async createIssue(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.createIssue(options)
    },

    /** Закрыть issue. */
    async closeIssue(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.closeIssue(options)
    },

    /** Комментарий в issue. */
    async comment(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.comment(options)
    },

    /** Назначить ответственных. */
    async setAssignees(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.setAssignees(options)
    },

    /** Список Pull Requests. */
    async listPulls(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.listPulls(options)
    },

    /** Создать Pull Request. */
    async createPullRequest(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.createPullRequest(options)
    },

    /** Список веток репозитория. */
    async listBranches(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.listBranches(options)
    },

    /** Список организаций. */
    async listOrgs(target) {
      const p = forTarget(target) || await resolveActiveProvider(target)
      return p.listOrgs()
    },

    /** Репозитории организации. */
    async listOrgRepos(options) {
      const p = forTarget(options?.provider) || await resolveActiveProvider(options)
      return p.listOrgRepos(options)
    },

    /**
     * Поиск репозиториев: ищет в целевом провайдере либо агрегирует результаты
     * из обоих, если включены оба.
     */
    async searchRepos(options) {
      const target = forTarget(options?.provider)
      if (target) {
        return target.searchRepos(options)
      }

      const mode = String(getConfig()?.gitProvider || 'auto').toLowerCase()
      if (mode === 'github') return github.searchRepos(options)
      if (mode === 'gitea') return gitea.searchRepos(options)

      // Если режим 'auto' / 'both', опрашиваем оба настроенных
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

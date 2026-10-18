// Transfer Gitea issue to a board task.
//
// Synchronization in 0.1 is one-way: Gitea -> kanban, at import time and on
// manual refresh. Two-way synchronization is handled separately.
//
// Gitea client is passed as a parameter — configured by `lib/gitea.js`. Here
// we only map fields and handle cases where access is not configured.

import { safeSegment } from './gitea.js'
import { colorsOfIssue } from './filters.js'

/**
 * When the issue was created in Gitea.
 *
 * Without this, the card would show the import timestamp: a year-old issue
 * would appear created today, losing chronological context.
 */
export function issueBornAt(issue) {
  const at = Date.parse(issue?.created_at ?? '')
  return Number.isFinite(at) && at > 0 ? at : undefined
}

/**
 * Issue author.
 *
 * Uses `login`: matches what Gitea displays under the issue and search queries.
 * Full name is not set for all users, so using it would cause inconsistencies.
 */
export function issueAuthor(issue) {
  const login = issue?.user?.login
  return typeof login === 'string' ? login : ''
}

/**
 * Issue assignee.
 *
 * Gitea returns assignees in two ways: single `assignee` and list `assignees`.
 * Pick the first from the list if single is absent: board tracks a single
 * responsible assignee.
 */
export function issueAssignee(issue) {
  const one = issue?.assignee?.login
  if (typeof one === 'string' && one !== '') return one
  const many = Array.isArray(issue?.assignees) ? issue.assignees : []
  const first = many.find((x) => typeof x?.login === 'string' && x.login !== '')
  return first === undefined ? '' : first.login
}

/**
 * Milestone the issue belongs to.
 *
 * Releases are tracked via Gitea milestones; board stores milestone title
 * so release progress can be monitored directly on cards.
 */
export function issueMilestone(issue) {
  const title = issue?.milestone?.title
  return typeof title === 'string' ? title : ''
}

/**
 * Map task fields from an issue.
 *
 * `owner` and `repo` come from request context, not the issue payload: Gitea API
 * does not return them in all response shapes.
 *
 * Fields `branch`, `worktree`, `sessionId`, `model` are NOT populated here:
 * they are assigned later when work begins. The plugin does not create branches on import.
 */
export function issueToTask(issue, { board = 'main', column = 'backlog', owner, repo, provider, forge }) {
  const detectedForge = forge || (typeof issue?.html_url === 'string' && issue.html_url.includes('github.com') ? 'github' : 'gitea')
  return {
    board,
    column,
    forge: detectedForge,
    ...(provider && provider !== 'github' && provider !== 'gitea' ? { provider } : {}),
    title: typeof issue?.title === 'string' ? issue.title : '',
    body: typeof issue?.body === 'string' ? issue.body : '',
    labels: Array.isArray(issue?.labels)
      ? issue.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string')
      : [],
    // Colors are kept alongside names for filters, reconciler, chip, and search.
    labelColors: colorsOfIssue(issue?.labels),
    owner,
    repo,
    issueNumber: typeof issue?.number === 'number' ? issue.number : undefined,
    issueUrl: typeof issue?.html_url === 'string' ? issue.html_url : undefined,
    createdAt: issueBornAt(issue),
    author: issueAuthor(issue),
    assignee: issueAssignee(issue),
    milestone: issueMilestone(issue),
  }
}

/**
 * Mark issues that already exist on the board.
 *
 * Compared by owner-repo-number tuple to avoid colliding with issue #1 in another repo.
 * Existing issues are dimmed rather than hidden, as re-importing may be intentional.
 */
export function markImported(issues, existing, { owner, repo, forge }) {
  const targetForge = forge || ''
  const seen = new Set(
    (existing ?? [])
      .filter((t) => {
        if (t.owner !== owner || t.repo !== repo || typeof t.issueNumber !== 'number') return false
        if (targetForge) {
          const tf = t.forge || (typeof t.issueUrl === 'string' && t.issueUrl.includes('github.com') ? 'github' : 'gitea')
          return tf === targetForge
        }
        return true
      })
      .map((t) => t.issueNumber),
  )
  return (issues ?? []).map((issue) => ({ ...issue, imported: seen.has(issue?.number) }))
}

/**
 * Fields to overwrite when updating a task from an issue.
 *
 * Only fields originating from Gitea are updated. Local fields (column,
 * position, session, model) are preserved to avoid resetting active work.
 */
export function refreshPatch(task, issue) {
  const patch = {}
  if (typeof issue?.title === 'string') patch.title = issue.title
  if (typeof issue?.body === 'string') patch.body = issue.body
  if (Array.isArray(issue?.labels)) {
    patch.labels = issue.labels
      .map((l) => (typeof l === 'string' ? l : l?.name))
      .filter((n) => typeof n === 'string')
    patch.labelColors = colorsOfIssue(issue.labels)
  }
  if (typeof issue?.html_url === 'string') patch.issueUrl = issue.html_url
  const born = issueBornAt(issue)
  if (born !== undefined) patch.createdAt = born
  const author = issueAuthor(issue)
  if (author !== '') patch.author = author
  // Explicit empty assignee when cleared in Gitea so board does not retain stale assignee.
  if (issue?.assignee !== undefined || Array.isArray(issue?.assignees)) {
    patch.assignee = issueAssignee(issue)
  }
  // Milestone removal is also explicitly recorded.
  if ('milestone' in (issue ?? {})) patch.milestone = issueMilestone(issue)
  return patch
}

/**
 * Check if Gitea client is configured and ready.
 *
 * Missing client vs unconfigured access are distinct error states.
 * Async check includes token credential verification.
 */
export async function giteaState(gitea) {
  if (gitea === undefined || gitea === null) return 'absent'
  if (typeof gitea.isConfigured !== 'function') return 'ready'
  try {
    return (await gitea.isConfigured()) === true ? 'ready' : 'unconfigured'
  } catch {
    return 'unconfigured'
  }
}

/** List open issues for import dialog, marking already-imported ones. */
export async function listImportable({ gitea, store, owner, repo, board = 'main', provider, forge }) {
  const state = await giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  const issues = await gitea.listIssues({ owner, repo, state: 'open', provider: forge || provider })
  const existing = store.listTasks({ board })
  return { issues: markImported(issues, existing, { owner, repo, forge: forge || provider }) }
}

/** Create a task from an issue. */
export async function importIssue({ gitea, store, owner, repo, issueNumber, board = 'main', column = 'backlog', provider, forge }) {
  const state = await giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  if (typeof issueNumber !== 'number') return { error: 'issue-number-required', status: 400 }
  // Simple board is for non-issue tasks. Importing here would bring branches/PRs into columns unable to display them.
  if (store.boardKind(board) !== 'project') return { error: 'board-not-for-issues', status: 400 }
  const effectiveForge = forge || (provider === 'github' || provider === 'gitea' ? provider : undefined)
  const effectiveProvider = (provider !== 'github' && provider !== 'gitea') ? provider : undefined
  if (typeof store.findTaskByIssue === 'function') {
    const existing = store.findTaskByIssue({ owner, repo, issueNumber, forge: effectiveForge })
    if (existing) return { task: existing }
  }
  const issue = await gitea.getIssue({ owner, repo, index: issueNumber, provider: effectiveForge || effectiveProvider })
  if (issue === undefined || issue === null) return { error: 'issue-not-found', status: 404 }
  return { task: store.createTask(issueToTask(issue, { board, column, owner, repo, forge: effectiveForge, provider: effectiveProvider })) }
}

/** Re-read issue and update task, preserving local state. */
export async function refreshTask({ gitea, store, id }) {
  const state = await giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  const task = store.getTask(id)
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  if (typeof task.issueNumber !== 'number') return { error: 'task-has-no-issue', status: 400 }
  const forge = task.forge || (typeof task.issueUrl === 'string' && task.issueUrl.includes('github.com') ? 'github' : 'gitea')
  const issue = await gitea.getIssue({ owner: task.owner, repo: task.repo, index: task.issueNumber, provider: forge, issueUrl: task.issueUrl })
  if (issue === undefined || issue === null) return { error: 'issue-not-found', status: 404 }
  return { task: store.updateTask(id, refreshPatch(task, issue)) }
}

/** Search repositories for import dialog. */
export async function searchRepos({ gitea, query, limit = 20 }) {
  const state = await giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }
  return { repos: await gitea.searchRepos({ query, limit }) }
}

/**
 * Create a project task: Gitea issue plus linked board card.
 *
 * Repository is selected from existing list or created by name.
 * Order of operations: repo first, then issue, then board card.
 * Failure midway avoids leaving orphaned cards.
 */
export async function createProjectTask({
  gitea, store, owner, repo, newRepo, title, body, board = 'main', provider, forge,
}) {
  const state = await giteaState(gitea)
  if (state !== 'ready') return { error: `gitea-${state}`, status: 409 }

  const name = typeof title === 'string' ? title.trim() : ''
  if (name === '') return { error: 'title-required', status: 400 }

  let targetRepo = typeof repo === 'string' ? repo.trim() : ''
  if (targetRepo === '') {
    const wanted = typeof newRepo === 'string' ? newRepo.trim() : ''
    if (wanted === '') return { error: 'repo-required', status: 400 }
    // Validate repository name before API call.
    if (safeSegment(wanted) === undefined) return { error: 'bad-repo-name', status: 400 }
    try {
      await gitea.createRepo({ owner, name: wanted, provider: forge || provider })
    } catch (error) {
      return { error: 'repo-not-created', status: 502, detail: String(error?.message ?? error) }
    }
    targetRepo = wanted
  }

  const effectiveForge = forge || (provider === 'github' || provider === 'gitea' ? provider : undefined)
  const effectiveProvider = (provider !== 'github' && provider !== 'gitea') ? provider : undefined
  let issue
  try {
    issue = await gitea.createIssue({ owner, repo: targetRepo, title: name, body, provider: effectiveForge || effectiveProvider })
  } catch (error) {
    // Repository may have already been created; avoid deleting on issue creation failure.
    return { error: 'issue-not-created', status: 502, detail: String(error?.message ?? error) }
  }

  return { task: store.createTask(issueToTask(issue, { board, column: 'backlog', owner, repo: targetRepo, forge: effectiveForge, provider: effectiveProvider })) }
}

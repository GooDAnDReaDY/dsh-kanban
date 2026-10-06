// Task synchronization with Gitea and automated column transitions.
//
// Timing and scheduling are managed by `lib/index.js`.
// This module provides the pure synchronization logic, testable with mock clients
// without network dependencies or wait timers.

import { deriveColumn, resolveTransition, branchOfTask, pullsOfTask, resolveConflict } from './transitions.js'
import { watchedRepos, shouldTake, archiveBefore, isWatched } from './intake.js'
import { colorsOfIssue } from './filters.js'
import { issueToTask, issueBornAt, issueAuthor, issueAssignee, issueMilestone } from './import.js'

/**
 * Execute an async operation with exponential backoff on network failures.
 * @template T
 * @param {() => Promise<T>} fn async operation
 * @param {{retries?: number, baseMs?: number, maxMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export async function withBackoff(fn, { retries = 2, baseMs = 50, maxMs = 500 } = {}) {
  let attempt = 0
  let firstErr
  while (true) {
    try {
      return await fn()
    } catch (err) {
      if (!firstErr) firstErr = err
      if (attempt >= retries) throw (firstErr || err)
      const delay = Math.min(baseMs * (2 ** attempt), maxMs)
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * Observations for a single repository (pull requests and branches).
 *
 * Read once per repository rather than per task to minimize API calls.
 * Failures are not silently swallowed: incomplete observations (missing PRs or branches)
 * would lead to erroneous column transitions. If reading fails, the repository is skipped.
 */
async function readRepo({ gitea, owner, repo, forge }) {
  const [pulls, branches] = await Promise.all([
    gitea.listPulls({ owner, repo, state: 'all' }),
    gitea.listBranches({ owner, repo }),
  ])
  return { pulls, branches }
}

/**
 * Observed state from Gitea for a single task.
 *
 * @returns {{column: string|undefined, branch: string|undefined, pull: object|undefined}}
 */
export function observeTask(task, repoState, issue) {
  const branch = branchOfTask(task, repoState?.branches)
  const pulls = pullsOfTask(task, repoState?.pulls, branch)
  const column = deriveColumn({ issue, pulls, branchExists: branch !== undefined })
  const pull = pulls.find((p) => p?.merged === true || p?.merged_at)
    ?? pulls.find((p) => p?.state === 'open')
  return { column, branch, pull }
}

/** Human-readable explanation for automated column transitions. */
export function explain({ column, branch, pull }) {
  switch (column) {
    case 'review': return pull?.number ? `PR #${pull.number} ready for review` : 'PR ready for review'
    case 'deploy': return pull?.number ? `PR #${pull.number} merged` : 'PR merged'
    case 'cleanup': return branch ? `issue closed, branch ${branch} still exists` : 'issue closed'
    case 'done': return 'issue closed, branch deleted'
    case 'in-progress': return branch ? `branch ${branch} appeared` : 'work started'
    default: return ''
  }
}

/**
 * Remote fields synced from Gitea on each reconciliation run.
 *
 * Title, labels, author, assignee, milestone are updated if changed.
 * Task body is deliberately NOT overwritten to preserve user notes made from the UI chip.
 * Returns only modified fields to minimize unnecessary database writes.
 */
function remoteFields(task, issue) {
  const patch = {}
  if (typeof issue?.title === 'string' && issue.title !== task.title) patch.title = issue.title
  if (Array.isArray(issue?.labels)) {
    const names = issue.labels
      .map((l) => (typeof l === 'string' ? l : l?.name))
      .filter((n) => typeof n === 'string')
    const same = names.length === (task.labels ?? []).length
      && names.every((n) => (task.labels ?? []).includes(n))
    if (!same) patch.labels = names
    // Label colors are updated if modified in Gitea.
    const colors = colorsOfIssue(issue.labels)
    const before = task.labelColors ?? {}
    const sameColors = Object.keys(colors).length === Object.keys(before).length
      && Object.entries(colors).every(([k, v]) => before[k] === v)
    if (!sameColors) patch.labelColors = colors
  }
  // Issue creation timestamp is updated to fix tasks imported prior to timestamp tracking.
  const born = issueBornAt(issue)
  if (born !== undefined && born !== task.createdAt) patch.createdAt = born
  const author = issueAuthor(issue)
  if (author !== '' && author !== task.author) patch.author = author
  // Assignee changes are synced bidirectionally (assigned or unassigned).
  if (issue?.assignee !== undefined || Array.isArray(issue?.assignees)) {
    const assignee = issueAssignee(issue)
    if (assignee !== (task.assignee ?? '')) patch.assignee = assignee
  }
  if ('milestone' in (issue ?? {})) {
    const milestone = issueMilestone(issue)
    if (milestone !== (task.milestone ?? '')) patch.milestone = milestone
  }
  return patch
}

/**
 * Apply observations and transition column if needed.
 *
 * Observed branch and PR are updated on the task regardless of whether column changes.
 * Conflicts between local board edits and remote Gitea updates are resolved by timestamp,
 * recording overridden changes in the transition history.
 *
 * @returns {object|undefined} applied transition or undefined
 */
export function applyObservation({ store, task, observation, issue, remoteUpdatedAt, now = Date.now() }) {
  const patch = { syncedAt: now, ...remoteFields(task, issue) }
  if (observation.branch !== undefined && observation.branch !== task.branch) patch.branch = observation.branch
  store.updateTask(task.id, patch)

  const verdict = resolveConflict({
    localColumn: task.column,
    remoteColumn: observation.column,
    localUpdatedAt: task.updatedAt,
    remoteUpdatedAt: Date.parse(remoteUpdatedAt ?? '') || 0,
    syncedAt: task.syncedAt,
  })

  if (verdict.winner === 'local') {
    // Board won the conflict; log transition note if Gitea had a different column.
    if (verdict.overridden !== undefined) {
      store.addTransition({
        taskId: task.id,
        fromCol: task.column,
        toCol: task.column,
        source: 'gitea',
        detail: `conflict: Gitea has "${verdict.overridden}", board edited later`,
      })
    }
    return undefined
  }
  if (verdict.winner === 'none') return undefined

  const move = resolveTransition(task.column, [
    { column: verdict.column, source: 'gitea', detail: explain(observation) },
  ])
  if (move === undefined) return undefined

  store.moveTask(task.id, { column: move.column })
  store.addTransition({
    taskId: task.id,
    fromCol: task.column,
    toCol: move.column,
    source: move.source,
    detail: verdict.overridden !== undefined
      ? `${move.detail} (overridden: board had "${verdict.overridden}")`
      : move.detail,
  })
  return move
}

/**
 * Reconcile all tasks backed by an active Gitea issue.
 *
 * A failure on one repository does not abort others; report identifies total counts
 * and specific problem details.
 *
 * @returns {{checked: number, moved: number, failed: number,
 *   repos: number, reposFailed: number, problem: {where: string, message: string}|undefined}}
 */
export async function syncAll({ gitea, store, logger, only, now = Date.now() }) {
  const tasks = store.listWatchable().filter((t) => (only ? only(t) : true))
  const byRepo = new Map()
  for (const task of tasks) {
    const forge = task.forge || (typeof task.issueUrl === 'string' && task.issueUrl.includes('github.com') ? 'github' : 'gitea')
    const key = `${forge}:${task.owner}/${task.repo}`
    if (!byRepo.has(key)) byRepo.set(key, { forge, owner: task.owner, repo: task.repo, tasks: [] })
    byRepo.get(key).tasks.push(task)
  }

  let checked = 0
  let moved = 0
  let failed = 0
  let reposFailed = 0
  // Record first failure detail for clear error reporting.
  let problem
  const note = (where, error) => {
    if (problem === undefined) problem = { where, message: String(error?.message ?? error ?? 'unknown error') }
  }

  for (const group of byRepo.values()) {
    let repoState
    try {
      repoState = await withBackoff(() => readRepo({ gitea, owner: group.owner, repo: group.repo, forge: group.forge }), { retries: 2, baseMs: 40 })
    } catch (error) {
      failed += group.tasks.length
      reposFailed += 1
      note(`${group.owner}/${group.repo}`, error)
      logger?.warn?.(`dsh-kanban: repository ${group.owner}/${group.repo} read failed: ${error?.message}`)
      continue
    }

    for (const task of group.tasks) {
      checked += 1
      try {
        const issue = await gitea.getIssue({ owner: task.owner, repo: task.repo, index: task.issueNumber, provider: group.forge, issueUrl: task.issueUrl })
        const observation = observeTask(task, repoState, issue)
        const applied = applyObservation({
          store, task, observation, issue, remoteUpdatedAt: issue?.updated_at,
        })
        if (applied !== undefined) moved += 1
      } catch (error) {
        failed += 1
        note(`${task.owner}/${task.repo}#${task.issueNumber}`, error)
        logger?.warn?.(`dsh-kanban: task ${task.id} sync failed: ${error?.message}`)
      }
    }
  }

  return { checked, moved, failed, repos: byRepo.size, reposFailed, problem, at: now }
}

/**
 * Resolve repositories to monitor for intake.
 *
 * Returns explicitly configured repositories, or all organization repos with open issues
 * if no explicit list is configured.
 *
 * @returns {Promise<Array<{owner: string, repo: string}>>}
 */
async function resolveRepos({ gitea, config, owner }) {
  const named = watchedRepos({ config, owner })
  if (named.length > 0) return named
  if (owner === undefined || owner === '') {
    throw new Error('owner not specified: set organization in settings')
  }
  const rows = await gitea.listOrgRepos({ owner })
  return rows
    .filter((r) => r.archived !== true && r.openIssues > 0)
    .map((r) => ({ owner, repo: r.name }))
}

/**
 * Ingest new issues from tracked repositories that do not yet exist on the board.
 *
 * @returns {{added: number, skipped: number, failed: number, problem: object|undefined}}
 */
export async function intakeAll({ gitea, store, config, owner, logger, only, repos: given }) {
  let added = 0
  let skipped = 0
  let failed = 0
  let problem

  // Filter by single repository if requested (e.g. from webhook event).
  let repos
  try {
    repos = (given ?? await resolveRepos({ gitea, config, owner }))
      .filter((pair) => (only ? only(pair) : true))
  } catch (error) {
    return {
      added, skipped, failed: 1,
      problem: { where: 'repository list', message: String(error?.message ?? error) },
    }
  }

  for (const pair of repos) {
    let issues
    try {
      issues = await gitea.listIssues({ owner: pair.owner, repo: pair.repo, state: 'open', limit: 50 })
    } catch (error) {
      failed += 1
      if (problem === undefined) {
        problem = { where: `${pair.owner}/${pair.repo}`, message: String(error?.message ?? error) }
      }
      logger?.warn?.(`dsh-kanban: tasks from ${pair.owner}/${pair.repo} fetch failed: ${error?.message}`)
      continue
    }

    for (const issue of issues ?? []) {
      const verdict = shouldTake({ store, owner: pair.owner, repo: pair.repo, issue })
      if (!verdict.take) { skipped += 1; continue }
      store.createTask(issueToTask(issue, {
        // Imported issues always go to the 'main' project board in the 'backlog' column.
        board: 'main', column: 'backlog', owner: pair.owner, repo: pair.repo,
      }))
      added += 1
    }
  }

  return { added, skipped, failed, problem }
}

/**
 * Archive tasks that have remained in 'done' past the retention threshold.
 *
 * Archiving is reversible (does not hard-delete).
 */
export function archiveOverdue({ store, config, now = Date.now() }) {
  const before = archiveBefore({ now, afterDays: config?.archiveAfterDays })
  if (before === undefined) return { archived: 0 }
  const due = store.listArchivable(before)
  for (const task of due) store.setArchived(task.id, now)
  return { archived: due.length }
}

/**
 * In-memory sync status for UI telemetry.
 *
 * Stored in process memory rather than SQLite to reflect current run state.
 * Sync failures do not wipe the last successful sync timestamp.
 */
export function createSyncState() {
  let okAt
  let failedAt
  let problem
  let running = false

  return {
    started() { running = true },

    /** Record sync run outcome. */
    finished(report) {
      running = false
      if (report?.problem === undefined) {
        okAt = report?.at ?? Date.now()
        failedAt = undefined
        problem = undefined
        return
      }
      failedAt = report?.at ?? Date.now()
      problem = report.problem
    },

    /** Record failure when sync cannot start. */
    failedToStart(where, message) {
      running = false
      failedAt = Date.now()
      problem = { where, message: String(message ?? 'unknown error') }
    },

    snapshot() {
      return {
        running,
        okAt,
        failedAt,
        problem,
        state: running ? 'running' : problem !== undefined ? 'failed' : okAt !== undefined ? 'ok' : 'never',
      }
    },
  }
}

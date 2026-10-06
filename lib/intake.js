// Archival of completed tasks and ingestion of new tasks from Gitea.
//
// Two complementary concerns in one module: one clears finished tasks from board,
// the other ingests new ones. Both govern WHAT belongs on the board.

/** Parse repository list from config: comma-separated, ignoring whitespace. */
export function parseWatchList(value) {
  return String(value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

/**
 * Repositories watched explicitly when named.
 *
 * Empty list means 'all', handled in intake pass where Gitea query lists all repos.
 *
 * @returns {Array<{owner: string, repo: string}>}
 */
export function watchedRepos({ config, owner }) {
  const out = []
  const seen = new Set()
  for (const name of parseWatchList(config?.watchRepos)) {
    // Name can be full or short: `owner/repo` or just `repo` using default owner.
    const at = name.indexOf('/')
    const pair = at > 0
      ? { owner: name.slice(0, at), repo: name.slice(at + 1) }
      : { owner, repo: name }
    if (pair.owner === undefined || pair.owner === '' || pair.repo === '') continue
    const key = `${pair.owner}/${pair.repo}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(pair)
  }
  return out
}

/**
 * Whether to create a card for this issue.
 *
 * @returns {{take: boolean, why: string}} `why` states reason on rejection.
 */
export function shouldTake({ store, owner, repo, issue }) {
  const number = issue?.number
  if (typeof number !== 'number') return { take: false, why: 'missing-number' }
  // Pull request in Gitea is also an issue, but not a standalone board card:
  // it reflects execution progress, not the task definition.
  if (issue?.pull_request !== undefined && issue?.pull_request !== null) {
    return { take: false, why: 'pull-request-ignored' }
  }
  if (issue?.state === 'closed') return { take: false, why: 'issue-closed' }
  if (store.findTaskByIssue({ owner, repo, issueNumber: number }) !== undefined) {
    return { take: false, why: 'already-exists' }
  }
  if (store.isDismissed({ owner, repo, issueNumber: number })) {
    return { take: false, why: 'tombstone-ignored' }
  }
  return { take: true, why: '' }
}

/**
 * Whether task is ready for archival.
 *
 * Archived ONLY from `done`. A task stuck in review for a month is an alert,
 * not clutter, and must not be hidden.
 *
 * Zero in settings disables auto-archival.
 */
export function archiveBefore({ now, afterDays }) {
  const days = Number(afterDays)
  if (!Number.isFinite(days) || days <= 0) return undefined
  return now - days * 24 * 60 * 60 * 1000
}

/**
 * Whether given repository is watched.
 *
 * Events outside watched list are ignored: timer does not poll them,
 * so webhooks should not process them either.
 */
export function isWatched({ config, owner, defaultOwner, repo }) {
  return watchedRepos({ config, owner: defaultOwner }).some(
    (pair) => pair.owner === owner && pair.repo === repo,
  )
}

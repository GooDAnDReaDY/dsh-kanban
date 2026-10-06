// Card auto-movement: derive column from observations and source priority.
// Pure module without network, storage, or harness dependencies.
// Observations arrive as data, verdicts return as values.

/**
 * Source priority.
 * Lower number indicates higher priority source.
 */
const PRIORITY = { gitea: 0, tool: 1, session: 2, manual: 3 }

/** Pull request is draft while marked with WIP prefix or draft flag. */
export function isDraftPull(pull) {
  if (pull?.draft === true) return true
  return /^\s*(wip|draft)\b[:\s-]/i.test(String(pull?.title ?? ''))
}

/**
 * Target column derived from forge observations.
 * Evaluated from latest lifecycle state to earliest.
 * WIP PR intentionally does NOT move card to review.
 * @param {object} obs observations
 * @param {object} [obs.issue] issue from Gitea (`state`)
 * @param {Array}  [obs.pulls] pull requests related to task
 * @param {boolean} [obs.branchExists] whether task branch exists
 * @returns {string|undefined} column or undefined if observations silent
 */
export function deriveColumn(obs) {
  const issueClosed = obs?.issue?.state === 'closed'
  const pulls = Array.isArray(obs?.pulls) ? obs.pulls : []
  const branchExists = obs?.branchExists === true

  // Task is finished only when cleanup is done: issue closed AND branch deleted.
  // Task is finished only when cleanup is done: issue closed AND branch deleted.
  if (issueClosed && !branchExists) return 'done'
  if (issueClosed) return 'cleanup'

  if (pulls.some((p) => p?.merged === true || p?.merged_at)) return 'deploy'
  if (pulls.some((p) => p?.state === 'open' && !isDraftPull(p))) return 'review'
  if (branchExists) return 'in-progress'
  return undefined
}

/**
 * Select candidate transition from multiple sources.
 *
 *
 * @param {string} current current column
 * @param {Array<{column: string, source: string, detail?: string}>} candidates
 * @returns {{column: string, source: string, detail: string}|undefined}
 */
export function resolveTransition(current, candidates) {
  const usable = (candidates ?? [])
    .filter((c) => c && typeof c.column === 'string' && c.column !== '' && c.column !== current)
    .filter((c) => PRIORITY[c.source] !== undefined)
  if (usable.length === 0) return undefined
  const best = usable.reduce((a, b) => (PRIORITY[a.source] <= PRIORITY[b.source] ? a : b))
  return { column: best.column, source: best.source, detail: best.detail ?? '' }
}

/**
 * Whether human intervention is required.
 *
 *
 * @returns {boolean|undefined} true - raise, false - clear, undefined - not applicable
 */
export function waitingFromEvent(type) {
  switch (type) {
    case 'approval/asked':
    case 'question/requested':
      return true
    case 'approval/decided':
    case 'turn/start':
    case 'user/message':
      return false
    default:
      return undefined
  }
}

/** Branch name identified for task: observed branch or undefined. */
export function branchOfTask(task, branches) {
  const known = typeof task?.branch === 'string' && task.branch !== '' ? task.branch : undefined
  const names = (branches ?? []).map((b) => (typeof b === 'string' ? b : b?.name)).filter(Boolean)
  if (known !== undefined) return names.includes(known) ? known : undefined

  // Agent creates branch matching workflow conventions with issue number.
  // Look up by issue number rather than fixed string template.
  if (typeof task?.issueNumber !== 'number') return undefined
  const marker = String(task.issueNumber)
  return names.find((n) => new RegExp(`(^|[^0-9])${marker}([^0-9]|$)`).test(n))
}

/** Pull requests related to task: matched by branch or issue reference. */
export function pullsOfTask(task, pulls, branch) {
  const number = typeof task?.issueNumber === 'number' ? task.issueNumber : undefined
  return (pulls ?? []).filter((p) => {
    if (branch !== undefined && p?.head?.ref === branch) return true
    if (number === undefined) return false
    const haystack = `${p?.title ?? ''} ${p?.body ?? ''}`
    return new RegExp(`#${number}([^0-9]|$)`).test(haystack)
  })
}

/**
 * Conflict resolution when both local and remote changed since last sync.
 * Rule: latest timestamp wins, and overridden side is reported in `overridden`
 * to record the conflict explicitly in task history.
 *
 * @param {object} state
 * @param {string} state.localColumn board column
 * @param {string} [state.remoteColumn] column derived from forge
 * @param {number} state.localUpdatedAt local update timestamp
 * @param {number} state.remoteUpdatedAt remote update timestamp
 * @param {number} state.syncedAt last successful sync timestamp
 * @returns {{winner: 'local'|'remote'|'none', column?: string, overridden?: string}}
 */
export function resolveConflict({ localColumn, remoteColumn, localUpdatedAt, remoteUpdatedAt, syncedAt }) {
  if (remoteColumn === undefined || remoteColumn === null || remoteColumn === '') return { winner: 'local' }
  if (remoteColumn === localColumn) return { winner: 'none' }

  const since = Number(syncedAt) || 0

  // Prior to first sync, 'changed since last time' has no prior baseline;
  // accept remote state initially.
  const firstSync = since === 0
  const localChanged = !firstSync && (Number(localUpdatedAt) || 0) > since
  const remoteChanged = firstSync || (Number(remoteUpdatedAt) || 0) > since

  if (localChanged && remoteChanged) {
    // Both sides modified: latest wins, overridden is recorded.
    if ((Number(localUpdatedAt) || 0) > (Number(remoteUpdatedAt) || 0)) {
      return { winner: 'local', overridden: remoteColumn }
    }
    return { winner: 'remote', column: remoteColumn, overridden: localColumn }
  }

  // Only board moved: remote sync does not pull card backward.
  if (localChanged) return { winner: 'local' }

  return { winner: 'remote', column: remoteColumn }
}

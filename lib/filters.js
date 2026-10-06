// Board filters: repository and label namespaces.
//
// Namespaces are dynamically collected from task cards rather than hardcoded,
// as Gitea labels may evolve independently without requiring code changes.

/** Repository filter sits alongside labels without requiring a label tag. */
export const REPO = 'repo'

/** Task author — filter dimension stored in its own field. */
export const AUTHOR = 'author'

/** Assignee: who is working on the task, distinct from author. */
export const ASSIGNEE = 'assignee'

/** Milestone assigned in Gitea. */
export const MILESTONE = 'milestone'

/** Priority — local board property and filter dimension. */
export const PRIORITY = 'priority'

/**
 * Value for tasks without an author.
 *
 * Local board tasks have no author. Keeping an explicit placeholder ensures
 * filtering covers all tasks rather than silently omitting authorless items.
 */
export const NO_AUTHOR = '—'

/**
 * Value for unassigned tasks.
 *
 * Filtering by unassigned is a primary board workflow for finding available work.
 */
export const NOBODY = '—'

/** Value for tasks not assigned to any milestone. */
export const NO_MILESTONE = '—'

/** Priority ordering in filter UI: urgent at the top. */
const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low']

/**
 * Preferred namespace ordering.
 *
 * Prioritizes type and urgency over raw alphabetical order. Unknown namespaces
 * are appended in alphabetical order.
 */
export const KNOWN_ORDER = ['type', 'priority', 'status', 'scope', 'risk', 'signal', 'release']

/** Split label into namespace and value; returns undefined if no slash delimiter. */
export function splitLabel(name) {
  const text = String(name ?? '')
  const at = text.indexOf('/')
  if (at <= 0 || at === text.length - 1) return undefined
  return { ns: text.slice(0, at), value: text.slice(at + 1) }
}

/**
 * Build available filter dimensions and value counts.
 *
 * Bare labels without a namespace (e.g. epic, hotfix) do not generate separate
 * filter groups; they remain visible on cards and searchable via text query.
 *
 * Counts are calculated across all provided tasks rather than currently filtered
 * tasks so the badge reflects the total pool size.
 *
 * @returns {Array<{ns: string, values: Array<{value: string, count: number}>}>}
 */
export function facetsOf(tasks) {
  const byNs = new Map()
  const add = (ns, value) => {
    if (value === '') return
    if (!byNs.has(ns)) byNs.set(ns, new Map())
    const values = byNs.get(ns)
    values.set(value, (values.get(value) ?? 0) + 1)
  }

  for (const task of tasks ?? []) {
    add(REPO, typeof task?.repo === 'string' ? task.repo : '')
    add(ASSIGNEE, typeof task?.assignee === 'string' && task.assignee !== '' ? task.assignee : NOBODY)
    add(MILESTONE, typeof task?.milestone === 'string' && task.milestone !== '' ? task.milestone : NO_MILESTONE)
    add(AUTHOR, typeof task?.author === 'string' && task.author !== '' ? task.author : NO_AUTHOR)
    // Priority lives both in task.priority and in priority/* label: merge into one dimension.
    add(PRIORITY, typeof task?.priority === 'string' ? task.priority : '')
    for (const name of task?.labels ?? []) {
      const parsed = splitLabel(name)
      if (parsed !== undefined) add(parsed.ns, parsed.value)
    }
  }

  return [...byNs.entries()]
    .map(([ns, values]) => ({
      ns,
      values: [...values.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => valueRank(ns, a.value) - valueRank(ns, b.value) || a.value.localeCompare(b.value)),
    }))
    .sort((a, b) => rank(a.ns) - rank(b.ns) || a.ns.localeCompare(b.ns))
}

/** Repository first, followed by known namespaces, then alphabetical. */
function rank(ns) {
  if (ns === REPO) return -3
  // Assignee precedes author: users look for active owner more frequently than creator.
  if (ns === ASSIGNEE) return -2
  // Milestone immediately follows assignee.
  if (ns === MILESTONE) return -1.5
  if (ns === AUTHOR) return -1
  const at = KNOWN_ORDER.indexOf(ns)
  return at === -1 ? KNOWN_ORDER.length : at
}

/**
 * Value ordering within a namespace.
 *
 * Priority uses urgency ordering (critical -> low); other namespaces use standard string comparison.
 */
function valueRank(ns, value) {
  if (ns !== PRIORITY) return 0
  const at = PRIORITY_ORDER.indexOf(value)
  return at === -1 ? PRIORITY_ORDER.length : at
}

/**
 * Check whether a task satisfies the active filter selection.
 *
 * AND between namespaces, OR within each namespace.
 *
 * @param {object} selected map of namespace -> array of selected values
 */
export function matchesFilters(task, selected) {
  for (const [ns, values] of Object.entries(selected ?? {})) {
    const wanted = values ?? []
    if (wanted.length === 0) continue
    if (!hasAny(task, ns, wanted)) return false
  }
  return true
}

function hasAny(task, ns, wanted) {
  if (ns === REPO) return wanted.includes(task?.repo ?? '')
  if (ns === ASSIGNEE) {
    const who = typeof task?.assignee === 'string' && task.assignee !== '' ? task.assignee : NOBODY
    return wanted.includes(who)
  }
  if (ns === MILESTONE) {
    const to = typeof task?.milestone === 'string' && task.milestone !== '' ? task.milestone : NO_MILESTONE
    return wanted.includes(to)
  }
  if (ns === AUTHOR) {
    const author = typeof task?.author === 'string' && task.author !== '' ? task.author : NO_AUTHOR
    return wanted.includes(author)
  }
  if (ns === PRIORITY) {
    // Check both field value and priority/* label.
    if (wanted.includes(typeof task?.priority === 'string' ? task.priority : '')) return true
    for (const name of task?.labels ?? []) {
      const parsed = splitLabel(name)
      if (parsed !== undefined && parsed.ns === PRIORITY && wanted.includes(parsed.value)) return true
    }
    return false
  }
  for (const name of task?.labels ?? []) {
    const parsed = splitLabel(name)
    if (parsed !== undefined && parsed.ns === ns && wanted.includes(parsed.value)) return true
  }
  return false
}

/** True if any filter value is currently selected. */
export function anySelected(selected) {
  return Object.values(selected ?? {}).some((values) => (values ?? []).length > 0)
}

/**
 * Toggle a single filter value.
 *
 * Returns a new object map for React state immutability.
 */
export function toggleValue(selected, ns, value) {
  const current = (selected ?? {})[ns] ?? []
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value]
  const out = { ...(selected ?? {}) }
  if (next.length === 0) delete out[ns]
  else out[ns] = next
  return out
}

/** Reset all active filters. */
export function clearFilters() {
  return {}
}

/**
 * Extract task labels grouped by namespace.
 *
 * Included on task payload so client bundle does not need to duplicate parsing logic.
 *
 * @returns {object} map of namespace -> array of values
 */
export function facetsOfTask(task) {
  const out = {}
  for (const name of task?.labels ?? []) {
    const parsed = splitLabel(name)
    if (parsed === undefined) continue
    if (out[parsed.ns] === undefined) out[parsed.ns] = []
    if (!out[parsed.ns].includes(parsed.value)) out[parsed.ns].push(parsed.value)
  }
  return out
}

/**
 * Validate hex color code from Gitea response.
 *
 * Accepts 6-character hex string with or without leading '#'.
 * Rejects invalid strings to prevent arbitrary values in CSS styles.
 *
 * @returns {string|undefined} lowercase 6-char hex code without '#'
 */
export function labelColor(value) {
  const text = String(value ?? '').trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : undefined
}

/**
 * Map label name -> hex color from issue labels.
 *
 * Stored separately from label names to keep name parsing and matching clean.
 */
export function colorsOfIssue(labels) {
  const out = {}
  for (const l of labels ?? []) {
    const name = typeof l === 'string' ? l : l?.name
    if (typeof name !== 'string' || name === '') continue
    const color = labelColor(typeof l === 'string' ? undefined : l?.color)
    if (color !== undefined) out[name] = color
  }
  return out
}

/**
 * Task rank for top-of-column sorting.
 *
 * Waiting tasks take precedence over running tasks because waiting items require user action.
 * Manual ordering within the same rank tier is preserved.
 */
export function liveRank(task) {
  const state = task?.state
  if (task?.waiting === true || state === 'waiting') return 0
  if (state === 'running') return 1
  if (state === 'stopped') return 2
  return 3
}

/** Priority weight for rank sorting: urgent precedes normal. */
function priorityWeight(priority) {
  const at = PRIORITY_ORDER.indexOf(priority)
  return at === -1 ? PRIORITY_ORDER.length : at
}

/**
 * Sort tasks by active state and priority while preserving relative manual order.
 *
 * Primary sort: lifecycle activity (waiting -> running -> stopped -> idle).
 * Secondary sort: urgency (critical -> low).
 * Tertiary sort: original array position.
 */
export function sortByLife(tasks) {
  return (tasks ?? [])
    .map((task, at) => ({ task, at }))
    .sort((a, b) => liveRank(a.task) - liveRank(b.task)
      || priorityWeight(a.task?.priority) - priorityWeight(b.task?.priority)
      || a.at - b.at)
    .map((x) => x.task)
}

/**
 * Group tasks by repository.
 *
 * Larger groups are placed first to keep active projects visible.
 * Tied group sizes are sorted alphabetically by repo name.
 *
 * @returns {Array<{repo: string, tasks: Array<object>}>}
 */
export function groupByRepo(tasks) {
  const byRepo = new Map()
  for (const task of tasks ?? []) {
    const repo = typeof task?.repo === 'string' && task.repo !== '' ? task.repo : ''
    if (!byRepo.has(repo)) byRepo.set(repo, [])
    byRepo.get(repo).push(task)
  }
  return [...byRepo.entries()]
    .map(([repo, list]) => ({ repo, tasks: list }))
    .sort((a, b) => b.tasks.length - a.tasks.length || a.repo.localeCompare(b.repo))
}

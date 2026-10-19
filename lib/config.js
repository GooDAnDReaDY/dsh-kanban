// Pure configuration logic: defaults, column ordering, and field accessors.
// Zero dependencies: tested without harness, network, or core packages.
// Cordis bindings reside in `lib/index.js`.
//
// Client settings API writes scalar values only; complex options are decomposed
// into individual scalar settings.

/**
 * Column order mirrors the actual workflow.
 * `cleanup` column exists because a task is not done until remote branch,
 * worktree, and local branch are cleaned up and recorded in issue comment.
 */
export const COLUMN_ORDER = ['backlog', 'in-progress', 'review', 'deploy', 'cleanup', 'done']

/**
 * Column sets per board kind.
 *
 *
 */
export const BOARD_KINDS = ['project', 'simple']

/** Default board kind fallback. */
const DEFAULT_KIND = 'project'

const COLUMNS_BY_KIND = {
  project: COLUMN_ORDER,
  simple: ['backlog', 'in-progress', 'review', 'done'],
}

/** Board columns. Unknown kind defaults to project board. */
export function columnsOf(kind) {
  return COLUMNS_BY_KIND[kind] ?? COLUMNS_BY_KIND[DEFAULT_KIND]
}

/** Coerce board kind to supported value. */
export function normalizeKind(kind) {
  return BOARD_KINDS.includes(kind) ? kind : DEFAULT_KIND
}

/** Initial boards seeded on first run. */
export const DEFAULT_BOARDS = [
  { id: 'main', title: 'Project Board', kind: 'project' },
  { id: 'simple', title: 'Simple Board', kind: 'simple' },
]

/** Default settings values used in schema. */
export const CONFIG_DEFAULTS = {
  gitProvider: 'auto',
  giteaUrl: '',
  giteaTokenRef: 'GITEA_TOKEN',
  githubTokenRef: 'GITHUB_TOKEN',
  defaultProjectRoot: '',
  startPrompt: '',
  replyInstruction: '',
  wipInProgress: 3,
  wipReview: 0,
  syncIntervalSec: 120,
  staleAfterMin: 60,
  giteaOwner: '',
  githubOwner: '',
  columnNames: '',
  watchRepos: '',
  archiveAfterDays: 7,
  boardToolEnabled: false,
  webhookSecretRef: '',
  githubWebhookSecretRef: '',
  pushToGitea: true,
  worktreeIsolation: true,
  worktreeRoot: '',
  cronEnabled: false,
  preventIdleSleep: false,
  progressDumpEnabled: false,
  permissionGateEnabled: false,
  sessionDefaultPermission: 'read-only',
  announceToAgent: true,
  maxConcurrentSessions: 3,
  workspaceClaimBoundaries: true,
  autoSyncSessions: false,
  verificationGateEnabled: true,
  verificationCommand: 'npm test',
  verificationTimeoutMs: 120000,
  costMeterEnabled: true,
  taskCostLimit: 0,
}

/** Field descriptions reused in schema and settings card. */
export const CONFIG_HINTS = {
  gitProvider: 'Active Git forge: "auto" (detect by credentials), "gitea", or "github".',
  giteaUrl: 'Gitea or Forgejo instance URL, e.g. https://gitea.example.com. Empty disables import.',
  giteaTokenRef: 'Name of DSH credential holding the access token. Do not enter raw token.',
  githubTokenRef: 'Name of DSH credential holding GitHub Personal Access Token or App token. Do not enter raw token.',
  defaultProjectRoot: 'Directory containing project repositories. Empty uses harness working directory.',
  startPrompt: 'Template for initial message to agent session. Empty uses built-in default.',
  replyInstruction: 'Instruction appended to initial message (e.g. language/format constraints). Empty adds nothing.',
  wipInProgress: 'Maximum task cards allowed in "In Progress" column. 0 means unlimited.',
  wipReview: 'Maximum task cards allowed in "Review" column. 0 means unlimited.',
  syncIntervalSec: 'Interval in seconds for polling Gitea synchronization. 0 disables polling.',
  staleAfterMin: 'Minutes of inactivity before active task session is flagged stale. 0 disables.',
  giteaOwner: 'Default Gitea organization/user to track. Auto-detected if single organization.',
  githubOwner: 'Default GitHub user or organization to track. Empty uses the authenticated user.',
  columnNames: 'Custom column title mappings as "id=Name" pairs comma-separated.',
  watchRepos: 'Filter sync to specific repository names comma-separated. Empty watches all repos.',
  archiveAfterDays: 'Days completed tasks remain before automatic archiving. 0 disables.',
  boardToolEnabled: 'Allow autonomous agent to advance cards via board_move tool.',
  webhookSecretRef: 'Name of DSH credential holding Gitea webhook secret.',
  githubWebhookSecretRef: 'Name of DSH credential holding GitHub webhook secret (HMAC-SHA256).',
  pushToGitea: 'Automatically close corresponding Gitea issue when card moves to Done.',
  worktreeIsolation: 'Isolate task sessions in dedicated git worktrees to prevent workspace collisions.',
  worktreeRoot: 'Custom root directory for task worktrees. Empty defaults to $DSH_HOME/worktrees.',
  cronEnabled: 'Enable background scheduled task execution via cron expressions.',
  preventIdleSleep: 'Prevent host sleep while task agent sessions are running.',
  progressDumpEnabled: 'Enable PROGRESSDUMP state checkpoints between agent sessions.',
  permissionGateEnabled: 'Require human confirmation before launching elevated permission tasks.',
  sessionDefaultPermission: 'Default permission tier for task sessions (read-only, workspace-write, danger-full-access).',
  announceToAgent: 'Inject board instructions and handover guidance into the agent system prompt.',
  maxConcurrentSessions: 'Maximum number of simultaneous active agent sessions on the board.',
  workspaceClaimBoundaries: 'Enforce workspace ownership boundaries to prevent cross-workspace task execution.',
  autoSyncSessions: 'Automatically sync and attach live background agent sessions to cards.',
  verificationGateEnabled: 'Run automated verification gate (e.g. npm test) before allowing cards to move to Review.',
  verificationCommand: 'Default verification command to execute in task worktree before Review (default: npm test).',
  verificationTimeoutMs: 'Timeout in milliseconds for verification gate execution (default: 120000).',
  costMeterEnabled: 'Enable token and cost telemetry integration via @goodandready/dsh-cost-meter.',
  taskCostLimit: 'Cost threshold per task in USD; 0 disables threshold warnings.',
}

/** Setting key for column WIP limit; not all columns have limits. */
const WIP_FIELD = {
  'in-progress': 'wipInProgress',
  'review': 'wipReview',
}

/**
 * Effective project root: configured value or harness working directory.
 * @param {object} config effective configuration
 * @param {() => string} [cwdOf] working directory getter
 * @returns {{path: string, set: boolean}} path and whether explicitly configured
 */
export function rootOf(config, cwdOf = () => process.cwd()) {
  const named = String(config?.defaultProjectRoot ?? '').trim()
  return named !== '' ? { path: named, set: true } : { path: cwdOf(), set: false }
}

/**
 * Apply defaults to raw settings. Invalid types fallback to default.
 * @param {object} [raw] raw configuration
 * @returns {object} validated scalar settings
 */
export function withDefaults(raw) {
  const out = {}
  for (const [key, fallback] of Object.entries(CONFIG_DEFAULTS)) {
    let value = raw?.[key]
    if (value && typeof value === 'object' && typeof value.get === 'function') {
      try {
        value = value.get()
      } catch { /* ignore */ }
    }
    out[key] = typeof value === typeof fallback && value !== null ? value : fallback
  }
  return out
}

/**
 * Column card limit. Zero and absent setting both return undefined.
 * @param {object} config effective configuration
 * @param {string} column column identifier
 * @returns {number|undefined} limit or undefined
 */
export function wipLimitField(config, column) {
  const field = WIP_FIELD[column]
  if (field === undefined) return undefined
  const value = config?.[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

/**
 * Custom column labels from settings.
 * Format: comma-separated `id=Name` pairs.
 */
export function columnNamesOf(config) {
  const out = {}
  for (const pair of String(config?.columnNames ?? '').split(',')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const id = pair.slice(0, at).trim()
    const name = pair.slice(at + 1).trim()
    if (id !== '' && name !== '') out[id] = name
  }
  return out
}

/**
 * Build prompt section text based on enabled board features.
 * Returns null if no features requiring agent guidance are active.
 *
 * @param {object} cfg configuration
 * @returns {string|null}
 */
export function buildPromptSectionText(cfg) {
  if (cfg?.announceToAgent === false) return null
  const parts = []
  if (cfg?.boardToolEnabled === true) {
    parts.push(
      'The dsh-kanban task board is available in the system. When working on tasks, you can move cards using the board_move tool and manage the plan checklist via board_plan.'
    )
  }
  if (cfg?.progressDumpEnabled === true) {
    parts.push(
      'When context is running low or a milestone is reached, output a <<<PROGRESSDUMP\nGoal: ...\nProgress: ...\nNext steps: ...\n>>>PROGRESSDUMP block to hand over to the next session.'
    )
  }
  return parts.length > 0 ? parts.join(' ') : null
}

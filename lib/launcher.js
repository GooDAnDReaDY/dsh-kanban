// Task execution launcher: dedicated agent session with chosen model.
//
// The plugin does not prepare branches or worktrees in advance: the agent conducts
// preflight first to check existing worktrees and branch status before branching from origin/main.
// Pre-creating branches would interfere with preflight validation.
//
// The agent writes the start comment on the issue after preflight, as branch
// and plan are determined during preflight.
//
// Core packages are not imported directly; session ID and message factory
// are passed as parameters to support unit testing without harness runtime.

import { isAbsolute, join, resolve, sep } from 'node:path'
import { formatPlanPrompt } from './plan-generator.js'
import { randomUUID } from 'node:crypto'
import { createTaskWorktree, registerDshWorkspace, isGitRepo } from './worktree.js'
import { formatHandoverPreamble, parseProgressDump } from './progress-dump.js'

export const PERMISSION_RANKS = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

const activeReservations = new Set()

export function reserveSessionSlot(taskId) {
  if (taskId) activeReservations.add(taskId)
}

export function releaseSessionSlot(taskId) {
  if (taskId) activeReservations.delete(taskId)
}

export function verifyPermissionGate({ task, permission, config }) {
  if (!config?.permissionGateEnabled) return
  const perm = permission || task?.permission || config?.sessionDefaultPermission || 'read-only'
  const defaultPerm = config?.sessionDefaultPermission || 'read-only'
  const permRank = PERMISSION_RANKS[perm] ?? Infinity
  const defaultRank = PERMISSION_RANKS[defaultPerm] ?? 0
  const confirmedTier = task?.permissionConfirmedTier || (task?.permissionConfirmedAt ? task?.permission : undefined)
  const confirmedRank = confirmedTier ? (PERMISSION_RANKS[confirmedTier] ?? -1) : -1

  if (permRank > defaultRank && permRank > confirmedRank) {
    const err = new Error('Permission confirmation required')
    err.key = 'permission-unconfirmed'
    err.status = 403
    throw err
  }
}

/**
 * Tail instructions for local board tasks.
 *
 * Local tasks cover ad-hoc activities where repo preflight and branch creation
 * may not apply. The agent evaluates task context rather than forcing repo workflows.
 */
const OWN_TAIL = 'If the task is about project code, follow its workflow; '
  + 'if not, just perform what is written above.'

/** Tail instructions for workflow tasks backed by a Gitea issue. */
const WORKFLOW_TAIL = [
  'Follow active project workflow: first preflight open branches and',
  'worktrees, then worktree from fresh origin/main, initial issue comment',
  'with plan and checks, then implementation.',
].join('\n')

/**
 * Initial message prompt for a task.
 *
 * Does not instruct the agent to use a specific branch name; the agent selects
 * branch naming following project workflow after preflight.
 *
 * @param {object} task board task
 * @param {object} config plugin settings
 * @returns {string} prompt message body
 */
export function buildStartMessage(task, config) {
  const vars = {
    repo: task?.repo ?? '',
    issueNumber: typeof task?.issueNumber === 'number' ? String(task.issueNumber) : '',
    title: task?.title ?? '',
    body: task?.body ?? '',
    issueUrl: task?.issueUrl ?? '',
  }

  const note = typeof config?.replyInstruction === 'string' ? config.replyInstruction.trim() : ''

  const custom = typeof config?.startPrompt === 'string' ? config.startPrompt.trim() : ''
  if (custom !== '') return joinBlocks([substitute(custom, vars), note])

  // Issue tasks and local board tasks use distinct prompt layouts.
  const fromIssue = vars.repo !== '' && vars.issueNumber !== ''
  const head = fromIssue
    ? `Task ${vars.repo}#${vars.issueNumber}: ${vars.title}`
    : `Task: ${vars.title}`

  const planBlock = formatPlanPrompt(task)

  return joinBlocks([
    head,
    vars.body,
    fromIssue && vars.issueUrl !== '' ? `Link: ${vars.issueUrl}` : '',
    planBlock,
    fromIssue ? WORKFLOW_TAIL : OWN_TAIL,
    note,
  ])
}

/** Join non-empty blocks with double newlines. */
function joinBlocks(parts) {
  return parts.map((p) => String(p ?? '').trim()).filter(Boolean).join('\n\n')
}

function substitute(template, vars) {
  let text = template
  for (const [name, value] of Object.entries(vars)) {
    text = text.split(`{${name}}`).join(value)
  }
  return text
}

/**
 * Working directory for session — root checkout of the project, not a worktree.
 *
 * Root checkout is read-only per workflow guidelines; preflight checks run here.
 * Path traversal outside project root is rejected.
 *
 * @throws if root is not absolute or repository path escapes project root fence
 */
export function resolveCwd(task, config, cwdOf = () => process.cwd()) {
  const root = typeof config?.defaultProjectRoot === 'string' && config.defaultProjectRoot.trim() !== ''
    ? config.defaultProjectRoot.trim()
    : cwdOf()
  if (!isAbsolute(root)) throw new Error('project root must be an absolute path')

  const repo = typeof task?.repo === 'string' ? task.repo.trim() : ''
  if (repo === '') return root

  const target = resolve(join(root, repo))
  const fence = resolve(root)
  const fenceSep = fence.endsWith(sep) || fence.endsWith('/') ? fence : fence + sep
  if (target !== fence && !target.startsWith(fenceSep) && !target.startsWith(fence.endsWith('/') ? fence : fence + '/')) {
    throw new Error('repository name escapes project root')
  }
  return target
}

/**
 * Retrieve agent for task: active, resumed, or newly spawned.
 *
 * Enforces one chat session per task. Reuses existing session when possible.
 */
export function applyPermission({ permissions, agent, name }) {
  if (typeof name !== 'string' || name === '') return { skipped: 'not-picked' }
  // Permission service is optional. If permission level is selected but service
  // is unavailable, execution fails rather than running with broader default permissions.
  if (permissions === undefined || typeof permissions.set !== 'function') {
    return { error: 'permission-unavailable' }
  }
  try {
    permissions.set(agent.session, name)
    return { applied: name }
  } catch (error) {
    return { error: 'permission-refused', reason: error?.message }
  }
}

export async function obtainAgent({
  agents, task, config, provider, model, mintSessionId, cwdOf, logger,
  agentPreset, permission, permissions, gitRunner, workspaceRegistry,
  reasoningEffort,
}) {
  const chosenPerm = permission || task?.permission || config?.sessionDefaultPermission || ""
  const effort = reasoningEffort || task?.reasoningEffort || undefined
  const agentOptions = { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }

  const known = typeof task?.sessionId === 'string' && task.sessionId !== '' ? task.sessionId : undefined

  if (known !== undefined) {
    // Live agent — reuse active session.
    let live
    try { live = agents.get(known) } catch { live = undefined }
    if (live !== undefined) {
      const access = applyPermission({ permissions, agent: live, name: chosenPerm })
      if (access.error !== undefined) {
        const error = new Error('access tier not set')
        error.key = access.error
        error.status = 409
        throw error
      }
      return { agent: live, sessionId: known, mode: 'opened' }
    }

    // Session suspended; attempt resume.
    try {
      const handle = await agents.resume({ resumeSessionId: known, agentOptions })
      const access = applyPermission({ permissions, agent: handle.agent, name: chosenPerm })
      if (access.error !== undefined) {
        const error = new Error('access tier not set')
        error.key = access.error
        error.status = 409
        throw error
      }
      return { agent: handle.agent, sessionId: handle.agent.session.id, mode: 'resumed' }
    } catch (error) {
      if (error?.key === 'permission-refused' || error?.key === 'permission-unavailable' || error?.status === 409) {
        throw error
      }
      logger?.warn?.(`dsh-kanban: session ${known} resume failed: ${error?.message}`)
    }
  }

  let cwd = resolveCwd(task, config, cwdOf)
  const projectRoot = cwd
  let worktreePath = task?.worktree || undefined
  let branchName = task?.branch || undefined
  let workspaceId = task?.workspaceId || undefined
  let worktreeCreated = false

  let isGit = false
  try {
    isGit = await isGitRepo(cwd, gitRunner)
  } catch (err) {
    if (config?.worktreeIsolation !== false) {
      const error = new Error(`worktree-creation-failed: git probe failed: ${err?.message || err}`)
      error.key = 'worktree-creation-failed'
      error.status = 500
      throw error
    }
  }
  if (config?.worktreeIsolation !== false && isGit) {
    let created
    try {
      created = await createTaskWorktree({
        task,
        repoDir: cwd,
        config,
        gitRunner,
        cwdOf,
      })
    } catch (err) {
      const error = new Error(`worktree-creation-failed: ${err.message}`)
      error.key = 'worktree-creation-failed'
      error.status = 500
      throw error
    }

    if (!created?.worktreePath) {
      const error = new Error('worktree-creation-failed')
      error.key = 'worktree-creation-failed'
      error.status = 500
      throw error
    }

    worktreePath = created.worktreePath
    branchName = created.branchName
    worktreeCreated = created.created === true

    if (workspaceRegistry) {
      workspaceId = await registerDshWorkspace({
        workspaceRegistry,
        worktreePath,
        title: `${task.owner ? task.owner + '/' : ''}${task.repo}#${task.issueNumber || task.id.slice(0, 8)}: ${task.title}`,
      })
    }
  }

  // meta.cwd preserves projectRoot so DSH groups session under the project (#227)
  const meta = { cwd: projectRoot, projectRoot }
  if (worktreePath) meta.worktreePath = worktreePath
  if (branchName) meta.branch = branchName
  if (typeof agentPreset === 'string' && agentPreset !== '') meta.agentPreset = agentPreset
  if (workspaceId) meta.workspaceId = workspaceId

  const handle = await agents.create({
    sessionId: mintSessionId(),
    // Profile is set during session creation.
    meta,
    agentOptions,
  })
  const access = applyPermission({ permissions, agent: handle.agent, name: chosenPerm })
  if (access.error !== undefined) {
    // Session already initialized; preserve configured permissions.
    try { handle.dispose?.() } catch { /* cleanup is secondary to rejection */ }
    logger?.warn?.(`dsh-kanban: access tier not set: ${access.reason ?? access.error}`)
    const error = new Error('access tier not set')
    error.key = access.error
    error.status = 409
    throw error
  }
  return {
    agent: handle.agent,
    sessionId: handle.agent.session.id,
    mode: 'created',
    worktree: worktreePath,
    branch: branchName,
    workspaceId,
    worktreeCreated,
  }
}

/**
 * Launch or resume task execution.
 *
 * Order of operations: acquire agent, wait for idle, send prompt, then update store.
 * Prevents leaving orphaned in-progress cards if agent launch fails.
 * Column moves from backlog to in-progress only on initial launch. Resumed tasks
 * retain their current column (e.g. review).
 *
 * @param {string} [text] user message; defaults to standard template if empty
 * @returns {{sessionId: string, mode: string, task: object}}
 */
/**
 * Mode explanation for task continuation: opened, resumed, or created.
 *
 * @returns {'opened'|'resumed'|'created'} matching obtainAgent mode
 */
export function revivalKind(mode) {
  return mode === 'opened' || mode === 'resumed' ? mode : 'created'
}

/**
 * Claim task upon launch if currently unassigned.
 * Does not overwrite existing assignee.
 *
 * @returns {string} assignee login if claimed; otherwise empty string
 */
export function claimOnStart({ store, task, login }) {
  const who = typeof login === 'string' ? login.trim() : ''
  if (who === '') return ''
  if (typeof task?.assignee === 'string' && task.assignee !== '') return ''
  store.updateTask(task.id, { assignee: who })
  store.addTransition({
    taskId: task.id,
    fromCol: task.column,
    toCol: task.column,
    source: 'manual',
    detail: `assigned: ${who} (claimed on launch)`,
  })
  return who
}

export async function runTask({
  agents, store, task, config, provider, model,
  mintSessionId, createMessage, cwdOf, logger, text,
  agentPreset, permission, permissions, claimAs,
  gitRunner, workspaceRegistry, resume = false, reasoningEffort,
}) {
  const effort = reasoningEffort || task?.reasoningEffort || undefined

  // Gate check must reject unconfirmed elevated tasks before queueing or state changes (#328)
  verifyPermissionGate({ task, permission, config })

  // Concurrency limit check (#214, #330)
  const maxConcurrent = typeof config?.maxConcurrentSessions === 'number' ? config.maxConcurrentSessions : 3
  if (maxConcurrent > 0) {
    const activeCount = countActiveSessions({ store, agents })
    // Check active session slots if task is not already running
    const isAlreadyRunning = task.sessionId && agents?.get?.(task.sessionId)?.status === 'running'
    if (!isAlreadyRunning && activeCount >= maxConcurrent) {
      const now = Date.now()
      store.updateTask(task.id, {
        queuedAt: task.queuedAt > 0 ? task.queuedAt : now,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(permission ? { permission } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        queuedRequest: JSON.stringify({
          provider, model, permission, reasoningEffort: effort, agentPreset, text,
        }),
      })
      store.addTransition({
        taskId: task.id,
        fromCol: task.column,
        toCol: task.column,
        source: 'session',
        detail: `concurrent session limit reached (${activeCount}/${maxConcurrent}), task queued`,
      })
      return { mode: 'queued', queued: true, taskId: task.id, activeCount, maxConcurrent }
    }
  }

  reserveSessionSlot(task.id)
  let taken
  try {
    taken = await obtainAgent({
      agents, task, config, provider, model, mintSessionId, cwdOf, logger,
      agentPreset, permission, permissions, gitRunner, workspaceRegistry,
      reasoningEffort: effort,
    })

  if (task.queuedAt > 0 || task.queuedRequest) {
    store.updateTask(task.id, { queuedAt: 0, queuedRequest: '' })
  }

  // Record run in task execution history
  if (typeof store.recordTaskRun === 'function') {
    store.recordTaskRun(task.id, {
      id: randomUUID(),
      sessionId: taken.sessionId,
      startedAt: Date.now(),
      model,
      provider,
    })
  }

  await taken.agent.whenIdle()
  taken.agent.followup(createMessage({
    // Content must be an array of blocks for core message schema.
    content: [{ type: 'text', text: messageFor(task, config, text, { resume, mode: taken.mode }) }],
    source: { kind: 'dsh-kanban', plugin: 'dsh-kanban', form: resume ? 'task-resume' : 'task-start' },
  }))

  const before = store.getTask(task.id)
  const patch = {
    sessionId: taken.sessionId,
    provider,
    model,
    ...(permission ? { permission } : {}),
    ...(taken.worktree ? { worktree: taken.worktree } : {}),
    ...(taken.branch ? { branch: taken.branch } : {}),
    ...(taken.workspaceId ? { workspaceId: taken.workspaceId } : {}),
  }
  store.updateTask(task.id, patch)
  // Claim task on launch if unassigned.
  claimOnStart({ store, task: before, login: claimAs })

  if (resume) {
    store.addTransition({
      taskId: task.id,
      fromCol: before.column,
      toCol: before.column,
      source: 'session',
      detail: `continuing task execution (session ${taken.sessionId})`,
    })
  }

  // Record worktree isolation transition in task log.
  if (taken.worktreeCreated) {
    store.addTransition({
      taskId: task.id,
      fromCol: before.column,
      toCol: before.column,
      source: 'session',
      detail: `isolation: created worktree ${taken.worktree} (${taken.branch})`,
    })
  }

  // Log notice if unable to resume previous session and new session had to be spawned.
  if (taken.mode === 'created' && before.sessionId) {
    store.addTransition({
      taskId: task.id,
      fromCol: before.column,
      toCol: before.column,
      source: 'session',
      detail: `previous session not resumed, spawned new: ${taken.sessionId}`,
    })
  }

  let current = store.getTask(task.id)
  if (taken.mode === 'created' && before.column === 'backlog') {
    current = store.moveTask(task.id, { column: 'in-progress' })
    store.addTransition({
      taskId: task.id,
      fromCol: before.column,
      toCol: 'in-progress',
      source: 'session',
      detail: `session ${taken.sessionId}, model ${model}`,
    })
  }

  return { sessionId: taken.sessionId, mode: revivalKind(taken.mode), task: current }
  } finally {
    releaseSessionSlot(task.id)
  }
}

/** Build prompt text: custom user message if provided, otherwise standard template. */
export function messageFor(task, config, text, options = {}) {
  const own = typeof text === 'string' ? text.trim() : ''
  let base = own !== '' ? own : buildStartMessage(task, config)
  let resumePreamble = ''
  if (options.resume || options.mode === 'resumed') {
    const wt = task?.worktree ? ` in existing worktree ${task.worktree}` : ''
    const br = task?.branch ? ` on branch ${task.branch}` : ''
    resumePreamble = `### ↻ Resumed task execution\nContinuing work${wt}${br}. Preserve existing changes and proceed from the current state.\n\n`
  }
  let qualityNotes = ''
  if (task?.rejectReason) {
    qualityNotes += `### ⚠️ Notice: Task returned for rework\nReview notes (rejection reason):\n${task.rejectReason}\n\n`
  }
  if (Array.isArray(task?.checklist) && task.checklist.length > 0) {
    const uncompleted = task.checklist.filter((i) => i.required !== false && !i.completed)
    if (uncompleted.length > 0) {
      qualityNotes += `### Definition of Done (DoD):\n`
        + uncompleted.map((item, idx) => `${idx + 1}. [ ] ${item.text}`).join('\n')
        + `\nUse the board_checklist(item, evidence) tool to record completed items.\n\n`
    }
  }
  if (qualityNotes) {
    base = qualityNotes + base
  }
  if (resumePreamble) {
    base = resumePreamble + base
  }
  if (config?.progressDumpEnabled && task.progressDump) {
    let parsed
    try {
      parsed = typeof task.progressDump === 'string' && task.progressDump.startsWith('{')
        ? JSON.parse(task.progressDump)
        : parseProgressDump(task.progressDump)?.dump
    } catch {
      parsed = parseProgressDump(task.progressDump)?.dump
    }
    const preamble = formatHandoverPreamble(parsed)
    if (preamble) return `${preamble}${base}`
  }
  return base
}

/**
 * Resolve provider and model for launch: user choice first, then harness default.
 */
export function resolveModel({ requested, fallback }) {
  const provider = requested?.provider || fallback?.provider
  const model = requested?.model || fallback?.model
  if (!provider || !model) return { error: 'model-not-selected', status: 409 }
  return { provider, model }
}

/**
 * Message prompt for an individual task in a batch execution.
 */
export function buildQueuedMessage(task, config, at, total) {
  const body = buildStartMessage(task, config)
  return total > 1 ? joinBlocks([`Task ${at} of ${total}.`, body]) : body
}

/**
 * Launch a batch of tasks within a single session, processed sequentially.
 * Only the first task transitions to 'in-progress'; remaining tasks are queued.
 */
export async function runBatch({
  agents, store, tasks, config, provider, model,
  mintSessionId, createMessage, cwdOf, logger, text, now = Date.now(),
  agentPreset, permission, permissions, claimAs,
}) {
  const list = (tasks ?? []).filter((task) => task !== undefined)
  if (list.length === 0) return { error: 'nothing-picked', status: 400 }

  for (const t of list) {
    verifyPermissionGate({ task: t, permission, config })
  }

  const maxConcurrent = typeof config?.maxConcurrentSessions === 'number' ? config.maxConcurrentSessions : 3
  if (maxConcurrent > 0) {
    const activeCount = countActiveSessions({ store, agents })
    if (activeCount >= maxConcurrent) {
      const err = new Error('concurrent-limit-reached')
      err.key = 'concurrent-limit-reached'
      err.status = 429
      throw err
    }
  }

  reserveSessionSlot(list[0].id)
  let taken
  try {
    taken = await obtainAgent({
      agents, task: list[0], config, provider, model, mintSessionId, cwdOf, logger,
      agentPreset, permission, permissions,
    })

  await taken.agent.whenIdle()
  const own = typeof text === 'string' ? text.trim() : ''
  const send = (body, form) => taken.agent.followup(createMessage({
    content: [{ type: 'text', text: body }],
    source: { kind: 'dsh-kanban', plugin: 'dsh-kanban', form },
  }))

  if (own !== '' && list.length === 1) {
    await send(own, 'task-start')
  } else {
    for (let at = 0; at < list.length; at++) {
      await send(buildQueuedMessage(list[at], config, at + 1, list.length), 'batch-queued')
    }
  }

  const started = []
  list.forEach((task, at) => {
    const before = store.getTask(task.id)
    if (before === undefined) return
    // First task moves to in-progress; remainder are queued with staggered queuedAt.
    const patch = { sessionId: taken.sessionId, provider, model, queuedAt: at === 0 ? 0 : now + at }
    store.updateTask(task.id, patch)
    // Claim all tasks in batch under launching user.
    claimOnStart({ store, task: before, login: claimAs })
    if (at === 0 && before.column === 'backlog') {
      store.moveTask(task.id, { column: 'in-progress' })
      store.addTransition({
        taskId: task.id, fromCol: before.column, toCol: 'in-progress', source: 'session',
        detail: list.length > 1
          ? `session ${taken.sessionId} for ${list.length} tasks, model ${model}`
          : `session ${taken.sessionId}, model ${model}`,
      })
    } else if (at > 0) {
      store.addTransition({
        taskId: task.id, fromCol: before.column, toCol: before.column, source: 'session',
        detail: `in session queue ${taken.sessionId}, ${at + 1} of ${list.length}`,
      })
    }
    started.push(task.id)
  })

  return { sessionId: taken.sessionId, mode: taken.mode, started: started.length, tasks: started }
  } finally {
    releaseSessionSlot(list[0].id)
  }
}

/**
 * Queue a task to an active session using core followup queue.
 */
export async function queueTask({
  agents, store, task, sessionId, config, createMessage, text, now = Date.now(),
}) {
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '') return { error: 'session-required', status: 400 }

  let agent
  try { agent = agents.get(id) } catch { agent = undefined }
  // Reject queueing to dead or non-existent session.
  if (agent === undefined) return { error: 'session-not-live', status: 409 }

  const own = typeof text === 'string' ? text.trim() : ''
  agent.followup(createMessage({
    content: [{ type: 'text', text: own !== '' ? own : buildStartMessage(task, config) }],
    source: { kind: 'dsh-kanban', plugin: 'dsh-kanban', form: 'task-queued' },
  }))

  const before = store.getTask(task.id)
  store.updateTask(task.id, { sessionId: id, queuedAt: now })
  store.addTransition({
    taskId: task.id, fromCol: before.column, toCol: before.column, source: 'session',
    detail: `queued for session ${id}`,
  })
  return { task: store.getTask(task.id), sessionId: id }
}

/**
 * Remove task from queue.
 * Clears queue association in store and logs note that message was already sent to agent.
 */
export function unqueueTask({ store, task }) {
  if (task === undefined) return { error: 'task-not-found', status: 404 }
  if (typeof task.queuedAt !== 'number' || task.queuedAt <= 0) {
    return { error: 'task-not-queued', status: 400 }
  }
  store.updateTask(task.id, { queuedAt: 0, sessionId: null, queuedRequest: '' })
  store.addTransition({
    taskId: task.id, fromCol: task.column, toCol: task.column, source: 'manual',
    detail: 'removed from queue; message already sent to agent',
  })
  return { task: store.getTask(task.id) }
}

/**
 * Query active sessions eligible for queueing.
 */
export function countActiveSessions({ store, agents }) {
  const sessions = liveSessions({ store, agents })
  const activeCount = sessions.filter((s) =>
    s.status === 'running' ||
    s.status === 'busy' ||
    s.status === 'thinking' ||
    s.tasks.some((t) => t.workflowActive)
  ).length
  return activeCount + activeReservations.size
}

export function liveSessions({ store, agents }) {
  const byId = new Map()
  let all = []
  if (typeof store?.listBoards === 'function' && typeof store?.listTasks === 'function') {
    const boards = store.listBoards() || []
    all = boards.flatMap((b) => store.listTasks({ board: b.id }) || [])
  } else if (typeof store?.listTasks === 'function') {
    all = store.listTasks() || []
  } else if (typeof store?.listInColumn === 'function') {
    all = store.listInColumn('in-progress') || []
  } else if (Array.isArray(store?.tasks)) {
    all = store.tasks
  }
  for (const task of all) {
    const id = typeof task.sessionId === 'string' ? task.sessionId : ''
    if (id === '') continue
    let live
    try { live = agents.get(id) } catch { live = undefined }
    if (live === undefined) continue
    // Exclude child subagent sessions (#215)
    if (live.origin === 'subagent' || live.parentId !== undefined || live.meta?.origin === 'subagent' || live.isSubagent) {
      continue
    }
    const isWorkflowActive = task.workflowStatus === 'running' || (typeof task.workflowRunId === 'string' && task.workflowRunId !== '' && task.workflowStatus !== 'completed' && task.workflowStatus !== 'failed' && task.workflowStatus !== 'cancelled')
    if (!byId.has(id)) byId.set(id, { sessionId: id, status: live.status, tasks: [] })
    byId.get(id).tasks.push({
      id: task.id, title: task.title, repo: task.repo, issueNumber: task.issueNumber,
      queued: typeof task.queuedAt === 'number' && task.queuedAt > 0,
      workflowActive: isWorkflowActive,
    })
  }
  return [...byId.values()]
}

/**
 * Auto-dispatch next queued task when a concurrency slot opens (#214).
 */
export async function dispatchNextQueuedTask({
  agents, store, config, mintSessionId, createMessage, cwdOf, logger,
  agentPreset, permissions, workspaceRegistry, claimAs, gitRunner,
}) {
  if (!store || !agents) return null
  const maxConcurrent = typeof config?.maxConcurrentSessions === 'number' ? config.maxConcurrentSessions : 3
  if (maxConcurrent > 0) {
    const active = countActiveSessions({ store, agents })
    if (active >= maxConcurrent) return null
  }

  const queued = typeof store.listQueuedTasks === 'function' ? store.listQueuedTasks() : []
  if (queued.length === 0) return null

  for (const nextTask of queued) {
    let queuedParams = {}
    if (typeof nextTask.queuedRequest === 'string' && nextTask.queuedRequest) {
      try { queuedParams = JSON.parse(nextTask.queuedRequest) } catch { /* ignore */ }
    }
    try {
      return await runTask({
        agents,
        store,
        task: nextTask,
        config,
        provider: queuedParams.provider || nextTask.provider || undefined,
        model: queuedParams.model || nextTask.model || undefined,
        permission: queuedParams.permission || nextTask.permission || undefined,
        reasoningEffort: queuedParams.reasoningEffort || nextTask.reasoningEffort || undefined,
        text: queuedParams.text || undefined,
        agentPreset: queuedParams.agentPreset || agentPreset,
        mintSessionId: mintSessionId || (() => `kanban-${nextTask.id}-${randomUUID()}`),
        createMessage: createMessage || ((msg) => msg),
        cwdOf,
        logger,
        permissions,
        workspaceRegistry,
        claimAs: claimAs || 'queue-dispatcher',
        gitRunner,
      })
    } catch (err) {
      logger?.warn?.(`dsh-kanban: failed to start queued task ${nextTask.id}: ${err?.message}`)
      unqueueTask({ store, task: nextTask })
    }
  }
  return null
}

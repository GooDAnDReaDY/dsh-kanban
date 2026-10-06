// Bridge between Kanban cards and core DSH workflowEngine.
//
// Integrates card lifecycle with core workflowEngine:
// 1. Map card <-> role (via labels and columns).
// 2. Select agent preset with availability check via ctx.agentPresets.list()
//    and fallback to default preset.
// 3. Construct script and execute via ctx.workflowEngine.start().
// 4. Track workflow/* lifecycle (agent-start, agent-end, end):
//    - running -> review/done/failed;
//    - record runId and session in task;
//    - post summary to linked Gitea / GitHub issue.
// 5. Cancel active workflow on card request.

import {
  buildStartMessage,
  obtainAgent,
  verifyPermissionGate,
  countActiveSessions,
  reserveSessionSlot,
  releaseSessionSlot,
} from './launcher.js'
import { applyMove } from './routes.js'
import { defaultGitRunner } from './worktree.js'

export const DEFAULT_COLUMN_ROLES = {
  backlog: 'spec',
  ready: 'spec',
  progress: 'backend',
  review: 'qa_tests',
  done: 'docs',
}

const LABEL_ROLE_PATTERNS = [
  { role: 'spec', patterns: ['spec', 'specification', 'requirements', 'requirements-analysis', 'analysis'] },
  { role: 'architecture', patterns: ['architecture', 'contract'] },
  { role: 'ui_design', patterns: ['ui', 'ui_design', 'design', 'ux'] },
  { role: 'frontend', patterns: ['frontend', 'web', 'client', 'ui-impl'] },
  { role: 'backend', patterns: ['backend', 'api', 'server'] },
  { role: 'fullstack', patterns: ['fullstack', 'full-stack', 'e2e'] },
  { role: 'qa_tests', patterns: ['qa', 'qa_tests', 'test', 'tests', 'testing', 'verification'] },
  { role: 'bugfix', patterns: ['bug', 'bugfix', 'fix'] },
  { role: 'docs', patterns: ['docs', 'doc', 'documentation'] },
  { role: 'refactoring', patterns: ['refactor', 'refactoring'] },
  { role: 'research', patterns: ['research', 'spike'] },
  { role: 'devops', patterns: ['devops', 'infra', 'ci', 'cd', 'deploy'] },
]

/**
 * Resolve role for task by labels, column or explicit role property.
 *
 * @param {object} task Board task
 * @returns {string} Role ID
 */
export function resolveRole(task) {
  if (!task) return 'backend'

  if (typeof task.role === 'string' && task.role.trim() !== '') {
    return task.role.trim()
  }

  let labels = []
  if (Array.isArray(task.labels)) {
    labels = task.labels
  } else if (typeof task.labels === 'string') {
    try {
      const parsed = JSON.parse(task.labels)
      if (Array.isArray(parsed)) labels = parsed
    } catch {
      labels = task.labels.split(',').map((s) => s.trim()).filter(Boolean)
    }
  }

  for (const label of labels) {
    const l = String(label).toLowerCase()
    for (const item of LABEL_ROLE_PATTERNS) {
      if (item.patterns.some((p) => l === p || l.includes(p))) {
        return item.role
      }
    }
  }

  const col = String(task.col || task.column || '').toLowerCase()
  if (col && DEFAULT_COLUMN_ROLES[col]) {
    return DEFAULT_COLUMN_ROLES[col]
  }

  return 'backend'
}

/**
 * Resolve agent preset from available list.
 * If role matches available preset, returns it.
 * Otherwise gracefully degrades to defaultPreset or undefined.
 *
 * @param {object} params
 * @param {string} params.role Role name
 * @param {Array<object|string>} [params.availablePresets] Available presets
 * @param {string} [params.defaultPreset] Default preset
 * @returns {string|undefined}
 */
export function resolvePreset({ role, availablePresets = [], defaultPreset = undefined }) {
  if (!role) return defaultPreset

  const presetIds = new Set(
    (Array.isArray(availablePresets) ? availablePresets : []).map((p) =>
      typeof p === 'string' ? p : p?.id
    ).filter(Boolean)
  )

  if (presetIds.has(role)) {
    return role
  }

  if (defaultPreset && presetIds.has(defaultPreset)) {
    return defaultPreset
  }

  return undefined
}

/**
 * Construct JavaScript workflow script for ctx.workflowEngine.start().
 *
 * @param {object} params
 * @param {object} params.task
 * @param {string} params.role
 * @returns {string}
 */
export function buildWorkflowScript({ task, role }) {
  const rawRole = String(role || 'backend')
  const rawTaskId = String(task?.id || 'unknown')
  const validIssue = Number.isSafeInteger(task?.issueNumber) && task.issueNumber > 0 ? task.issueNumber : undefined
  const cardLabel = validIssue !== undefined ? `#${validIssue}` : rawTaskId
  const logMsg = `Starting phase ${rawRole} for card ${cardLabel}`

  return [
    `phase(${JSON.stringify(rawRole)});`,
    `log(${JSON.stringify(logMsg)});`,
    `const prompt = args.prompt;`,
    `const result = await agent(prompt, { label: ${JSON.stringify(rawRole)}, phase: ${JSON.stringify(rawRole)} });`,
    `return {`,
    `  role: ${JSON.stringify(rawRole)},`,
    `  taskId: ${JSON.stringify(rawTaskId)},`,
    `  summary: typeof result === 'string' ? result : (result ? JSON.stringify(result) : '')`,
    `};`,
  ].join('\n')
}

/**
 * Construct metadata for workflow script.
 *
 * @param {object} params
 * @param {object} params.task
 * @param {string} params.role
 * @returns {object}
 */
export function buildWorkflowMeta({ task, role }) {
  const shortId = String(task?.id || 'run').slice(0, 8)
  const title = String(task?.title || 'task').slice(0, 60)
  const safeRole = String(role || 'backend')

  return {
    name: `kanban-${shortId}`,
    description: `Workflow run for task #${task?.issueNumber || shortId} (${safeRole}): ${title}`,
    phases: [
      { title: safeRole, detail: `Execute ${safeRole} role for task` },
    ],
  }
}

/**
 * Determine target column upon successful completion of workflow phase.
 *
 * @param {string} currentCol
 * @returns {string}
 */
export function resolveTargetColumn(currentCol) {
  const col = String(currentCol || '').toLowerCase()
  if (col === 'backlog' || col === 'ready' || col === 'progress' || col === 'in-progress') {
    return 'review'
  }
  if (col === 'review') {
    return 'review'
  }
  return col || 'review'
}

/**
 * Bridge class connecting Kanban board to core DSH workflow service.
 */
export class WorkflowBridge {
  constructor({
    store,
    workflowEngine,
    agentPresets,
    agents,
    git,
    getConfig = () => ({}),
    logger,
    eventHub,
  } = {}) {
    this.store = store
    this.workflowEngine = workflowEngine
    this.agentPresets = agentPresets
    this.agents = agents
    this.git = git
    this.getConfig = getConfig
    this.logger = logger
    this.eventHub = eventHub

    // taskId -> { run, runId, taskId, role, preset, parentAgent, task }
    this.activeRuns = new Map()
    // runId -> taskId
    this.runToTask = new Map()
  }

  /**
   * List of core registered presets.
   */
  async getAvailablePresets() {
    if (!this.agentPresets || typeof this.agentPresets.list !== 'function') {
      return []
    }
    try {
      return await this.agentPresets.list()
    } catch (err) {
      this.logger?.warn?.(`dsh-kanban: failed to get presets list: ${err.message}`)
      return []
    }
  }

  /**
   * Launch workflow for card.
   */
  async startTaskWorkflow({
    task,
    role: explicitRole,
    provider,
    model,
    mintSessionId,
    gitRunner = defaultGitRunner,
    workspaceRegistry,
    claimAs,
    permission,
    permissions,
    cwdOf,
    text,
  }) {
    if (!task || !task.id) throw new Error('task is required')

    if (!this.workflowEngine || typeof this.workflowEngine.start !== 'function') {
      const err = new Error('workflow engine is not available in core')
      err.key = 'workflow-engine-unavailable'
      err.status = 503
      throw err
    }

    if (this.activeRuns.has(task.id)) {
      const existing = this.activeRuns.get(task.id)
      return {
        mode: 'workflow',
        alreadyRunning: true,
        runId: existing.runId,
        taskId: task.id,
        role: existing.role,
      }
    }

    const role = explicitRole || resolveRole(task)
    const availablePresets = await this.getAvailablePresets()
    const preset = resolvePreset({
      role,
      availablePresets,
      defaultPreset: this.getConfig()?.defaultAgentPreset || undefined,
    })

    const config = this.getConfig()
    verifyPermissionGate({ task, permission, config })

    const maxConcurrent = typeof config?.maxConcurrentSessions === 'number' ? config.maxConcurrentSessions : 3
    if (maxConcurrent > 0 && this.agents && this.store) {
      const activeCount = countActiveSessions({ store: this.store, agents: this.agents })
      if (activeCount >= maxConcurrent) {
        const err = new Error('concurrent-limit-reached')
        err.key = 'concurrent-limit-reached'
        err.status = 429
        throw err
      }
    }

    reserveSessionSlot(task.id)
    let taken
    try {
      taken = await obtainAgent({
        agents: this.agents,
        task,
        config,
        provider,
        model,
        mintSessionId,
        cwdOf,
        logger: this.logger,
        agentPreset: preset,
        permission,
        permissions,
        gitRunner,
        workspaceRegistry,
      })
    } finally {
      releaseSessionSlot(task.id)
    }

    const promptText = typeof text === 'string' && text.trim() !== ''
      ? text.trim()
      : buildStartMessage(task, config)

    const script = buildWorkflowScript({ task, role })
    const meta = buildWorkflowMeta({ task, role })

    let run
    try {
      run = this.workflowEngine.start({
        script,
        meta,
        args: { prompt: promptText },
        parent: taken.agent,
      })
    } catch (err) {
      this.logger?.warn?.(`dsh-kanban: workflowEngine.start failed: ${err.message}`)
      throw err
    }

    const runId = String(run.id)
    const entry = {
      run,
      runId,
      taskId: task.id,
      role,
      preset,
      parentAgent: taken.agent,
      task,
      startTime: Date.now(),
    }

    this.activeRuns.set(task.id, entry)
    this.runToTask.set(runId, task.id)

    // Update task card in database
    this.store.updateTask(task.id, {
      workflowRunId: runId,
      workflowStatus: 'running',
      sessionId: taken.sessionId,
      provider,
      model,
      ...(permission ? { permission } : {}),
      ...(taken.worktree ? { worktree: taken.worktree } : {}),
      ...(taken.branch ? { branch: taken.branch } : {}),
      ...(taken.workspaceId ? { workspaceId: taken.workspaceId } : {}),
    })

    this.store.addTransition({
      taskId: task.id,
      fromCol: task.col || task.column,
      toCol: task.col || task.column,
      source: 'workflow',
      detail: `starting workflow ${runId} (role: ${role}, preset: ${preset || 'default'})`,
    })

    this.eventHub?.broadcast?.('task:change', {
      taskId: task.id,
      action: 'workflow-started',
      runId,
      role,
      preset,
      sessionId: taken.sessionId,
    })

    // Asynchronously await run completion
    run.result.then(async (result) => {
      await this.handleWorkflowResult(task.id, runId, role, result)
    }).catch(async (err) => {
      this.logger?.warn?.(`dsh-kanban: workflow run ${runId} rejected: ${err?.message}`)
      await this.handleWorkflowResult(task.id, runId, role, {
        stopReason: 'error',
        error: err?.message || 'unknown error',
      })
    })

    return {
      mode: 'workflow',
      started: true,
      runId,
      taskId: task.id,
      role,
      preset: preset || 'default',
      sessionId: taken.sessionId,
    }
  }

  /**
   * Cancel running workflow.
   */
  async cancelTaskWorkflow(taskId, reason = 'cancelled-by-user') {
    if (!taskId) return { cancelled: false, error: 'task-id-required' }

    const entry = this.activeRuns.get(taskId)
    if (!entry) {
      // Status in DB might still indicate running
      const task = this.store.getTask(taskId)
      if (task?.workflowStatus === 'running') {
        this.store.updateTask(taskId, { workflowStatus: 'cancelled' })
        return { cancelled: true, note: 'marked-cancelled-in-store' }
      }
      return { cancelled: false, error: 'no-active-workflow' }
    }

    try {
      entry.run.cancel(reason)
    } catch (err) {
      this.logger?.warn?.(`dsh-kanban: error canceling workflow run ${entry.runId}: ${err.message}`)
    }

    this.store.updateTask(taskId, { workflowStatus: 'cancelled' })
    this.store.addTransition({
      taskId,
      fromCol: entry.task?.col || entry.task?.column || 'progress',
      toCol: entry.task?.col || entry.task?.column || 'progress',
      source: 'workflow',
      detail: `cancelled workflow ${entry.runId}: ${reason}`,
    })

    this.eventHub?.broadcast?.('task:change', {
      taskId,
      action: 'workflow-cancelled',
      runId: entry.runId,
      reason,
    })

    return { cancelled: true, runId: entry.runId }
  }

  /**
   * Handle workflow execution completion.
   */
  async handleWorkflowResult(taskId, runId, role, result) {
    const entry = this.activeRuns.get(taskId)
    const task = this.store.getTask(taskId) || entry?.task

    this.activeRuns.delete(taskId)
    this.runToTask.delete(runId)

    if (!task) return

    const stopReason = result?.stopReason || 'error'
    const isCompleted = stopReason === 'completed'
    const summary = typeof result?.value?.summary === 'string'
      ? result.value.summary
      : (result?.error || '')

    const newStatus = isCompleted ? 'completed' : (stopReason === 'cancelled' ? 'cancelled' : 'failed')
    this.store.updateTask(taskId, {
      workflowStatus: newStatus,
    })

    if (isCompleted) {
      const targetCol = resolveTargetColumn(task.col || task.column)
      if (targetCol !== (task.col || task.column)) {
        applyMove({
          store: this.store,
          config: this.getConfig(),
          id: taskId,
          column: targetCol,
          source: 'workflow',
          detail: `workflow ${runId} completed successfully (role: ${role})`,
        })
      }

      // Send comment to linked Gitea / GitHub issue
      if (this.git && task.repo && task.issueNumber) {
        const commentBody = [
          `🚀 **Workflow completed successfully!** (role: \`${role}\`)`,
          summary ? `\n${summary}` : '',
          `\n*Card status moved to column "${targetCol}".*`,
        ].filter(Boolean).join('\n')

        try {
          await this.git.comment({
            owner: task.owner,
            repo: task.repo,
            index: task.issueNumber,
            body: commentBody,
            provider: task.provider,
          })
        } catch (err) {
          this.logger?.warn?.(`dsh-kanban: failed to comment on issue ${task.repo}#${task.issueNumber}: ${err.message}`)
        }
      }

      // Add comment to card
      if (summary) {
        const text = `🚀 **Workflow completed (${role}):**\n\n${summary}`
        if (typeof this.store?.addComment === 'function') {
          this.store.addComment(taskId, { author: 'workflow', role: 'workflow', text })
        } else if (typeof this.store?.addTaskComment === 'function') {
          this.store.addTaskComment(taskId, { author: 'workflow', role: 'workflow', text, body: text })
        }
      }
    } else {
      this.store.addTransition({
        taskId,
        fromCol: task.col || task.column,
        toCol: task.col || task.column,
        source: 'workflow',
        detail: `workflow ${runId} completed with status ${stopReason}: ${result?.error || ''}`,
      })
    }

    if (entry?.run && typeof entry.run.dispose === 'function') {
      try {
        await entry.run.dispose()
      } catch (err) {
        this.logger?.warn?.(`dsh-kanban: error disposing workflow run ${runId}: ${err.message}`)
      }
    }

    this.eventHub?.broadcast?.('task:change', {
      taskId,
      action: 'workflow-ended',
      runId,
      role,
      status: newStatus,
      stopReason,
    })
  }

  /**
   * Attach core workflow/* event listeners.
   *
   * @param {object} ctx Cordis context
   */
  bindCoreEvents(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return () => {}

    const unbind = [
      ctx.on('workflow/agent-start', (runInfo, agentInfo) => {
        const runId = String(runInfo?.id || '')
        const taskId = this.runToTask.get(runId)
        if (!taskId) return

        if (agentInfo?.childId) {
          this.store.updateTask(taskId, { sessionId: String(agentInfo.childId) })
          this.eventHub?.broadcast?.('task:change', {
            taskId,
            action: 'workflow-agent-start',
            runId,
            sessionId: String(agentInfo.childId),
            label: agentInfo.label,
          })
        }
      }),

      ctx.on('workflow/agent-end', (runInfo, endInfo) => {
        const runId = String(runInfo?.id || '')
        const taskId = this.runToTask.get(runId)
        if (!taskId) return

        this.eventHub?.broadcast?.('task:change', {
          taskId,
          action: 'workflow-agent-end',
          runId,
          outcome: endInfo?.outcome,
        })
      }),

      ctx.on('workflow/end', (runInfo, resultInfo) => {
        const runId = String(runInfo?.id || '')
        const taskId = this.runToTask.get(runId)
        if (!taskId) return

        // handleWorkflowResult is also invoked via run.result.then,
        // but workflow/end event guarantees observer synchronization
        this.eventHub?.broadcast?.('task:change', {
          taskId,
          action: 'workflow-core-end',
          runId,
          stopReason: resultInfo?.stopReason,
        })
      }),
    ]

    return () => {
      for (const fn of unbind) {
        if (typeof fn === 'function') fn()
      }
    }
  }
}

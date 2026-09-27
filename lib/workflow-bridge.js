// Мост между карточками Kanban и встроенным в ядро DSH workflowEngine.
//
// Выполняет перенос логики из dsh-agent-orchestrator/lib/integrations/kanban-bridge.js:
// 1. Сопоставление карточка ↔ роль (по меткам и колонкам).
// 2. Выбор пресета агента с проверкой доступности через ctx.agentPresets.list()
//    и фоллбэком на пресет по умолчанию.
// 3. Формирование сценария и запуск через ctx.workflowEngine.start().
// 4. Отслеживание жизненного цикла workflow/* (agent-start, agent-end, end):
//    - running -> review/done/failed;
//    - фиксация runId и сессии в задаче;
//    - отправка summary в связанный issue Gitea / GitHub.
// 5. Отмена активного workflow по запросу из карточки.

import { buildStartMessage, obtainAgent } from './launcher.js'
import { applyMove } from './routes.js'

export const DEFAULT_COLUMN_ROLES = {
  backlog: 'spec',
  ready: 'spec',
  progress: 'backend',
  review: 'qa_tests',
  done: 'docs',
}

export const LABEL_ROLE_PATTERNS = [
  { role: 'spec', patterns: ['spec', 'specification', 'requirements', 'requirements-analysis', 'анализ', 'тз'] },
  { role: 'architecture', patterns: ['architecture', 'архитектура', 'contract'] },
  { role: 'ui_design', patterns: ['ui', 'ui_design', 'design', 'ux', 'дизайн'] },
  { role: 'frontend', patterns: ['frontend', 'web', 'client', 'ui-impl', 'фронтенд'] },
  { role: 'backend', patterns: ['backend', 'api', 'server', 'бэкенд'] },
  { role: 'fullstack', patterns: ['fullstack', 'full-stack', 'e2e'] },
  { role: 'qa_tests', patterns: ['qa', 'qa_tests', 'test', 'tests', 'testing', 'verification', 'тест', 'тесты'] },
  { role: 'bugfix', patterns: ['bug', 'bugfix', 'fix', 'баг', 'фикс'] },
  { role: 'docs', patterns: ['docs', 'doc', 'documentation', 'документация'] },
  { role: 'refactoring', patterns: ['refactor', 'refactoring', 'рефакторинг'] },
  { role: 'research', patterns: ['research', 'spike', 'исследование'] },
  { role: 'devops', patterns: ['devops', 'infra', 'ci', 'cd', 'deploy', 'деплой'] },
]

/**
 * Определить роль для задачи по меткам, колонке или явному полю role.
 *
 * @param {object} task Задача доски
 * @returns {string} Идентификатор роли
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
 * Подобрать пресет агента из доступных.
 * Если роль найдена в списке доступных пресетов — возвращает её.
 * Иначе выполняет безопасную деградацию на defaultPreset или undefined.
 *
 * @param {object} params
 * @param {string} params.role Имя роли
 * @param {Array<object|string>} [params.availablePresets] Список пресетов
 * @param {string} [params.defaultPreset] Пресет по умолчанию
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
 * Построить JavaScript сценарий для ctx.workflowEngine.start().
 *
 * @param {object} params
 * @param {object} params.task
 * @param {string} params.role
 * @returns {string}
 */
export function buildWorkflowScript({ task, role }) {
  const taskId = String(task?.id || 'unknown').replace(/["\\]/g, '')
  const safeRole = String(role || 'backend').replace(/["\\]/g, '')
  const issueNum = task?.issueNumber ? `#${task.issueNumber}` : taskId

  return [
    `phase("${safeRole}");`,
    `log("Запуск этапа ${safeRole} по карточке ${issueNum}");`,
    `const prompt = args.prompt;`,
    `const result = await agent(prompt, { label: "${safeRole}", phase: "${safeRole}" });`,
    `return {`,
    `  role: "${safeRole}",`,
    `  taskId: "${taskId}",`,
    `  summary: typeof result === 'string' ? result : (result ? JSON.stringify(result) : '')`,
    `};`,
  ].join('\n')
}

/**
 * Сформировать метаданные сценария workflow.
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
 * Определить целевую колонку после успешного завершения этапа workflow.
 *
 * @param {string} currentCol
 * @returns {string}
 */
export function resolveTargetColumn(currentCol) {
  const col = String(currentCol || '').toLowerCase()
  if (col === 'backlog' || col === 'ready' || col === 'progress') {
    return 'review'
  }
  if (col === 'review') {
    return 'done'
  }
  return col || 'review'
}

/**
 * Класс-мост между доской и встроенным сервисом workflow ядра DSH.
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
   * Список зарегистрированных пресетов ядра.
   */
  async getAvailablePresets() {
    if (!this.agentPresets || typeof this.agentPresets.list !== 'function') {
      return []
    }
    try {
      return await this.agentPresets.list()
    } catch (err) {
      this.logger?.warn?.(`dsh-kanban: не удалось получить список пресетов: ${err.message}`)
      return []
    }
  }

  /**
   * Запуск workflow по карточке.
   */
  async startTaskWorkflow({
    task,
    role: explicitRole,
    provider,
    model,
    mintSessionId,
    gitRunner,
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
    const taken = await obtainAgent({
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

    // Обновляем карточку в базе данных
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
      detail: `запуск workflow ${runId} (роль: ${role}, пресет: ${preset || 'default'})`,
    })

    this.eventHub?.broadcast?.('task:change', {
      taskId: task.id,
      action: 'workflow-started',
      runId,
      role,
      preset,
      sessionId: taken.sessionId,
    })

    // Асинхронное ожидание завершения run
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
   * Отмена запущенного workflow.
   */
  async cancelTaskWorkflow(taskId, reason = 'cancelled-by-user') {
    if (!taskId) return { cancelled: false, error: 'task-id-required' }

    const entry = this.activeRuns.get(taskId)
    if (!entry) {
      // Возможно, статус в БД ещё числится running
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
      detail: `отмена workflow ${entry.runId}: ${reason}`,
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
   * Обработка завершения выполнения workflow.
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
          detail: `workflow ${runId} завершён успешно (роль: ${role})`,
        })
      }

      // Отправляем комментарий в связанный issue Gitea / GitHub
      if (this.git && task.repo && task.issueNumber) {
        const commentBody = [
          `🚀 **Workflow завершён успешно!** (роль: \`${role}\`)`,
          summary ? `\n${summary}` : '',
          `\n*Статус карточки переведён в колонку "${targetCol}".*`,
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
          this.logger?.warn?.(`dsh-kanban: не удалось отправить комментарий в issue ${task.repo}#${task.issueNumber}: ${err.message}`)
        }
      }

      // Добавляем комментарий в карточку
      if (typeof this.store.addTaskComment === 'function' && summary) {
        this.store.addTaskComment(taskId, {
          author: 'workflow',
          body: `🚀 **Workflow завершён (${role}):**\n\n${summary}`,
        })
      }
    } else {
      this.store.addTransition({
        taskId,
        fromCol: task.col || task.column,
        toCol: task.col || task.column,
        source: 'workflow',
        detail: `workflow ${runId} завершён со статусом ${stopReason}: ${result?.error || ''}`,
      })
    }

    if (entry?.run && typeof entry.run.dispose === 'function') {
      try {
        await entry.run.dispose()
      } catch (err) {
        this.logger?.warn?.(`dsh-kanban: ошибка при dispose workflow run ${runId}: ${err.message}`)
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
   * Подключить слушатели событий ядра workflow/*.
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

        // handleWorkflowResult также вызывается через run.result.then,
        // но событие workflow/end гарантирует синхронизацию наблюдателей
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

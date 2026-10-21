/**
 * Watchdog timer and Circuit Breaker service for agent tasks.
 *
 * Automatically monitors tasks in 'in-progress'.
 * If a task is inactive longer than watchdogStallTimeoutMin or incurs
 * watchdogMaxConsecutiveErrors consecutive execution errors,
 * the circuit breaker trips:
 * 1. The agent session is aborted/paused to avoid burning quota.
 * 2. The task is marked as stalled with diagnostic detail.
 * 3. A diagnostic transition is added to the task journal.
 * 4. A 'task:change' event is broadcast via eventHub.
 *
 * Tasks can be resumed manually via resumeTask or /task/:id/resume.
 */
export class WatchdogService {
  constructor() {
    this.consecutiveErrors = new Map()
    this.lastActive = new Map()
    this.lastError = new Map()
  }

  recordActivity(taskId, _type = 'activity') {
    if (!taskId) return
    this.lastActive.set(taskId, Date.now())
  }

  recordError(taskId, error) {
    if (!taskId) return
    const count = (this.consecutiveErrors.get(taskId) || 0) + 1
    this.consecutiveErrors.set(taskId, count)
    const msg = typeof error === 'string' ? error : (error?.message || error?.name || 'Execution error')
    this.lastError.set(taskId, msg)
    this.lastActive.set(taskId, Date.now())
    return count
  }

  clearError(taskId) {
    if (!taskId) return
    this.consecutiveErrors.delete(taskId)
    this.lastError.delete(taskId)
  }

  clearTask(taskId) {
    if (!taskId) return
    this.consecutiveErrors.delete(taskId)
    this.lastError.delete(taskId)
    this.lastActive.delete(taskId)
  }

  checkTask(task, options = {}) {
    const { config = {}, now = Date.now() } = options
    if (config.watchdogEnabled === false) return { shouldTrip: false }
    if (!task || task.column !== 'in-progress' || task.stalled) return { shouldTrip: false }

    const timeoutMs = (Number(config.watchdogStallTimeoutMin) || 15) * 60 * 1000
    const maxErrors = Number(config.watchdogMaxConsecutiveErrors) || 5

    // Check consecutive errors
    const errCount = this.consecutiveErrors.get(task.id) || 0
    if (errCount >= maxErrors) {
      const lastErr = this.lastError.get(task.id) || 'ToolExecutionError'
      return {
        shouldTrip: true,
        reason: `Circuit breaker tripped: ${errCount} consecutive execution errors (${lastErr})`,
        errCount,
      }
    }

    // Check inactivity timeout
    const last = this.lastActive.get(task.id) || task.updatedAt || task.columnAt || task.createdAt || now
    const idleMs = now - last
    if (idleMs >= timeoutMs) {
      const idleMin = Math.round(idleMs / 60000)
      return {
        shouldTrip: true,
        reason: `Watchdog timeout: task inactive for ${idleMin} minutes (threshold ${config.watchdogStallTimeoutMin || 15}m)`,
        idleMs,
      }
    }

    return { shouldTrip: false }
  }

  tripTask(task, reason, options = {}) {
    const { store, agents, eventHub, logger } = options
    if (!task) return

    // 1. Abort/pause session if running
    if (task.sessionId && agents) {
      try {
        const agent = agents.get?.(task.sessionId)
        if (agent && typeof agent.abort === 'function') {
          agent.abort('watchdog: circuit breaker tripped')
        } else if (agent && typeof agent.pause === 'function') {
          agent.pause()
        }
      } catch (err) {
        logger?.warn?.(`dsh-kanban: watchdog failed to abort agent for session ${task.sessionId}: ${err?.message}`)
      }
    }

    // 2. Update task in store
    if (store && typeof store.updateTask === 'function') {
      store.updateTask(task.id, {
        stalled: 1,
        stalledReason: reason,
        stalledAt: Date.now(),
      })

      // 3. Journal transition
      if (typeof store.addTransition === 'function') {
        store.addTransition({
          taskId: task.id,
          fromCol: task.column,
          toCol: task.column,
          source: 'watchdog',
          detail: reason,
        })
      }
    }

    // 4. Broadcast event
    eventHub?.broadcast?.('task:change', {
      taskId: task.id,
      action: 'stalled',
      stalled: true,
      reason,
    })

    logger?.warn?.(`dsh-kanban: watchdog tripped for task ${task.id}: ${reason}`)
  }

  checkTasks(options = {}) {
    const { store, agents, config = {}, eventHub, logger } = options
    if (config.watchdogEnabled === false || !store) return []

    const tripped = []
    const inProgressTasks = store.listTasks({ column: 'in-progress' })
    const now = Date.now()

    for (const task of inProgressTasks) {
      const check = this.checkTask(task, { config, now })
      if (check.shouldTrip) {
        this.tripTask(task, check.reason, { store, agents, eventHub, logger })
        tripped.push({ taskId: task.id, reason: check.reason })
      }
    }
    return tripped
  }

  resumeTask(options = {}) {
    const { store, taskId, eventHub } = options
    if (!taskId) return
    if (store && typeof store.updateTask === 'function') {
      store.updateTask(taskId, {
        stalled: 0,
        stalledReason: '',
        stalledAt: 0,
      })
    }
    this.clearTask(taskId)
    this.recordActivity(taskId, 'resume')
    eventHub?.broadcast?.('task:change', { taskId, action: 'resumed', stalled: false })
  }
}

export function createWatchdogService() {
  return new WatchdogService()
}

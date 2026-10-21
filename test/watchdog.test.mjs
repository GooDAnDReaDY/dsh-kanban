import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatchdogService } from '../lib/watchdog.js'
import { canRevive } from '../lib/routes.js'
import { CONFIG_DEFAULTS, withDefaults } from '../lib/config.js'

test('Watchdog: configuration schema contains watchdog settings (#378)', () => {
  assert.equal(CONFIG_DEFAULTS.watchdogEnabled, true)
  assert.equal(CONFIG_DEFAULTS.watchdogStallTimeoutMin, 15)
  assert.equal(CONFIG_DEFAULTS.watchdogMaxConsecutiveErrors, 5)

  const cfg = withDefaults({
    watchdogEnabled: false,
    watchdogStallTimeoutMin: 20,
    watchdogMaxConsecutiveErrors: 3,
  })
  assert.equal(cfg.watchdogEnabled, false)
  assert.equal(cfg.watchdogStallTimeoutMin, 20)
  assert.equal(cfg.watchdogMaxConsecutiveErrors, 3)
})

test('Watchdog: trips circuit breaker on inactivity timeout (#378)', () => {
  const watchdog = createWatchdogService()
  const now = Date.now()
  const taskId = 'task-idle-1'

  const task = {
    id: taskId,
    column: 'in-progress',
    stalled: false,
    updatedAt: now - 16 * 60 * 1000, // 16 min ago
  }

  const check = watchdog.checkTask(task, {
    config: { watchdogEnabled: true, watchdogStallTimeoutMin: 15, watchdogMaxConsecutiveErrors: 5 },
    now,
  })

  assert.equal(check.shouldTrip, true)
  assert.match(check.reason, /Watchdog timeout: task inactive for 16 minutes/)
})

test('Watchdog: does not trip if task was active recently (#378)', () => {
  const watchdog = createWatchdogService()
  const now = Date.now()
  const taskId = 'task-active-1'

  watchdog.recordActivity(taskId)

  const task = {
    id: taskId,
    column: 'in-progress',
    stalled: false,
    updatedAt: now - 30 * 60 * 1000, // old updatedAt, but recent activity recorded
  }

  const check = watchdog.checkTask(task, {
    config: { watchdogEnabled: true, watchdogStallTimeoutMin: 15, watchdogMaxConsecutiveErrors: 5 },
    now,
  })

  assert.equal(check.shouldTrip, false)
})

test('Watchdog: trips circuit breaker on consecutive execution errors (#378)', () => {
  const watchdog = createWatchdogService()
  const taskId = 'task-err-1'

  for (let i = 0; i < 4; i++) {
    watchdog.recordError(taskId, 'ToolExecutionError: command failed')
  }

  let check = watchdog.checkTask({ id: taskId, column: 'in-progress' }, {
    config: { watchdogEnabled: true, watchdogStallTimeoutMin: 15, watchdogMaxConsecutiveErrors: 5 },
  })
  assert.equal(check.shouldTrip, false)

  // 5th consecutive error
  watchdog.recordError(taskId, 'ToolExecutionError: command failed')
  check = watchdog.checkTask({ id: taskId, column: 'in-progress' }, {
    config: { watchdogEnabled: true, watchdogStallTimeoutMin: 15, watchdogMaxConsecutiveErrors: 5 },
  })
  assert.equal(check.shouldTrip, true)
  assert.match(check.reason, /Circuit breaker tripped: 5 consecutive execution errors/)
})

test('Watchdog: success event clears error counter (#378)', () => {
  const watchdog = createWatchdogService()
  const taskId = 'task-err-recover'

  for (let i = 0; i < 4; i++) {
    watchdog.recordError(taskId, 'transient error')
  }
  watchdog.clearError(taskId)

  const check = watchdog.checkTask({ id: taskId, column: 'in-progress' }, {
    config: { watchdogEnabled: true, watchdogStallTimeoutMin: 15, watchdogMaxConsecutiveErrors: 5 },
  })
  assert.equal(check.shouldTrip, false)
})

test('Watchdog: tripTask aborts agent, updates store, records transition, broadcasts event (#378)', () => {
  const watchdog = createWatchdogService()
  const taskId = 'task-trip-1'
  const sessionId = 'session-123'

  let agentAborted = false
  let abortReason = ''
  const mockAgent = {
    abort(reason) {
      agentAborted = true
      abortReason = reason
    },
  }

  const mockAgents = {
    get(sid) {
      return sid === sessionId ? mockAgent : null
    },
  }

  let updatedTask = null
  let addedTransition = null
  const mockStore = {
    updateTask(id, data) {
      updatedTask = { id, ...data }
    },
    addTransition(trans) {
      addedTransition = trans
    },
  }

  const events = []
  const mockEventHub = {
    broadcast(event, payload) {
      events.push({ event, payload })
    },
  }

  const task = {
    id: taskId,
    column: 'in-progress',
    sessionId,
  }

  watchdog.tripTask(task, 'Test timeout reason', {
    store: mockStore,
    agents: mockAgents,
    eventHub: mockEventHub,
  })

  assert.equal(agentAborted, true)
  assert.match(abortReason, /circuit breaker tripped/)

  assert.ok(updatedTask)
  assert.equal(updatedTask.id, taskId)
  assert.equal(updatedTask.stalled, 1)
  assert.equal(updatedTask.stalledReason, 'Test timeout reason')

  assert.ok(addedTransition)
  assert.equal(addedTransition.source, 'watchdog')
  assert.equal(addedTransition.taskId, taskId)
  assert.equal(addedTransition.detail, 'Test timeout reason')

  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'task:change')
  assert.equal(events[0].payload.action, 'stalled')
  assert.equal(events[0].payload.stalled, true)
})

test('Watchdog: resumeTask clears stalled state and error count (#378)', () => {
  const watchdog = createWatchdogService()
  const taskId = 'task-resumed-1'

  watchdog.recordError(taskId, 'fatal')

  let updated = null
  const mockStore = {
    updateTask(id, data) {
      updated = { id, ...data }
    },
  }

  const events = []
  const mockEventHub = {
    broadcast(event, payload) {
      events.push({ event, payload })
    },
  }

  watchdog.resumeTask({
    store: mockStore,
    taskId,
    eventHub: mockEventHub,
  })

  assert.equal(updated.id, taskId)
  assert.equal(updated.stalled, 0)
  assert.equal(updated.stalledReason, '')

  assert.equal(watchdog.consecutiveErrors.has(taskId), false)
  assert.equal(events.length, 1)
  assert.equal(events[0].payload.action, 'resumed')
  assert.equal(events[0].payload.stalled, false)
})

test('Watchdog: canRevive returns true for stalled in-progress task (#378)', () => {
  const stalledTask = {
    id: 'stalled-1',
    column: 'in-progress',
    stalled: true,
  }
  assert.equal(canRevive(stalledTask, () => undefined), true)
})

test('Watchdog: watchdogEnabled: false skips all checks (#378)', () => {
  const watchdog = createWatchdogService()
  const task = {
    id: 'task-disabled',
    column: 'in-progress',
    stalled: false,
    updatedAt: 0,
  }
  const check = watchdog.checkTask(task, {
    config: { watchdogEnabled: false },
  })
  assert.equal(check.shouldTrip, false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveRole,
  resolvePreset,
  buildWorkflowScript,
  buildWorkflowMeta,
  resolveTargetColumn,
  DEFAULT_COLUMN_ROLES,
  WorkflowBridge,
} from '../lib/workflow-bridge.js'

test('resolveRole: определяет роль по колонке карточки', () => {
  assert.equal(resolveRole({ col: 'backlog' }), 'spec')
  assert.equal(resolveRole({ col: 'ready' }), 'spec')
  assert.equal(resolveRole({ col: 'progress' }), 'backend')
  assert.equal(resolveRole({ col: 'review' }), 'qa_tests')
  assert.equal(resolveRole({ col: 'done' }), 'docs')
})

test('resolveRole: метки карточки имеют приоритет над колонкой', () => {
  // Задача в progress, но с меткой 'qa' или 'tests' -> роль qa_tests
  assert.equal(resolveRole({ col: 'progress', labels: ['tests'] }), 'qa_tests')
  assert.equal(resolveRole({ col: 'progress', labels: ['ui'] }), 'ui_design')
  assert.equal(resolveRole({ col: 'progress', labels: ['frontend'] }), 'frontend')
  assert.equal(resolveRole({ col: 'progress', labels: ['bugfix'] }), 'bugfix')
  assert.equal(resolveRole({ col: 'progress', labels: ['docs'] }), 'docs')
  assert.equal(resolveRole({ col: 'review', labels: ['refactoring'] }), 'refactoring')
})

test('resolveRole: явное поле role побеждает все остальные правила', () => {
  assert.equal(resolveRole({ col: 'progress', labels: ['tests'], role: 'architecture' }), 'architecture')
})

test('resolvePreset: возвращает роль, если пресет зарегистрирован в ядра', () => {
  const presets = [
    { id: 'spec', name: 'Spec Analyst' },
    { id: 'backend', name: 'Backend Dev' },
    { id: 'qa_tests', name: 'QA Engineer' },
  ]
  assert.equal(resolvePreset({ role: 'backend', availablePresets: presets }), 'backend')
  assert.equal(resolvePreset({ role: 'spec', availablePresets: presets }), 'spec')
})

test('resolvePreset: деградирует на пресет по умолчанию при отсутствии пакета ролей', () => {
  // Пакет ролей не установлен — availablePresets пустой или содержит только standard
  const available = [{ id: 'standard', name: 'Standard Preset' }]

  // Без совпадения и с явным defaultPreset:
  assert.equal(
    resolvePreset({ role: 'qa_tests', availablePresets: available, defaultPreset: 'standard' }),
    'standard'
  )

  // Без совпадения и без defaultPreset -> undefined (ядро использует системный дефолт)
  assert.equal(
    resolvePreset({ role: 'qa_tests', availablePresets: available }),
    undefined
  )

  // Пустой список пресетов:
  assert.equal(
    resolvePreset({ role: 'backend', availablePresets: [] }),
    undefined
  )
})

test('buildWorkflowScript: формирует корректный JS-сценарий с phase, log, agent', () => {
  const task = { id: 'task-12345', issueNumber: 42, title: 'Implement feature' }
  const script = buildWorkflowScript({ task, role: 'backend' })

  assert.ok(script.includes('phase("backend");'))
  assert.ok(script.includes('log("Starting phase backend for card #42");'))
  assert.ok(script.includes('const result = await agent(prompt, { label: "backend", phase: "backend" });'))
  assert.ok(script.includes('return {'))
  assert.ok(script.includes('role: "backend"'))
  assert.ok(script.includes('taskId: "task-12345"'))
})

test('buildWorkflowMeta: формирует метаданные для workflowEngine', () => {
  const task = { id: 'abc-def-123', issueNumber: 77, title: 'Fix critical bug' }
  const meta = buildWorkflowMeta({ task, role: 'bugfix' })

  assert.equal(meta.name, 'kanban-abc-def-')
  assert.ok(meta.description.includes('#77'))
  assert.ok(meta.description.includes('bugfix'))
  assert.equal(meta.phases[0].title, 'bugfix')
})

test('resolveTargetColumn: определяет следующую колонку после успешного workflow', () => {
  assert.equal(resolveTargetColumn('progress'), 'review')
  assert.equal(resolveTargetColumn('ready'), 'review')
  assert.equal(resolveTargetColumn('backlog'), 'review')
  assert.equal(resolveTargetColumn('review'), 'done')
  assert.equal(resolveTargetColumn('done'), 'done')
})

test('WorkflowBridge: запуск по карточке вызывает workflowEngine.start с ролью из колонки', async () => {
  let startedRequest = null
  let fakeRunSettled = null

  const mockRun = {
    id: 'run-uuid-1',
    meta: {},
    result: new Promise((resolve) => {
      fakeRunSettled = resolve
    }),
    cancel: () => {},
    dispose: async () => {},
  }

  const mockWorkflowEngine = {
    start(req) {
      startedRequest = req
      return mockRun
    },
  }

  const updatedTasks = []
  const transitions = []
  const mockStore = {
    getTask: (id) => ({ id, col: 'progress', title: 'Test Task' }),
    updateTask: (id, patch) => updatedTasks.push({ id, ...patch }),
    addTransition: (t) => transitions.push(t),
  }

  const mockAgents = {
    get: () => undefined,
    resume: async () => { throw new Error('not found') },
    create: async () => ({
      sessionId: 'sess-1',
      agent: {
        session: { id: 'sess-1' },
        whenIdle: async () => {},
        followup: () => {},
      },
    }),
  }

  const bridge = new WorkflowBridge({
    store: mockStore,
    workflowEngine: mockWorkflowEngine,
    agentPresets: { list: async () => [{ id: 'backend' }, { id: 'qa_tests' }] },
    agents: mockAgents,
  })

  const task = { id: 'task-100', col: 'progress', title: 'Core Feature' }
  const res = await bridge.startTaskWorkflow({
    task,
    provider: 'deepseek',
    model: 'deepseek-chat',
    mintSessionId: () => 'sess-1',
    cwdOf: () => '/test',
  })

  assert.equal(res.started, true)
  assert.equal(res.role, 'backend')
  assert.equal(res.runId, 'run-uuid-1')
  assert.ok(startedRequest)
  assert.ok(startedRequest.script.includes('phase("backend");'))

  // Карточка обновлена в store со статусом running
  const runningUpdate = updatedTasks.find((u) => u.workflowStatus === 'running')
  assert.ok(runningUpdate)
  assert.equal(runningUpdate.workflowRunId, 'run-uuid-1')

  // Завершаем run успехом
  fakeRunSettled({
    stopReason: 'completed',
    value: { summary: 'Feature implemented successfully' },
  })
  await new Promise((r) => setTimeout(r, 10))

  const completedUpdate = updatedTasks.find((u) => u.workflowStatus === 'completed')
  assert.ok(completedUpdate)
})

test('WorkflowBridge: без пакета ролей запуск идёт с пресетом по умолчанию', async () => {
  let agentCreatedWithPreset = null

  const mockRun = {
    id: 'run-uuid-2',
    result: Promise.resolve({ stopReason: 'completed', value: {} }),
    cancel: () => {},
    dispose: async () => {},
  }

  const mockWorkflowEngine = {
    start: () => mockRun,
  }

  const mockStore = {
    getTask: (id) => ({ id, col: 'progress', title: 'Task' }),
    updateTask: () => {},
    addTransition: () => {},
  }

  const mockAgents = {
    get: () => undefined,
    resume: async () => { throw new Error('not found') },
    create: async (params) => {
      agentCreatedWithPreset = params.meta?.agentPreset
      return {
        sessionId: 'sess-2',
        agent: {
          session: { id: 'sess-2' },
          whenIdle: async () => {},
          followup: () => {},
        },
      }
    },
  }

  const bridge = new WorkflowBridge({
    store: mockStore,
    workflowEngine: mockWorkflowEngine,
    agentPresets: { list: async () => [] }, // нет пакета ролей
    agents: mockAgents,
    getConfig: () => ({ defaultAgentPreset: 'default' }),
  })

  const task = { id: 'task-200', col: 'review', title: 'Review Task' }
  const res = await bridge.startTaskWorkflow({
    task,
    provider: 'deepseek',
    model: 'deepseek-chat',
    mintSessionId: () => 'sess-2',
    cwdOf: () => '/test',
  })

  assert.equal(res.started, true)
  assert.equal(res.role, 'qa_tests')
  // Так как в list() пусто, fallback на default или undefined
  assert.equal(agentCreatedWithPreset, undefined)
})

test('WorkflowBridge: ошибка в workflow/end переводит карточку в статус failed', async () => {
  let fakeRunSettled = null

  const mockRun = {
    id: 'run-uuid-3',
    result: new Promise((resolve) => {
      fakeRunSettled = resolve
    }),
    cancel: () => {},
    dispose: async () => {},
  }

  const updatedTasks = []
  const transitions = []
  const mockStore = {
    getTask: (id) => ({ id, col: 'progress', title: 'Task' }),
    updateTask: (id, patch) => updatedTasks.push({ id, ...patch }),
    addTransition: (t) => transitions.push(t),
  }

  const mockAgents = {
    get: () => undefined,
    resume: async () => { throw new Error('not found') },
    create: async () => ({
      sessionId: 'sess-3',
      agent: {
        session: { id: 'sess-3' },
        whenIdle: async () => {},
        followup: () => {},
      },
    }),
  }

  const bridge = new WorkflowBridge({
    store: mockStore,
    workflowEngine: { start: () => mockRun },
    agents: mockAgents,
  })

  await bridge.startTaskWorkflow({
    task: { id: 'task-300', col: 'progress', title: 'Task' },
    mintSessionId: () => 'sess-3',
    cwdOf: () => '/test',
  })

  // Завершаем с ошибкой
  fakeRunSettled({
    stopReason: 'error',
    error: 'PTC sandbox execution timed out',
  })
  await new Promise((r) => setTimeout(r, 10))

  const failedUpdate = updatedTasks.find((u) => u.workflowStatus === 'failed')
  assert.ok(failedUpdate)
})

test('WorkflowBridge: отмена запуска вызывает run.cancel и обновляет статус', async () => {
  let cancelledReason = null

  const mockRun = {
    id: 'run-uuid-4',
    result: new Promise(() => {}), // никогда не завершается
    cancel: (reason) => {
      cancelledReason = reason
    },
    dispose: async () => {},
  }

  const updatedTasks = []
  const mockStore = {
    getTask: (id) => ({ id, col: 'progress', title: 'Task' }),
    updateTask: (id, patch) => updatedTasks.push({ id, ...patch }),
    addTransition: () => {},
  }

  const mockAgents = {
    get: () => undefined,
    resume: async () => { throw new Error('not found') },
    create: async () => ({
      sessionId: 'sess-4',
      agent: {
        session: { id: 'sess-4' },
        whenIdle: async () => {},
        followup: () => {},
      },
    }),
  }

  const bridge = new WorkflowBridge({
    store: mockStore,
    workflowEngine: { start: () => mockRun },
    agents: mockAgents,
  })

  await bridge.startTaskWorkflow({
    task: { id: 'task-400', col: 'progress', title: 'Task' },
    mintSessionId: () => 'sess-4',
    cwdOf: () => '/test',
  })

  const cancelRes = await bridge.cancelTaskWorkflow('task-400', 'user stopped task')
  assert.equal(cancelRes.cancelled, true)
  assert.equal(cancelledReason, 'user stopped task')

  const cancelledUpdate = updatedTasks.find((u) => u.workflowStatus === 'cancelled')
  assert.ok(cancelledUpdate)
})

test('WorkflowBridge: bindCoreEvents связывает события agent-start и sessionId', () => {
  const events = new Map()
  const mockCtx = {
    on(name, fn) {
      events.set(name, fn)
      return () => events.delete(name)
    },
  }

  const updatedTasks = []
  const mockStore = {
    updateTask: (id, patch) => updatedTasks.push({ id, ...patch }),
  }

  const bridge = new WorkflowBridge({
    store: mockStore,
  })
  bridge.runToTask.set('run-42', 'task-999')

  const unbind = bridge.bindCoreEvents(mockCtx)
  assert.ok(events.has('workflow/agent-start'))

  // Симулируем событие workflow/agent-start
  const agentStartHandler = events.get('workflow/agent-start')
  agentStartHandler({ id: 'run-42' }, { childId: 'child-session-777', label: 'backend' })

  const update = updatedTasks.find((u) => u.sessionId === 'child-session-777')
  assert.ok(update)
  assert.equal(update.id, 'task-999')

  unbind()
  assert.equal(events.size, 0)
})

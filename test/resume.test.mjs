import test from 'node:test'
import assert from 'node:assert/strict'
import { runTask, messageFor } from '../lib/launcher.js'
import { freshStore } from './helpers.mjs'
import { withDefaults } from '../lib/config.js'

test('messageFor генерирует преамбулу продолжения в режиме resume (#226)', () => {
  const task = {
    id: 'task-1',
    title: 'Resume feature',
    worktree: '/tmp/worktree/task-1',
    branch: 'task/1-resume',
  }
  const msg = messageFor(task, {}, '', { resume: true })
  assert.ok(msg.includes('### ↻ Режим продолжения работы над задачей'), 'должен содержать заголовок продолжения')
  assert.ok(msg.includes('/tmp/worktree/task-1'), 'должен указывать путь к воркдереву')
  assert.ok(msg.includes('task/1-resume'), 'должен указывать имя ветки')
  assert.ok(msg.includes('Сохраняй существующие изменения'), 'должен инструктировать сохранять изменения')
})

test('runTask с resume: true отправляет событие task-resume и фиксирует переход (#226)', async () => {
  const { store, cleanup } = freshStore()
  try {
    const createdTask = store.createTask({
      id: 'task-resume-test',
      title: 'Task to resume',
      column: 'in-progress',
      worktree: '/tmp/worktree/test',
      branch: 'task/test-branch',
    })

    const sent = []
    const agents = {
      get: () => undefined,
      create: async () => ({
        agent: {
          session: { id: 'session-resume-1' },
          whenIdle: async () => {},
          followup: (m) => sent.push(m),
        },
        dispose() {},
      }),
    }

    const out = await runTask({
      agents,
      store,
      task: createdTask,
      config: withDefaults(),
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      mintSessionId: () => 'session-resume-1',
      createMessage: (m) => m,
      cwdOf: () => process.cwd(),
      resume: true,
    })

    assert.equal(out.sessionId, 'session-resume-1')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].source.form, 'task-resume', 'сообщение должно иметь форму task-resume')
    assert.equal(sent[0].source.kind, 'dsh-kanban')
    assert.ok(sent[0].content[0].text.includes('### ↻ Режим продолжения работы над задачей'))

    const transitions = store.listTransitions(createdTask.id)
    const resumeTransition = transitions.find((t) => t.detail?.includes('продолжение работы над задачей'))
    assert.ok(resumeTransition, 'в журнале задачи должен появиться переход продолжения работы')
  } finally {
    cleanup()
  }
})

test('POST /dsh-kanban/task/:id/resume executes without ReferenceError (#280)', async () => {
  const { Readable } = await import('node:stream')
  const { register } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const { tmpdir } = await import('node:os')
  const { writeFileSync, unlinkSync, mkdtempSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { openStore } = await import('../lib/store.js')

  const loaderCode = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/schemastery') {
    const code = "const chain=()=>{const o={default:()=>o,description:()=>o,role:()=>o};return o};export default {object:s=>({shape:s,...chain()}),string:chain,number:chain,boolean:chain,array:chain}"
    return { url: 'data:text/javascript,' + encodeURIComponent(code), format: 'module', shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-credentials') {
    return { url: 'data:text/javascript,' + encodeURIComponent('export function credentialRef(x){return{ref:x}}'), format: 'module', shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: 'data:text/javascript,' + encodeURIComponent('export function defineTool(x){return x}'), format: 'module', shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-session') {
    return { url: 'data:text/javascript,' + encodeURIComponent('export function SessionId(x){return x}'), format: 'module', shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-llm') {
    return { url: 'data:text/javascript,' + encodeURIComponent('export function createUserMessage(x){return x}'), format: 'module', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`
  const loaderPath = join(tmpdir(), `test-loader-resume-${Date.now()}.mjs`)
  writeFileSync(loaderPath, loaderCode, 'utf8')
  register(pathToFileURL(loaderPath))

  const testStoreDir = mkdtempSync(join(tmpdir(), 'kanban-resume-test-'))
  process.env.DSH_KANBAN_DIR = testStoreDir

  try {
    const mod = await import('../lib/index.js')
    const registeredRoutes = new Map()
    const effects = []

    const mockCtx = {
      inject(deps, fn) {
        fn({ settings: { register: () => ({ get: () => ({ defaultModel: 'claude-3-5-sonnet', defaultProvider: 'anthropic' }), watch: () => {} }) } })
      },
      effect(fn, desc) {
        effects.push({ fn, desc })
        return fn()
      },
      on() {},
      get(name) {
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'anthropic', model: 'claude-3-5-sonnet' }) }
        if (name === 'permissionPresets') return []
        if (name === 'workspaceRegistry') return null
        return null
      },
      credentials: { resolve: async () => ({ value: 'test' }) },
      webServer: {
        use() {},
        register(route) { registeredRoutes.set(route.path, route) },
      },
      agents: {
        get() { return null },
        create: async () => ({
          agent: {
            session: { id: 'session-resume-live-1' },
            whenIdle: async () => {},
            followup: () => {},
          },
          dispose() {},
        }),
      },
      logger: { warn() {}, info() {}, error() {}, debug() {} },
    }

    mod.apply(mockCtx, {})

    const taskRoute = registeredRoutes.get('/dsh-kanban/task')
    assert.ok(taskRoute, 'prefix /dsh-kanban/task must be registered')

    // Create task directly in the store
    const store = openStore({ dir: testStoreDir })
    const createdTask = store.createTask({
      board: 'main',
      column: 'in-progress',
      title: 'Task to resume via API',
    })
    const taskId = createdTask.id

    // Now resume the task
    const resumeReq = new Readable({
      read() {
        this.push(Buffer.from(JSON.stringify({ text: 'Continuing work' })))
        this.push(null)
      },
    })
    resumeReq.method = 'POST'
    resumeReq.url = `/dsh-kanban/task/${taskId}/resume`
    resumeReq.headers = { host: 'localhost', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' }
    resumeReq.socket = { remoteAddress: '127.0.0.1' }

    let resumeResStatus = null
    let resumeResBody = null
    const resumeRes = {
      writeHead(code) { resumeResStatus = code },
      end(b) { resumeResBody = JSON.parse(b) },
    }

    await taskRoute.handler(resumeReq, resumeRes)

    assert.equal(resumeResStatus, 200)
    assert.equal(resumeResBody?.sessionId, 'session-resume-live-1')
    assert.equal(resumeResBody?.task?.id, taskId)

    for (const eff of effects) {
      if (typeof eff.fn === 'function') {
        try { const c = eff.fn(); if (typeof c === 'function') c(); } catch {}
      }
    }
  } finally {
    try { unlinkSync(loaderPath); } catch {}
    try { rmSync(testStoreDir, { recursive: true, force: true }); } catch {}
    delete process.env.DSH_KANBAN_DIR
  }
})

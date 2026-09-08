import test from 'node:test'
import assert from 'node:assert/strict'
import { obtainAgent } from '../lib/launcher.js'
import { withDefaults } from '../lib/config.js'

test('obtainAgent сохраняет meta.cwd как projectRoot при создании worktree (#227)', async () => {
  let createdMeta = null
  const agents = {
    get: () => undefined,
    async create(opts) {
      createdMeta = opts.meta
      return {
        agent: {
          session: { id: 'session-123' },
          whenIdle: async () => {},
          followup: () => {},
        },
        dispose() {},
      }
    },
  }

  const gitRunner = async (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { stdout: 'true' }
    if (args[0] === 'worktree' && args[1] === 'list') return { stdout: 'worktree /proj/r\n' }
    if (args[0] === 'rev-parse' && args[3]?.includes('task/')) throw new Error('not found')
    if (args[0] === 'rev-parse' && args[3] === 'origin/main') return { stdout: 'hash123' }
    return { stdout: '' }
  }

  const task = {
    id: 'task-abc',
    title: 'Test issue',
    repo: '.',
    issueNumber: 42,
  }

  const config = withDefaults({
    defaultProjectRoot: process.cwd(),
    worktreeIsolation: true,
  })

  await obtainAgent({
    agents,
    task,
    config,
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    mintSessionId: () => 'session-123',
    cwdOf: () => process.cwd(),
    gitRunner,
  })

  assert.ok(createdMeta, 'сессия должна быть создана')
  assert.equal(createdMeta.cwd, process.cwd(), 'meta.cwd обязан указывать на корень проекта для правильной группировки в сайдбаре DSH')
  assert.equal(createdMeta.projectRoot, process.cwd())
  assert.ok(createdMeta.worktreePath, 'meta.worktreePath должен содержать путь к воркдереву')
  assert.notEqual(createdMeta.worktreePath, createdMeta.cwd, 'worktreePath не должен подменять meta.cwd')
})
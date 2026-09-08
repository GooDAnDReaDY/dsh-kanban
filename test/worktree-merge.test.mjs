import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeTaskWorktree } from '../lib/worktree.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('mergeTaskWorktree блокирует слияние, если воркдерево dirty (#212)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-merge-test-'))
  try {
    const fakeGitRunner = async (args) => {
      if (args[0] === 'status') return { exitCode: 0, stdout: ' M dirty_file.js\n' }
      return { exitCode: 0, stdout: '' }
    }

    const res = await mergeTaskWorktree({
      task: { worktree: dir, branch: 'feat/task-1' },
      gitRunner: fakeGitRunner,
    })

    assert.equal(res.success, false)
    assert.equal(res.error, 'worktree-dirty')
    assert.deepEqual(res.files, ['M dirty_file.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeTaskWorktree успешно выполняет git merge --no-ff и вызывает очистку (#212)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-merge-clean-'))
  try {
    const commandsRun = []
    const fakeGitRunner = async (args, cwd) => {
      commandsRun.push(args)
      if (args[0] === 'status') return { exitCode: 0, stdout: '' }
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { exitCode: 0, stdout: '/tmp/repo/.git' }
      }
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return { exitCode: 0, stdout: 'main\n' }
      }
      if (args[0] === 'merge' && args[1] === '--no-ff') {
        return { exitCode: 0, stdout: 'Merge made by the recursive strategy.\n' }
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return { exitCode: 0, stdout: '' }
      }
      if (args[0] === 'branch' && (args[1] === '-d' || args[1] === '-D')) {
        return { exitCode: 0, stdout: '' }
      }
      return { exitCode: 0, stdout: '' }
    }

    const task = {
      id: 'task-100',
      worktree: dir,
      branch: 'feat/task-100',
    }

    const res = await mergeTaskWorktree({
      task,
      targetBranch: 'main',
      gitRunner: fakeGitRunner,
    })

    assert.equal(res.success, true)
    assert.equal(res.merged, true)
    assert.equal(res.targetBranch, 'main')
    assert.ok(commandsRun.some((cmd) => cmd[0] === 'merge' && cmd[1] === '--no-ff'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
import test from 'node:test'
import assert from 'node:assert/strict'
import { findWorkspaceGitRepos, prepareMultiRepoMirror } from '../lib/worktree.js'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('findWorkspaceGitRepos обнаруживает вложенные git-репозитории (#210)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-multi-repo-test-'))
  try {
    const repoA = join(root, 'pkg-a')
    const repoB = join(root, 'pkg-b')
    mkdirSync(repoA)
    mkdirSync(repoB)

    const fakeGitRunner = async (args, cwd) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        if (cwd === repoA || cwd === repoB) return { exitCode: 0, stdout: 'true\n' }
        return { exitCode: 1, stdout: '' }
      }
      return { exitCode: 0, stdout: '' }
    }

    const repos = await findWorkspaceGitRepos(root, { gitRunner: fakeGitRunner })
    assert.equal(repos.length, 2)
    const names = repos.map((r) => r.name)
    assert.ok(names.includes('pkg-a'))
    assert.ok(names.includes('pkg-b'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepareMultiRepoMirror создаёт зеркальные воркдеревья для найденных репо (#210)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mirror-test-'))
  try {
    const repoA = join(root, 'frontend')
    const repoB = join(root, 'backend')
    mkdirSync(repoA)
    mkdirSync(repoB)

    const gitCommands = []
    const fakeGitRunner = async (args, cwd) => {
      gitCommands.push({ args, cwd })
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        // Только поддиректории считаем git-репозиториями, но не корень root
        if (cwd === repoA || cwd === repoB) return { exitCode: 0, stdout: 'true\n' }
        return { exitCode: 1, stdout: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { exitCode: 0, stdout: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { exitCode: 1, stdout: '' }
      }
      return { exitCode: 0, stdout: '' }
    }

    const res = await prepareMultiRepoMirror({
      task: { id: 'task-42', title: 'Refactor arch' },
      workspacePath: root,
      gitRunner: fakeGitRunner,
    })

    assert.equal(res.mirrors.length, 2)
    assert.ok(gitCommands.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

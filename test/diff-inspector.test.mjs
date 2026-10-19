import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { freshStore } from './helpers.mjs'
import { getTaskDiffInspector, discardTaskFile } from '../lib/worktree.js'
import { handleTaskDiff, handleTaskDiscard } from '../lib/routes.js'

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  writeFileSync(join(dir, 'initial.txt'), 'line 1\nline 2\nline 3\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir })
}

test('getTaskDiffInspector: returns empty result when no worktree', async () => {
  const res = await getTaskDiffInspector({ worktreePath: '' })
  assert.equal(res.worktree, false)
  assert.deepEqual(res.files, [])
  assert.equal(res.filesChanged, 0)
})

test('getTaskDiffInspector: detects modified, added, and untracked files (#371)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-diff-'))
  try {
    initGitRepo(dir)

    // 1. Modify initial.txt
    writeFileSync(join(dir, 'initial.txt'), 'line 1\nmodified line 2\nline 3\nline 4\n')

    // 2. Add new tracked file
    writeFileSync(join(dir, 'added.txt'), 'added content\n')
    execFileSync('git', ['add', 'added.txt'], { cwd: dir })

    // 3. Create untracked file
    writeFileSync(join(dir, 'untracked.txt'), 'untracked stuff\n')

    const res = await getTaskDiffInspector({ worktreePath: dir })
    assert.equal(res.worktree, true)
    assert.equal(res.files.length, 3)

    const initialFile = res.files.find((f) => f.path === 'initial.txt')
    assert.ok(initialFile)
    assert.equal(initialFile.status, 'modified')

    const addedFile = res.files.find((f) => f.path === 'added.txt')
    assert.ok(addedFile)
    assert.equal(addedFile.status, 'added')

    const untrackedFile = res.files.find((f) => f.path === 'untracked.txt')
    assert.ok(untrackedFile)
    assert.equal(untrackedFile.status, 'untracked')

    assert.ok(res.diff.includes('modified line 2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discardTaskFile: safely discards modified tracked file (#371)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-discard-'))
  try {
    initGitRepo(dir)

    // Modify file
    writeFileSync(join(dir, 'initial.txt'), 'dirty changes\n')
    assert.equal(existsSync(join(dir, 'initial.txt')), true)

    const res = await discardTaskFile({ worktreePath: dir, file: 'initial.txt' })
    assert.equal(res.success, true)
    assert.equal(res.tracked, true)

    // Content restored to original
    const restored = execFileSync('cat', [join(dir, 'initial.txt')]).toString('utf8')
    assert.equal(restored, 'line 1\nline 2\nline 3\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discardTaskFile: removes untracked file cleanly (#371)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-discard-untracked-'))
  try {
    initGitRepo(dir)

    const untrackedPath = join(dir, 'newfile.txt')
    writeFileSync(untrackedPath, 'garbage\n')
    assert.equal(existsSync(untrackedPath), true)

    const res = await discardTaskFile({ worktreePath: dir, file: 'newfile.txt' })
    assert.equal(res.success, true)
    assert.equal(res.tracked, false)
    assert.equal(existsSync(untrackedPath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discardTaskFile: strictly rejects path traversal attempts (#371)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-fencing-'))
  try {
    initGitRepo(dir)

    // Attempt ..
    const res1 = await discardTaskFile({ worktreePath: dir, file: '../outside.txt' })
    assert.equal(res1.success, false)
    assert.equal(res1.error, 'path-traversal-detected')

    // Attempt absolute path
    const res2 = await discardTaskFile({ worktreePath: dir, file: '/etc/passwd' })
    assert.equal(res2.success, false)
    assert.equal(res2.error, 'path-traversal-detected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handleTaskDiff & handleTaskDiscard: route integration (#371)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-route-'))
  try {
    initGitRepo(dir)
    writeFileSync(join(dir, 'dirty.txt'), 'junk\n')

    const task = { id: 'task-1', worktree: dir }

    // Diff
    const diffRes = await handleTaskDiff({
      task,
      getTaskDiffInspector,
    })
    assert.equal(diffRes.status, 200)
    assert.ok(diffRes.body.files.some((f) => f.path === 'dirty.txt'))

    // Discard
    const discardRes = await handleTaskDiscard({
      task,
      file: 'dirty.txt',
      discardTaskFile,
    })
    assert.equal(discardRes.status, 200)
    assert.equal(discardRes.body.success, true)
    assert.equal(existsSync(join(dir, 'dirty.txt')), false)

    // Invalid parameters
    const errRes = await handleTaskDiscard({ task, file: '', discardTaskFile })
    assert.equal(errRes.status, 400)
    assert.equal(errRes.body.error, 'file-required')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

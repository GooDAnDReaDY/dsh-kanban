import test from 'node:test'
import assert from 'node:assert/strict'
import { getTaskDiff, getTaskCommits } from '../lib/worktree.js'

test('getTaskDiff возвращает diff изменений и число файлов (#211)', async () => {
  const fakeGitRunner = async (args) => {
    if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'true\n' }
    if (args[0] === 'diff' && args[1] && args[1].includes('...HEAD')) {
      return {
        exitCode: 0,
        stdout: `diff --git a/foo.js b/foo.js\n--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/bar.js b/bar.js\n`,
      }
    }
    if (args[0] === 'diff' && args[1] === 'HEAD') {
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }

  const res = await getTaskDiff({
    worktreePath: '/tmp/test-wt',
    baseRef: 'main',
    gitRunner: fakeGitRunner,
  })

  assert.equal(res.filesChanged, 2)
  assert.equal(res.truncated, false)
  assert.ok(res.diff.includes('diff --git a/foo.js'))
})

test('getTaskCommits парсит список коммитов (#211)', async () => {
  const fakeGitRunner = async (args) => {
    if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'true\n' }
    if (args[0] === 'log') {
      return {
        exitCode: 0,
        stdout: `a1b2c3d\tAlice\t2026-09-08\tfeat: first commit\ne4f5g6h\tBob\t2026-09-08\tfix: second commit\n`,
      }
    }
    return { exitCode: 0, stdout: '' }
  }

  const commits = await getTaskCommits({
    worktreePath: '/tmp/test-wt',
    baseRef: 'main',
    gitRunner: fakeGitRunner,
  })

  assert.equal(commits.length, 2)
  assert.equal(commits[0].hash, 'a1b2c3d')
  assert.equal(commits[0].author, 'Alice')
  assert.equal(commits[0].subject, 'feat: first commit')
  assert.equal(commits[1].hash, 'e4f5g6h')
})
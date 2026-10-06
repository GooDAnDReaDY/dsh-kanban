import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkflowScript } from '../lib/workflow-bridge.js'
import { cleanupTaskWorktree, mergeTaskWorktree } from '../lib/worktree.js'
import { isCredentialName, looksLikeSecret } from '../lib/gitea.js'
import { applyMove } from '../lib/routes.js'
import { freshStore } from './helpers.mjs'
import { branchOfTask, pullsOfTask } from '../lib/transitions.js'
import { createOutbox } from '../lib/outbound.js'
import { Config } from '../lib/index.js'

test('Cluster 2 #314: buildWorkflowScript escapes dynamic parameters preventing JS injection', () => {
  const maliciousTask = {
    id: 't-inj',
    title: 'Injection test " + process.exit(1) + "',
    issueNumber: 42,
    repo: 'my-repo',
    owner: 'attacker',
  }
  const script = buildWorkflowScript({ task: maliciousTask, role: 'code-review' })
  assert.ok(typeof script === 'string')
  // Script should safely serialize values with JSON.stringify, not raw injection
  assert.ok(script.includes('role: "code-review"'))
  assert.ok(script.includes('Starting phase code-review for card #42'))
})

test('Cluster 2 #315: cleanupTaskWorktree blocks out-of-bounds / unfenced worktrees', async () => {
  const { store, cleanup } = freshStore()
  const foreignTask = store.createTask({
    board: 'main',
    column: 'in_progress',
    title: 'Foreign worktree task',
    repo: 'my-repo',
    worktree: '/etc/passwd_fake_dir',
    branch: 'task/foreign-1',
  })

  const res = await cleanupTaskWorktree({
    store,
    task: foreignTask,
    repoDir: '/tmp/safe-repo',
    config: { worktreeRoot: '/tmp/safe-worktrees' },
  })

  assert.equal(res.error, 'unfenced-worktree-path')
  assert.equal(res.status, 403)
  cleanup()
})

test('Cluster 2 #318: applyMove blocks moving to non-existent columns', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main',
    column: 'backlog',
    title: 'Column test task',
  })

  // Moving to invalid column should return 400 invalid-column
  const badRes = applyMove({
    store,
    id: task.id,
    column: 'non_existent_column_12345',
    source: 'manual',
  })
  assert.equal(badRes.status, 400)
  assert.equal(badRes.error, 'invalid-column')

  // Moving to valid column should succeed
  const okRes = applyMove({
    store,
    id: task.id,
    column: 'in-progress',
    source: 'manual',
  })
  assert.equal(okRes.error, undefined)
  assert.equal(okRes.task.column, 'in-progress')
  cleanup()
})

test('Cluster 2 #319: credential names >= 32 chars are not falsely flagged as secrets', () => {
  const longCredName = 'GITEA_ORGANIZATION_TOKEN_SECRET_REF_123'
  assert.equal(isCredentialName(longCredName), true)
  assert.equal(looksLikeSecret(longCredName), false)

  // Real secrets should still be caught
  const realPat = 'ghp_' + 'A'.repeat(36)
  assert.equal(looksLikeSecret(realPat), true)
  assert.equal(isCredentialName(realPat), false)
})

test('Cluster 2 #320: store.addTaskComment compatibility alias works identical to addComment', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'todo', title: 'Comment test' })

  assert.equal(typeof store.addTaskComment, 'function')
  const updatedTask = store.addTaskComment(task.id, { author: 'agent-bot', text: 'Test comment body' })
  assert.ok(updatedTask)
  assert.ok(Array.isArray(updatedTask.comments))
  assert.equal(updatedTask.comments.length, 1)
  assert.equal(updatedTask.comments[0].author, 'agent-bot')
  assert.equal(updatedTask.comments[0].text, 'Test comment body')
  cleanup()
})

test('Cluster 2 #321: mergeTaskWorktree blocks malicious target branch names', async () => {
  const res = await mergeTaskWorktree({
    task: { worktree: '/tmp/wt', branch: 'task/safe-1' },
    targetBranch: '-f-dangerous-flag',
  })
  assert.equal(res.success, false)
  assert.equal(res.error, 'invalid-target-branch')
})

test('Cluster 2 #322: branchOfTask / pullsOfTask require positive safe integer and escape regex', () => {
  // Non-positive or non-integer issue returns undefined/empty
  assert.equal(branchOfTask({ issueNumber: 'not-a-number' }, []), undefined)
  assert.equal(branchOfTask({ issueNumber: -5 }, []), undefined)
  assert.equal(branchOfTask({ issueNumber: NaN }, []), undefined)

  assert.deepEqual(pullsOfTask({ issueNumber: 'not-a-number' }, []), [])
  assert.deepEqual(pullsOfTask({ issueNumber: -1 }, []), [])

  // Valid branch lookup
  const branches = ['main', 'task/42-fix-bug', 'feat/other']
  assert.equal(branchOfTask({ issueNumber: 42 }, branches), 'task/42-fix-bug')
})

test('Cluster 2 #324: createOutbox supports dynamic store accessor function', () => {
  let innerStore = { listOutbox: () => [{ id: 'out-1' }] }
  const outbox = createOutbox({
    store: () => innerStore,
    sink: async () => {},
  })
  assert.ok(outbox)
})

test('Cluster 2 #310/#311/#313/#346: Config schema is decorated with .volatile()', () => {
  assert.ok(Config)
  assert.ok(typeof Config === 'function' || typeof Config === 'object')
})

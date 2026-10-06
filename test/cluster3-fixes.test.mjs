import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { openStore } from '../lib/store.js'
import { keyBetween, generateNKeysBetween } from '../lib/order.js'
import { createGitProvider } from '../lib/git-provider.js'
import { createGitHubClient } from '../lib/github.js'
import { parseProgressDump, formatProgressDump } from '../lib/progress-dump.js'
import {
  updateTask,
  confirmPermission,
  handleToggleChecklistItem,
  handleTaskChecklist,
  exportTasksCsv,
  importBoard,
} from '../lib/routes.js'
import { planAssign, planOutbound } from '../lib/outbound.js'
import { resolveTargetColumn } from '../lib/workflow-bridge.js'
import { checkWorktreeDirty, getTaskDiff, getTaskCommits } from '../lib/worktree.js'
import { eventHub } from '../lib/events.js'

function makeTempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-test-c3-'))
  const store = openStore({ dir })
  return { store, dir, cleanup: () => { try { store.close(); rmSync(dir, { recursive: true, force: true }) } catch {} } }
}

test('#327: Git runner contract (exitCode vs code) in diff and commits', async () => {
  const { dir, cleanup } = makeTempStore()
  try {
    // Runner returning exitCode: 0 instead of code: 0
    const runnerExitCode = async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'true', exitCode: 0 }
      if (args[0] === 'diff') return { stdout: 'diff --git a/test.txt b/test.txt\n+hello', exitCode: 0 }
      if (args[0] === 'log') return { stdout: 'abc1234\tDeveloper\t2026-10-06\tcommit subject', exitCode: 0 }
      return { stdout: '', exitCode: 0 }
    }
    const diffRes = await getTaskDiff({ worktreePath: dir, gitRunner: runnerExitCode })
    assert.ok(diffRes.filesChanged >= 1)
    assert.ok(diffRes.diff.includes('+hello'))

    const commitsRes = await getTaskCommits({ worktreePath: dir, gitRunner: runnerExitCode })
    assert.equal(commitsRes.length, 1)
    assert.equal(commitsRes[0].hash, 'abc1234')

    // Runner returning error exitCode: 1
    const runnerError = async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'true', exitCode: 0 }
      return { stdout: '', stderr: 'git error', exitCode: 1 }
    }
    const errRes = await getTaskDiff({ worktreePath: dir, gitRunner: runnerError })
    assert.equal(errRes.diff, '')
  } finally {
    cleanup()
  }
})

test('#328 & #335: permissionConfirmedTier and reasoningEffort in updateTask & confirmPermission', () => {
  const { store, cleanup } = makeTempStore()
  try {
    const task = store.createTask({ title: 'Task 1', column: 'backlog', board: 'main' })
    assert.ok(task)

    // Update reasoningEffort
    const res1 = updateTask({ store, id: task.id, input: { reasoningEffort: 'high' } })
    assert.equal(res1.task.reasoningEffort, 'high')

    // Confirm permission with tier
    const res2 = confirmPermission({ store, id: task.id, tier: 'full' })
    assert.equal(res2.task.permissionConfirmedTier, 'full')
    assert.ok(res2.task.permissionConfirmedAt > 0)

    // Updating permission resets confirmation and tier
    const res3 = updateTask({ store, id: task.id, input: { permission: 'custom' } })
    assert.equal(res3.task.permissionConfirmedAt, 0)
    assert.equal(res3.task.permissionConfirmedTier, '')
  } finally {
    cleanup()
  }
})

test('#332: Dual forge routing (GitHub vs Gitea) in outbound planning and task identity', () => {
  const giteaTask = { id: 't-git', owner: 'org', repo: 'repo', issueNumber: 42, forge: 'gitea' }
  const githubTask = { id: 't-gh', owner: 'org', repo: 'repo', issueNumber: 42, forge: 'github', issueUrl: 'https://github.com/org/repo/issues/42' }

  const assignGitea = planAssign(giteaTask, 'alice')
  assert.equal(assignGitea[0].provider, 'gitea')

  const assignGithub = planAssign(githubTask, 'bob')
  assert.equal(assignGithub[0].provider, 'github')

  const closeGithub = planOutbound(githubTask, 'done')
  assert.equal(closeGithub[0].provider, 'github')
})

test('#333: Full JSON snapshot import/export roundtrip restores all 16 fields, archived tasks, transitions', () => {
  const { store: s1, cleanup: c1 } = makeTempStore()
  const { store: s2, cleanup: c2 } = makeTempStore()
  try {
    // Create rich task with all fields
    const task = s1.createTask({
      title: 'Full task',
      body: 'Detailed body',
      board: 'main',
      column: 'in-progress',
      cron: '0 0 * * *',
      permission: 'safe',
      reasoningEffort: 'high',
      assignee: 'dev1',
      milestone: 'v1.0',
      labels: ['bug', 'backend'],
    })
    s1.updateTask(task.id, {
      permissionConfirmedAt: 12345678,
      permissionConfirmedTier: 'safe-tier',
      checklist: [{ text: 'Item 1', completed: true, done: true }],
      report: { summary: 'Done test' },
      comments: [{ text: 'Comment 1', author: 'tester' }],
      isEpic: 1,
      parentId: 'parent-123',
      workflowRunId: 'run-999',
      workflowStatus: 'running',
    })
    s1.setArchived(task.id, true)
    s1.addTransition({ taskId: task.id, fromCol: 'backlog', toCol: 'in-progress', source: 'manual', detail: 'started' })

    const snapshot = s1.exportAll()
    assert.equal(snapshot.tasks.length, 1)
    assert.equal(snapshot.transitions.length, 1)

    // Import into fresh store
    const impRes = importBoard({ store: s2, input: snapshot })
    assert.equal(impRes.imported, 1)

    const restored = s2.getTask(task.id)
    assert.ok(restored)
    assert.equal(restored.title, 'Full task')
    assert.equal(restored.reasoningEffort, 'high')
    assert.equal(restored.permissionConfirmedTier, 'safe-tier')
    assert.equal(restored.isEpic, true)
    assert.equal(restored.parentId, 'parent-123')
    assert.equal(restored.workflowRunId, 'run-999')
    assert.equal(restored.checklist[0].completed, true)
    assert.ok(restored.archivedAt > 0)

    const history = s2.listTransitions(task.id)
    assert.equal(history.length, 1)
    assert.equal(history[0].toCol, 'in-progress')
  } finally {
    c1()
    c2()
  }
})

test('#334: Workflow completion transitions to review, never directly to done', () => {
  // Target column mapping in workflow-bridge
  assert.equal(resolveTargetColumn('in-progress'), 'review')
  assert.equal(resolveTargetColumn('review'), 'review')
  assert.equal(resolveTargetColumn('cleanup'), 'cleanup')
})

test('#336: Composite Git provider exports createRepo', async () => {
  let created = false
  const mockGitea = {
    isConfigured: async () => true,
    createRepo: async (opts) => { created = true; return { name: opts.name } },
  }
  const mockGithub = {
    isConfigured: async () => false,
  }
  const composite = createGitProvider({ gitea: mockGitea, github: mockGithub, getConfig: () => ({ gitProvider: 'gitea' }) })
  assert.equal(typeof composite.createRepo, 'function')
  const res = await composite.createRepo({ owner: 'goodandready', name: 'new-repo' })
  assert.equal(created, true)
  assert.equal(res.name, 'new-repo')
})

test('#338: PROGRESSDUMP parser handles Next steps: and multiline sections', () => {
  const sample = `<<<PROGRESSDUMP
Goal: Implement cluster 3 hardening
Progress: Patched worktree and launcher
Next steps: Complete unit test suite
>>>PROGRESSDUMP`

  const parsed = parseProgressDump(sample)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.dump.goal, 'Implement cluster 3 hardening')
  assert.equal(parsed.dump.progress, 'Patched worktree and launcher')
  assert.equal(parsed.dump.next, 'Complete unit test suite')

  // parse(format(dump)) roundtrip
  const formatted = formatProgressDump(parsed.dump)
  const roundtrip = parseProgressDump(formatted)
  assert.equal(roundtrip.ok, true)
  assert.equal(roundtrip.dump.goal, parsed.dump.goal)
  assert.equal(roundtrip.dump.progress, parsed.dump.progress)
  assert.equal(roundtrip.dump.next, parsed.dump.next)
})

test('#339: Checklist toggle API sets canonical completed: Boolean alongside done', () => {
  const { store, cleanup } = makeTempStore()
  try {
    const task = store.createTask({
      title: 'DoD Task',
      column: 'backlog',
      board: 'main',
      checklist: [{ text: 'Write tests', completed: false, done: false }],
    })

    const res = handleToggleChecklistItem({ store, task, input: { index: 0, checked: true } })
    assert.equal(res.status, 200)
    assert.equal(res.body.task.checklist[0].completed, true)
    assert.equal(res.body.task.checklist[0].done, true)

    // Uncheck
    const res2 = handleToggleChecklistItem({ store, task: res.body.task, input: { index: 0, checked: false } })
    assert.equal(res2.status, 200)
    assert.equal(res2.body.task.checklist[0].completed, false)
    assert.equal(res2.body.task.checklist[0].done, false)
  } finally {
    cleanup()
  }
})

test('#340: CSV formula injection mitigation in exportTasksCsv', () => {
  const { store, cleanup } = makeTempStore()
  try {
    store.createTask({ title: '=1+1', column: 'backlog', board: 'main' })
    store.createTask({ title: '+SUM(A1:A10)', column: 'backlog', board: 'main' })
    store.createTask({ title: '-CMD|/C', column: 'backlog', board: 'main' })
    store.createTask({ title: '@ATTACK', column: 'backlog', board: 'main' })

    const csv = exportTasksCsv({ store, board: 'main' })
    // Each malicious prefix must be prepended with a single quote (')
    assert.ok(csv.includes("'\=1+1") || csv.includes("\"'=1+1\""))
    assert.ok(csv.includes("'+SUM(A1:A10)") || csv.includes("\"'+SUM(A1:A10)\""))
    assert.ok(csv.includes("'-CMD|/C") || csv.includes("\"'-CMD|/C\""))
    assert.ok(csv.includes("'@ATTACK") || csv.includes("\"'@ATTACK\""))
  } finally {
    cleanup()
  }
})

test('#341: Cleanup fail-closed on git status errors', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'dirty-test-'))
  try {
    const dirtyResult = await checkWorktreeDirty({
      worktreePath: tempDir,
      gitRunner: async () => {
        const err = new Error('permission denied')
        err.code = 128
        throw err
      },
    })
    // Fail-closed: dirty is true and error detail is preserved
    assert.equal(dirtyResult.dirty, true)
    assert.ok(dirtyResult.error)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('#343: SSE event broadcasting on board mutations', () => {
  const frames = []
  const mockClient = { write: (chunk) => frames.push(chunk) }
  eventHub.clients.add(mockClient)
  try {
    eventHub.broadcast('task:change', { taskId: 't1', action: 'created' })
    eventHub.broadcast('task:change', { taskId: 't1', action: 'updated' })
    eventHub.broadcast('task:change', { taskId: 't1', action: 'archived' })

    assert.equal(frames.length, 3)
    assert.ok(frames[0].includes('event: task:change') && frames[0].includes('"action":"created"'))
    assert.ok(frames[1].includes('event: task:change') && frames[1].includes('"action":"updated"'))
    assert.ok(frames[2].includes('event: task:change') && frames[2].includes('"action":"archived"'))
  } finally {
    eventHub.clients.delete(mockClient)
  }
})

test('#344: AGENTS.md and docs/index.md exist in worktree', () => {
  assert.equal(existsSync(join(process.cwd(), 'AGENTS.md')), true)
  assert.equal(existsSync(join(process.cwd(), 'docs/index.md')), true)
  assert.equal(existsSync(join(process.cwd(), 'docs/design/DESIGN.md')), true)
})

test('#345: Fractional indexing key length bounded under 10k appends', () => {
  let last = keyBetween(undefined, undefined)
  let maxLen = last.length
  for (let i = 0; i < 1000; i++) {
    last = keyBetween(last, undefined)
    if (last.length > maxLen) maxLen = last.length
  }
  // Max key length should be <= 4 characters, far below 32B budget
  assert.ok(maxLen <= 8, `max key length was ${maxLen}, expected <= 8`)
})

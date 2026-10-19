import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { freshStore } from './helpers.mjs'
import { runVerificationGate, sendVerificationFailurePrompt, verifyAndRecordGate } from '../lib/verification.js'
import { boardMoveDefinition } from '../lib/board-tool.js'

function mockSpawnSuccess(stdoutText = 'All tests passed') {
  return () => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from(stdoutText))
      proc.emit('close', 0, null)
    })
    return proc
  }
}

function mockSpawnFailure(stderrText = 'Error: 2 tests failed', exitCode = 1) {
  return () => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    process.nextTick(() => {
      proc.stderr.emit('data', Buffer.from(stderrText))
      proc.emit('close', exitCode, null)
    })
    return proc
  }
}

test('runVerificationGate: skips when worktree does not exist', async () => {
  const res = await runVerificationGate({
    task: { worktree: '/nonexistent/path/12345' },
    config: { verificationGateEnabled: true },
  })
  assert.equal(res.passed, true)
  assert.equal(res.skipped, true)
  assert.equal(res.skipReason, 'worktree-not-found')
})

test('runVerificationGate: skips when gate is disabled and no task command set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-'))
  try {
    const res = await runVerificationGate({
      task: { worktree: dir },
      config: { verificationGateEnabled: false },
    })
    assert.equal(res.passed, true)
    assert.equal(res.skipped, true)
    assert.equal(res.skipReason, 'gate-disabled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runVerificationGate: skips when default npm test but no package.json in worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-'))
  try {
    const res = await runVerificationGate({
      task: { worktree: dir },
      config: { verificationGateEnabled: true, verificationCommand: 'npm test' },
    })
    assert.equal(res.passed, true)
    assert.equal(res.skipped, true)
    assert.equal(res.skipReason, 'no-package-json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runVerificationGate: executes command and passes on exitCode 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    const res = await runVerificationGate({
      task: { worktree: dir },
      config: { verificationGateEnabled: true },
      spawnRunner: mockSpawnSuccess('PASS: 10 tests passed'),
    })
    assert.equal(res.passed, true)
    assert.equal(res.exitCode, 0)
    assert.ok(res.stdout.includes('PASS: 10 tests passed'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runVerificationGate: fails on exitCode != 0 and captures error snippet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    const res = await runVerificationGate({
      task: { worktree: dir },
      config: { verificationGateEnabled: true },
      spawnRunner: mockSpawnFailure('FAIL: assertion failed in index.test.js', 1),
    })
    assert.equal(res.passed, false)
    assert.equal(res.exitCode, 1)
    assert.ok(res.logSnippet.includes('FAIL: assertion failed'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sendVerificationFailurePrompt: sends formatted message to agent session', () => {
  let followedUp = null
  const mockAgent = {
    followup(msg) { followedUp = msg },
  }
  const mockAgents = {
    get(sid) { return sid === 'session-123' ? mockAgent : undefined },
  }

  const sent = sendVerificationFailurePrompt({
    agents: mockAgents,
    task: { sessionId: 'session-123' },
    createMessage: (input) => ({ ...input, id: 'm-1' }),
    command: 'npm test',
    exitCode: 1,
    logSnippet: 'SyntaxError: Unexpected token',
  })

  assert.equal(sent, true)
  assert.ok(followedUp)
  assert.ok(followedUp.content[0].text.includes('Automated verification before Review failed'))
  assert.ok(followedUp.content[0].text.includes('SyntaxError: Unexpected token'))
})

test('verifyAndRecordGate: records passed status in task report', async () => {
  const { store, cleanup } = freshStore()
  const dir = mkdtempSync(join(tmpdir(), 'vgate-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    const task = store.createTask({ title: 'Gate test', column: 'in-progress', worktree: dir })

    const res = await verifyAndRecordGate({
      task,
      config: { verificationGateEnabled: true },
      store,
      spawnRunner: mockSpawnSuccess('778 tests pass'),
    })

    assert.equal(res.allowed, true)
    const updated = store.getTask(task.id)
    assert.equal(updated.report?.verification?.status, 'passed')
    assert.equal(updated.verificationStatus, 'passed')
  } finally {
    cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyAndRecordGate: blocks move, records failed status and comment on failure', async () => {
  const { store, cleanup } = freshStore()
  const dir = mkdtempSync(join(tmpdir(), 'vgate-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    const task = store.createTask({ title: 'Gate fail test', column: 'in-progress', worktree: dir, sessionId: 's-1' })

    let agentFollowup = null
    const mockAgents = {
      get: () => ({ followup: (msg) => { agentFollowup = msg } }),
    }

    const res = await verifyAndRecordGate({
      task,
      config: { verificationGateEnabled: true },
      store,
      agents: mockAgents,
      createMessage: (m) => m,
      spawnRunner: mockSpawnFailure('Error: failed test', 1),
    })

    assert.equal(res.allowed, false)
    const updated = store.getTask(task.id)
    assert.equal(updated.report?.verification?.status, 'failed')
    assert.equal(updated.verificationStatus, 'failed')
    assert.ok(updated.report?.verification?.log.includes('Error: failed test'))

    // Comment added
    assert.ok(Array.isArray(updated.comments))
    assert.ok(updated.comments.some((c) => c.text.includes('[Verification Gate Failed]')))

    // Agent received prompt
    assert.ok(agentFollowup)
    assert.ok(agentFollowup.content[0].text.includes('Automated verification'))
  } finally {
    cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('board_move: blocks move to review if verification gate fails (#372)', async () => {
  const { store, cleanup } = freshStore()
  const dir = mkdtempSync(join(tmpdir(), 'vgate-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    const task = store.createTask({ title: 'Tool move test', column: 'in-progress', worktree: dir, sessionId: 's-tool' })

    const tool = boardMoveDefinition({
      store,
      config: () => ({ verificationGateEnabled: true }),
    })

    const exec = {
      agent: { session: { id: 's-tool' } },
      session: { id: 's-tool' },
      agents: { get: () => ({ followup: () => {} }) },
      createMessage: (m) => m,
    }

    // Temporarily replace child_process or rely on real execution failing if command is non-existent
    // Set custom invalid verification command on task
    store.updateTask(task.id, { verificationCommand: 'node -e "process.exit(1)"' })

    const outcome = await tool.execute({ column: 'review', task: task.id }, exec)
    assert.ok(outcome.includes('Cannot move card to review: verification command'))
    assert.ok(outcome.includes('failed with exit code 1'))

    // Card remains in in-progress
    const current = store.getTask(task.id)
    assert.equal(current.column, 'in-progress')
  } finally {
    cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('board_move: allows move to review if verification passes (#372)', async () => {
  const { store, cleanup } = freshStore()
  const dir = mkdtempSync(join(tmpdir(), 'vgate-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    const task = store.createTask({ title: 'Tool move success test', column: 'in-progress', worktree: dir, sessionId: 's-tool-ok' })

    const tool = boardMoveDefinition({
      store,
      config: () => ({ verificationGateEnabled: true }),
    })

    const exec = {
      agent: { session: { id: 's-tool-ok' } },
      session: { id: 's-tool-ok' },
    }

    store.updateTask(task.id, { verificationCommand: 'node -e "process.exit(0)"' })

    const outcome = await tool.execute({ column: 'review', task: task.id }, exec)
    assert.ok(outcome.includes('Card moved to review'))

    const current = store.getTask(task.id)
    assert.equal(current.column, 'review')
    assert.equal(current.report?.verification?.status, 'passed')
  } finally {
    cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { handleTaskGeneratePlan, handleTaskPrDescription } from '../lib/routes/task-actions.js'
import { parsePlan } from '../lib/plan.js'
import { freshStore } from './helpers.mjs'

test('handleTaskGeneratePlan generates and persists spec and plan (#376)', async () => {
  const { store, cleanup } = freshStore()
  try {
    const task = store.createTask({
      board: 'main',
      column: 'backlog',
      title: 'Implement search feature',
      body: 'Need full-text search in task title and body. Touch lib/filters.js and test/filters.test.mjs.',
      issueNumber: 101,
    })

    let broadcastSeen = null
    const eventHub = {
      broadcast(evt, payload) {
        broadcastSeen = { evt, payload }
      },
    }

    const res = await handleTaskGeneratePlan({
      store,
      id: task.id,
      body: {},
      eventHub,
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.success, true)
    assert.ok(res.body.spec.includes('# Technical Specification: Implement search feature #101'))
    assert.ok(res.body.items.length >= 3)

    const updated = store.getTask(task.id)
    assert.equal(updated.spec, res.body.spec)
    const parsedPlan = parsePlan(updated.plan)
    assert.deepEqual(parsedPlan.items, res.body.items)

    assert.equal(broadcastSeen?.evt, 'task:change')
    assert.equal(broadcastSeen?.payload?.action, 'plan-generated')
  } finally {
    cleanup()
  }
})

test('handleTaskPrDescription generates PR description and release notes (#379)', async () => {
  const { store, cleanup } = freshStore()
  try {
    const task = store.createTask({
      board: 'main',
      column: 'review',
      title: 'M: Feature: Advanced Telemetry',
      body: 'Add token telemetry and cost calculation.',
      issueNumber: 374,
      report: {
        verification: { status: 'passed', command: 'npm test' },
      },
    })

    // 1. GET generates description
    const resGet = await handleTaskPrDescription({
      store,
      id: task.id,
      method: 'GET',
      body: {},
    })

    assert.equal(resGet.status, 200)
    assert.ok(resGet.body.title.includes('Advanced Telemetry (#374)'))
    assert.ok(resGet.body.prDescription.includes('### Problem'))
    assert.ok(resGet.body.prDescription.includes('Add token telemetry and cost calculation.'))
    assert.ok(resGet.body.prDescription.includes('**✓ Tests Passed**'))
    assert.ok(resGet.body.prDescription.includes('Closes #374'))
    assert.ok(resGet.body.releaseNotes.includes('Advanced Telemetry (#374)'))

    // 2. POST saves edited description
    const customDesc = 'Custom edited description for PR'
    const resPost = await handleTaskPrDescription({
      store,
      id: task.id,
      method: 'POST',
      body: { prDescription: customDesc },
    })

    assert.equal(resPost.status, 200)
    const updated = store.getTask(task.id)
    assert.equal(updated.prDescription, customDesc)
  } finally {
    cleanup()
  }
})

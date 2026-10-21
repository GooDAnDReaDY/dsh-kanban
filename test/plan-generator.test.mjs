import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inferScope,
  inferCandidateFiles,
  generateTechnicalSpec,
  extractPlanItems,
  parseSpecMarkdown,
  formatPlanPrompt,
} from '../lib/plan-generator.js'

test('inferScope identifies domain from task labels and title (#376)', () => {
  assert.equal(inferScope({ labels: ['scope/webui'] }), 'webui')
  assert.equal(inferScope({ labels: ['priority/low', 'scope/settings'] }), 'settings')
  assert.equal(inferScope({ title: 'Add new board card component' }), 'webui')
  assert.equal(inferScope({ title: 'Create new agent tool for moving' }), 'agent-tools')
  assert.equal(inferScope({ title: 'Fix worktree branch resolution' }), 'worktree')
  assert.equal(inferScope({ title: 'Add auth middleware to routing' }), 'security')
  assert.equal(inferScope({ title: 'General internal maintenance' }), 'core')
})

test('inferCandidateFiles discovers paths mentioned in task description (#376)', () => {
  const task = {
    title: 'Update config and store',
    body: 'Please modify lib/config.js and test/config.test.mjs. Also see docs/design/DESIGN.md.',
  }
  const files = inferCandidateFiles(task, 'settings')
  assert.ok(files.includes('lib/config.js'))
  assert.ok(files.includes('test/config.test.mjs'))
  assert.ok(files.includes('docs/design/DESIGN.md'))
})

test('inferCandidateFiles falls back to canonical scope files when none mentioned (#376)', () => {
  const task = { title: 'Implement dark theme support', body: 'Support theme variables.' }
  const files = inferCandidateFiles(task, 'webui')
  assert.ok(files.includes('lib/client.js'))
  assert.ok(files.includes('test/board-ui.test.mjs'))
  assert.ok(files.includes('CHANGELOG.md'))
})

test('generateTechnicalSpec creates structured markdown and plan items (#376)', () => {
  const task = {
    id: 't-123',
    title: 'AI Spec & Plan Generator for Backlog',
    body: 'Need automated technical specification generation for backlog tasks.',
    issueNumber: 376,
    repo: 'dsh-kanban',
  }

  const result = generateTechnicalSpec(task, {
    customInstructions: 'Ensure 0 Cyrillic in lib/',
    additionalFiles: ['lib/plan-generator.js'],
  })

  assert.ok(result.spec.includes('# Technical Specification: AI Spec & Plan Generator for Backlog #376'))
  assert.ok(result.spec.includes('## 1. Problem Statement & Context'))
  assert.ok(result.spec.includes('## 2. Target Components & Candidate Files'))
  assert.ok(result.spec.includes('lib/plan-generator.js'))
  assert.ok(result.spec.includes('## 3. Step-by-Step Implementation Algorithm'))
  assert.ok(result.spec.includes('## 4. Edge Cases & Validation Rules'))
  assert.ok(result.spec.includes('## 5. Verification Plan'))
  assert.ok(result.spec.includes('## 6. Special Instructions'))
  assert.ok(result.spec.includes('Ensure 0 Cyrillic in lib/'))

  assert.ok(Array.isArray(result.items))
  assert.equal(result.items.length, 5)
  assert.ok(result.summary.includes('Spec generated for AI Spec & Plan Generator for Backlog #376'))
})

test('extractPlanItems extracts step list from markdown (#376)', () => {
  const md = `
# Plan
## Algorithm
1. Inspect code
2. Write unit tests
3. Implement logic
4. Run verification
`
  const items = extractPlanItems(md)
  assert.equal(items.length, 4)
  assert.equal(items[0], 'Inspect code')
  assert.equal(items[1], 'Write unit tests')
  assert.equal(items[2], 'Implement logic')
  assert.equal(items[3], 'Run verification')
})

test('parseSpecMarkdown parses markdown and returns items (#376)', () => {
  const md = `
## Steps
- [ ] Task A
- [ ] Task B
`
  const parsed = parseSpecMarkdown(md)
  assert.equal(parsed.spec, md.trim())
  assert.equal(parsed.items.length, 2)
  assert.equal(parsed.items[0], 'Task A')
  assert.equal(parsed.items[1], 'Task B')
})

test('formatPlanPrompt formats spec or items for agent prompt (#376)', () => {
  assert.equal(formatPlanPrompt(null), '')
  assert.equal(formatPlanPrompt({}), '')

  const taskWithSpec = { spec: '# My Spec\nDetails' }
  const promptSpec = formatPlanPrompt(taskWithSpec)
  assert.ok(promptSpec.includes('### Approved Technical Specification & Implementation Plan:'))
  assert.ok(promptSpec.includes('# My Spec'))

  const taskWithItems = { plan: { items: ['Step 1', 'Step 2'] } }
  const promptItems = formatPlanPrompt(taskWithItems)
  assert.ok(promptItems.includes('### Approved Implementation Plan Steps:'))
  assert.ok(promptItems.includes('1. Step 1'))
  assert.ok(promptItems.includes('2. Step 2'))
})

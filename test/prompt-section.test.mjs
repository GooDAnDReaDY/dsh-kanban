import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPromptSectionText, CONFIG_DEFAULTS } from '../lib/config.js'

test('buildPromptSectionText: stock defaults return null (no tools or dump promised)', () => {
  // Stock default: announceToAgent: true, boardToolEnabled: false, progressDumpEnabled: false
  const res = buildPromptSectionText(CONFIG_DEFAULTS)
  assert.equal(res, null, 'Stock defaults must not promise tools that are unregistered')
})

test('buildPromptSectionText: undefined or empty config returns null', () => {
  assert.equal(buildPromptSectionText(undefined), null)
  assert.equal(buildPromptSectionText({}), null)
})

test('buildPromptSectionText: announceToAgent === false suppresses prompt even when tools enabled', () => {
  const cfg = {
    announceToAgent: false,
    boardToolEnabled: true,
    progressDumpEnabled: true,
  }
  assert.equal(buildPromptSectionText(cfg), null)
})

test('buildPromptSectionText: boardToolEnabled === true includes board_move and board_plan', () => {
  const cfg = {
    announceToAgent: true,
    boardToolEnabled: true,
    progressDumpEnabled: false,
  }
  const text = buildPromptSectionText(cfg)
  assert.ok(text.includes('board_move'), 'Should mention board_move')
  assert.ok(text.includes('board_plan'), 'Should mention board_plan')
  assert.ok(!text.includes('PROGRESSDUMP'), 'Should NOT mention PROGRESSDUMP when progressDumpEnabled is false')
})

test('buildPromptSectionText: progressDumpEnabled === true includes PROGRESSDUMP block', () => {
  const cfg = {
    announceToAgent: true,
    boardToolEnabled: false,
    progressDumpEnabled: true,
  }
  const text = buildPromptSectionText(cfg)
  assert.ok(text.includes('PROGRESSDUMP'), 'Should mention PROGRESSDUMP')
  assert.ok(!text.includes('board_move'), 'Should NOT mention board_move when boardToolEnabled is false')
  assert.ok(!text.includes('board_plan'), 'Should NOT mention board_plan when boardToolEnabled is false')
})

test('buildPromptSectionText: both boardToolEnabled and progressDumpEnabled enabled', () => {
  const cfg = {
    announceToAgent: true,
    boardToolEnabled: true,
    progressDumpEnabled: true,
  }
  const text = buildPromptSectionText(cfg)
  assert.ok(text.includes('board_move'), 'Should mention board_move')
  assert.ok(text.includes('board_plan'), 'Should mention board_plan')
  assert.ok(text.includes('PROGRESSDUMP'), 'Should mention PROGRESSDUMP')
})

test('syncPromptSection mock lifecycle: attaches and disposes section on rearm', () => {
  let disposed = false
  let registeredSection = null

  const mockSystemPrompt = {
    section(spec) {
      registeredSection = spec
      return () => { disposed = true }
    }
  }

  // Simulate sync logic matching lib/index.js
  let disposePromptSection
  const sync = (cfg) => {
    if (disposePromptSection) {
      try { disposePromptSection() } catch {}
      disposePromptSection = undefined
    }
    const text = buildPromptSectionText(cfg)
    if (text && mockSystemPrompt && typeof mockSystemPrompt.section === 'function') {
      disposePromptSection = mockSystemPrompt.section({
        name: 'plugin:dsh-kanban',
        order: 200,
        text,
      })
    }
  }

  // 1. Initial stock config -> nothing registered
  sync(CONFIG_DEFAULTS)
  assert.equal(registeredSection, null)
  assert.equal(disposePromptSection, undefined)

  // 2. Enable boardToolEnabled -> registers section with tool text
  sync({ announceToAgent: true, boardToolEnabled: true, progressDumpEnabled: false })
  assert.ok(registeredSection)
  assert.equal(registeredSection.name, 'plugin:dsh-kanban')
  assert.equal(registeredSection.order, 200)
  assert.ok(registeredSection.text.includes('board_move'))
  assert.equal(disposed, false)

  // 3. User disables board tools -> cleans up old section, leaves unregistered
  registeredSection = null
  sync({ announceToAgent: true, boardToolEnabled: false, progressDumpEnabled: false })
  assert.equal(disposed, true)
  assert.equal(registeredSection, null)
  assert.equal(disposePromptSection, undefined)
})

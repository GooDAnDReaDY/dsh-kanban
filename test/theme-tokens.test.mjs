import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.join(here, '..', 'lib')

// Canonical alias tokens from official @deepseek-ai/dsh-client-ui-theme@0.2.0-rc.2 (exact 107 definitions)
const CANONICAL_CORE_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-document-preview',
  '--dsw-alias-bg-document-selection',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-bg-mask-2',
  '--dsw-alias-bg-mask-3',
  '--dsw-alias-bg-mask-drop',
  '--dsw-alias-bg-mask-photo',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-multi-select',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-skeleton',
  '--dsw-alias-border-inverted',
  '--dsw-alias-border-inverted2',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l2-darkmode-thin',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary',
  '--dsw-alias-brand-primary-invert',
  '--dsw-alias-brand-primary-new-colorprimary-new-color',
  '--dsw-alias-brand-text',
  '--dsw-alias-button-contrast-fill',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-floating-fill',
  '--dsw-alias-button-floating-hover',
  '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-ghost-active-hover',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-tool-bar-fill',
  '--dsw-alias-button-tool-bar-fill-invisible',
  '--dsw-alias-button-tool-bar-hover',
  '--dsw-alias-code-diff-added',
  '--dsw-alias-code-diff-deleted',
  '--dsw-alias-file-diff-added-bg',
  '--dsw-alias-file-diff-added-gutter',
  '--dsw-alias-file-diff-added-marker',
  '--dsw-alias-file-diff-deleted-bg',
  '--dsw-alias-file-diff-deleted-gutter',
  '--dsw-alias-file-diff-deleted-marker',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-deep-diving',
  '--dsw-alias-label-deep-diving-shimmer',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-document-preview',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-bluish',
  '--dsw-alias-label-primary-dimmed',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-primary-inverted',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-shimmer',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-link',
  '--dsw-alias-markdown-citation',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-code-block-banner',
  '--dsw-alias-markdown-code-segment-selected',
  '--dsw-alias-markdown-code-segment-unselected',
  '--dsw-alias-markdown-inline-code',
  '--dsw-alias-markdown-placeholder',
  '--dsw-alias-markdown-tag',
  '--dsw-alias-menu-group-header-fill',
  '--dsw-alias-menu-icon',
  '--dsw-alias-onboarding-accent',
  '--dsw-alias-onboarding-card-fill',
  '--dsw-alias-onboarding-checkbox-border',
  '--dsw-alias-onboarding-secondary-fill',
  '--dsw-alias-scrollbar-bg-l1',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l1',
  '--dsw-alias-scrollbar-hover-l2',
  '--dsw-alias-settings-card-fill',
  '--dsw-alias-settings-card-stroke',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-error-secondary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-success-secondary',
  '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-secondary',
  '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-switch-thumb',
  '--dsw-alias-toast-bg',
  '--dsw-alias-toast-label',
  '--dsw-alias-tooltip-bg',
  '--dsw-alias-tooltip-key-bg',
  '--dsw-alias-turn-trigger-bg',
  '--dsw-alias-turn-trigger-bg-hover',
])

function scanDirectory(dir, fileList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDirectory(full, fileList)
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      fileList.push(full)
    }
  }
  return fileList
}

test('Issue #364: all --dsw-alias tokens in lib/ must exist in canonical core tokens set', () => {
  assert.equal(CANONICAL_CORE_TOKENS.size, 107)

  // Verify non-canonical phantom tokens are strictly rejected
  const nonCanonicalTokens = [
    '--dsw-alias-state-danger-primary',
    '--dsw-alias-state-danger-bg',
    '--dsw-alias-state-danger-border',
    '--dsw-alias-state-info-primary',
    '--dsw-alias-state-info-bg',
    '--dsw-alias-state-success-bg',
    '--dsw-alias-state-success-border',
    '--dsw-alias-state-warn-bg',
    '--dsw-alias-state-warn-border',
    '--dsw-alias-label-error',
    '--dsw-alias-label-inverse',
    '--dsw-alias-label-link',
    '--dsw-alias-mask-bg',
    '--dsw-alias-status-danger',
  ]
  for (const token of nonCanonicalTokens) {
    assert.equal(CANONICAL_CORE_TOKENS.has(token), false, `Token ${token} must not be in canonical set`)
  }

  const files = scanDirectory(libDir)
  const tokenRegex = /--dsw-alias-[a-zA-Z0-9-]+/g
  const invalidOccurrences = []

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    const matches = content.match(tokenRegex) || []
    const relPath = path.relative(path.join(here, '..'), file)
    for (const token of matches) {
      if (!CANONICAL_CORE_TOKENS.has(token)) {
        invalidOccurrences.push({ file: relPath, token })
      }
    }
  }

  assert.equal(
    invalidOccurrences.length,
    0,
    `Found invalid theme tokens:\n${JSON.stringify(invalidOccurrences, null, 2)}`
  )
})

test('Issue #366: zero Cyrillic literals in lib/ and no schemaProto monkeypatch', () => {
  const files = scanDirectory(libDir)
  const cyrillicRegex = /[\u0400-\u04FF]/g
  const cyrillicViolations = []

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    const matches = content.match(cyrillicRegex)
    if (matches && matches.length > 0) {
      const relPath = path.relative(path.join(here, '..'), file)
      cyrillicViolations.push({ file: relPath, count: matches.length })
    }
  }

  assert.equal(
    cyrillicViolations.length,
    0,
    `Found Cyrillic characters in lib/:\n${JSON.stringify(cyrillicViolations, null, 2)}`
  )

  // Verify index.js has no schemaProto monkeypatch
  const indexJs = fs.readFileSync(path.join(libDir, 'index.js'), 'utf8')
  assert.equal(indexJs.includes('schemaProto'), false, 'lib/index.js must not contain schemaProto monkeypatch')
})
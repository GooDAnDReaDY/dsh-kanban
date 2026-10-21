// Technical specification and execution plan generator for backlog/todo tasks (#376).
// Zero Cyrillic literals in lib/ per Issue #366.

import { MAX_ITEMS } from './plan.js'

/**
 * Truncate clean item text to reasonable single-line display length.
 *
 * @param {string} text Raw item text
 * @returns {string} Truncated clean item
 */
function cleanItemText(text) {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim()
  return cleaned.length > 120 ? cleaned.slice(0, 119) + '…' : cleaned
}

/**
 * Infer primary scope category from title, labels or body.
 *
 * @param {object} task Task record
 * @returns {string} Scope name
 */
export function inferScope(task) {
  const title = String(task?.title ?? '').toLowerCase()
  const labels = Array.isArray(task?.labels) ? task.labels.map((l) => String(l).toLowerCase()) : []
  for (const label of labels) {
    if (label.startsWith('scope/')) return label.slice(6)
  }
  if (title.includes('ui') || title.includes('view') || title.includes('board') || title.includes('card')) return 'webui'
  if (title.includes('tool') || title.includes('agent')) return 'agent-tools'
  if (title.includes('setting') || title.includes('config')) return 'settings'
  if (title.includes('worktree') || title.includes('branch') || title.includes('git')) return 'worktree'
  if (title.includes('security') || title.includes('auth')) return 'security'
  if (title.includes('route') || title.includes('api') || title.includes('server')) return 'routing'
  return 'core'
}

/**
 * Infer candidate files touched from task description and scope.
 *
 * @param {object} task Task record
 * @param {string} scope Inferred or explicit scope
 * @returns {string[]} List of candidate file paths
 */
export function inferCandidateFiles(task, scope) {
  const body = String(task?.body ?? '')
  const title = String(task?.title ?? '')
  const combined = `${title}\n${body}`

  const found = new Set()
  // Match explicit file paths mentioned in markdown
  const pathMatches = combined.match(/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+\.(js|mjs|json|md|yml|yaml|css|html)/g)
  if (pathMatches) {
    for (const p of pathMatches) {
      if (!p.startsWith('node_modules/') && !p.startsWith('.git/')) {
        found.add(p)
      }
    }
  }

  // Add scope-based canonical files if set is small
  if (found.size === 0) {
    if (scope === 'webui') {
      found.add('lib/client.js')
      found.add('test/board-ui.test.mjs')
    } else if (scope === 'settings') {
      found.add('lib/config.js')
      found.add('lib/client.js')
      found.add('test/config.test.mjs')
    } else if (scope === 'agent-tools') {
      found.add('lib/board-tool.js')
      found.add('test/board-tool.test.mjs')
    } else if (scope === 'worktree') {
      found.add('lib/worktree.js')
      found.add('test/worktree.test.mjs')
    } else if (scope === 'routing') {
      found.add('lib/routes.js')
      found.add('lib/server/route-handlers.js')
      found.add('test/routes.test.mjs')
    } else {
      found.add('lib/store.js')
      found.add('test/store.test.mjs')
    }
    found.add('CHANGELOG.md')
    found.add('docs/design/DESIGN.md')
  }

  return Array.from(found).slice(0, 10)
}

/**
 * Generate technical specification and structured plan for a backlog task (#376).
 *
 * @param {object} task Task object
 * @param {object} [options]
 * @param {string} [options.customInstructions]
 * @param {string[]} [options.additionalFiles]
 * @returns {{ spec: string, items: string[], summary: string, scope: string }}
 */
export function generateTechnicalSpec(task, options = {}) {
  const title = String(task?.title ?? '').trim()
  const body = String(task?.body ?? '').trim()
  const issueNum = typeof task?.issueNumber === 'number' ? task.issueNumber : null
  const issueTag = issueNum ? ` #${issueNum}` : ''
  const scope = inferScope(task)

  const candidateFiles = inferCandidateFiles(task, scope)
  if (Array.isArray(options.additionalFiles)) {
    for (const f of options.additionalFiles) {
      if (typeof f === 'string' && f.trim() !== '') candidateFiles.push(f.trim())
    }
  }

  const items = [
    `1. Preflight: inspect requirements and existing files for ${title}`,
    `2. Domain logic: implement core algorithms and validation rules`,
    `3. Data layer: update schema, storage methods and routes if needed`,
    `4. Integration & UI: connect route handlers, client views, and translations`,
    `5. Verification: run automated test suite and ensure zero regressions`,
  ]

  const specLines = [
    `# Technical Specification: ${title}${issueTag}`,
    '',
    '## 1. Problem Statement & Context',
    body ? body : 'No detailed description provided. Analyze issue requirements from title.',
    '',
    '## 2. Target Components & Candidate Files',
    ...candidateFiles.map((f) => `- \`${f}\``),
    '',
    '## 3. Step-by-Step Implementation Algorithm',
    ...items.map((it) => it),
    '',
    '## 4. Edge Cases & Validation Rules',
    '- Validate non-empty inputs and fail-closed error boundaries.',
    '- Ensure backward compatibility with existing schemas and configs.',
    '- Keep all handwritten files under 600 lines with zero Cyrillic literals in lib/.',
    '- Maintain client bundle size strictly under 256,000 bytes limit.',
    '',
    '## 5. Verification Plan',
    '- Unit test coverage covering happy paths and edge cases.',
    '- Full test suite execution: npm test.',
    '- Runtime smoke check on live server instance.',
  ]

  if (typeof options.customInstructions === 'string' && options.customInstructions.trim() !== '') {
    specLines.push('', '## 6. Special Instructions', options.customInstructions.trim())
  }

  const spec = specLines.join('\n')
  const summary = `Spec generated for ${title}${issueTag}: ${candidateFiles.length} files targeted, ${items.length} plan steps.`

  return {
    spec,
    items: items.map(cleanItemText).slice(0, MAX_ITEMS),
    summary,
    scope,
  }
}

/**
 * Extract step-by-step items from markdown text.
 *
 * @param {string} markdown Raw markdown text
 * @returns {string[]} List of extracted plan items
 */
export function extractPlanItems(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return []
  const lines = markdown.split('\n')
  const items = []
  let inAlgorithmSection = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) {
      const lower = trimmed.toLowerCase()
      inAlgorithmSection = lower.includes('algorithm') || lower.includes('step') || lower.includes('plan')
      continue
    }

    if (inAlgorithmSection || !items.length) {
      const hasPrefix = /^(?:\d+\.|\-|\*|\[[\sxX]\])/.test(trimmed)
      const match = trimmed.match(/^(?:(?:\d+\.|\-|\*)\s+)?(?:\[[\sxX]\]\s+)?(.+)$/)
      if (hasPrefix && match && match[1]) {
        const item = cleanItemText(match[1])
        if (item) items.push(item)
      }
    }
  }

  return items.slice(0, MAX_ITEMS)
}

/**
 * Parse markdown specification into structured representation.
 *
 * @param {string} markdown Raw markdown spec
 * @returns {{ spec: string, items: string[] }}
 */
export function parseSpecMarkdown(markdown) {
  const spec = typeof markdown === 'string' ? markdown.trim() : ''
  const items = extractPlanItems(spec)
  return { spec, items }
}

/**
 * Format technical specification and plan into prompt string for agent.
 *
 * @param {object} task Task object
 * @returns {string} Formatted markdown prompt section or empty string
 */
export function formatPlanPrompt(task) {
  if (!task) return ''
  const spec = typeof task.spec === 'string' ? task.spec.trim() : ''
  const items = Array.isArray(task.plan?.items) ? task.plan.items : []

  if (spec) {
    return `### Approved Technical Specification & Implementation Plan:\n\n${spec}`
  }

  if (items.length > 0) {
    return `### Approved Implementation Plan Steps:\n\n${items.map((it, idx) => `${idx + 1}. ${it}`).join('\n')}`
  }

  return ''
}

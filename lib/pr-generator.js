// Pull Request description and release notes generator (#379).
// Zero Cyrillic literals in lib/ per Issue #366.

import { inferScope } from './plan-generator.js'

/**
 * Parse one-line git log output into structured commit records.
 *
 * @param {string} logText Raw git log output
 * @returns {Array<{ sha: string, message: string }>}
 */
export function parseGitLog(logText) {
  if (typeof logText !== 'string' || !logText.trim()) return []
  const lines = logText.trim().split('\n')
  const commits = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Tab-delimited (git log --pretty=format:%h%x09%s) or space-delimited
    let sha = ''
    let message = ''
    if (trimmed.includes('\t')) {
      const parts = trimmed.split('\t')
      sha = parts[0].trim()
      message = parts.slice(1).join('\t').trim()
    } else {
      const match = trimmed.match(/^([a-f0-9]{7,40})\s+(.+)$/i)
      if (match) {
        sha = match[1]
        message = match[2].trim()
      } else {
        message = trimmed
      }
    }

    if (sha || message) {
      commits.push({ sha, message })
    }
  }

  return commits
}

/**
 * Parse git diff --stat output into structured file and line counts.
 *
 * @param {string} statText Raw git diff --stat output
 * @returns {{ filesChanged: number, additions: number, deletions: number, files: Array<{ path: string, changes: string }> }}
 */
export function parseDiffStat(statText) {
  if (typeof statText !== 'string' || !statText.trim()) {
    return { filesChanged: 0, additions: 0, deletions: 0, files: [] }
  }

  const lines = statText.trim().split('\n')
  const files = []
  let filesChanged = 0
  let additions = 0
  let deletions = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Summary line: "3 files changed, 45 insertions(+), 12 deletions(-)"
    const summaryMatch = trimmed.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/)
    if (summaryMatch) {
      filesChanged = parseInt(summaryMatch[1], 10) || 0
      additions = parseInt(summaryMatch[2], 10) || 0
      deletions = parseInt(summaryMatch[3], 10) || 0
      continue
    }

    // File line: "lib/client.js | 14 +++++++-------"
    const fileMatch = trimmed.match(/^(.+?)\s+\|\s+(\d+)\s*(.*)$/)
    if (fileMatch) {
      files.push({
        path: fileMatch[1].trim(),
        changes: fileMatch[2].trim(),
      })
    }
  }

  if (filesChanged === 0 && files.length > 0) {
    filesChanged = files.length
  }

  return { filesChanged, additions, deletions, files }
}

/**
 * Infer conventional commit / PR type (feat, fix, refactor, perf, docs, chore).
 *
 * @param {object} task Task object
 * @param {Array<{ sha: string, message: string }>} [commits]
 * @returns {string} PR type
 */
export function inferPrType(task, commits = []) {
  const title = String(task?.title ?? '').toLowerCase()
  const labels = Array.isArray(task?.labels) ? task.labels.map((l) => String(l).toLowerCase()) : []

  for (const label of labels) {
    if (label.startsWith('type/')) {
      const t = label.slice(5)
      if (t === 'bug') return 'fix'
      if (t === 'feature') return 'feat'
      return t
    }
  }

  if (title.startsWith('fix:') || title.includes('fix') || title.includes('bug')) return 'fix'
  if (title.startsWith('refactor:') || title.includes('refactor')) return 'refactor'
  if (title.startsWith('perf:') || title.includes('performance')) return 'perf'
  if (title.startsWith('docs:') || title.includes('document')) return 'docs'
  if (title.startsWith('chore:') || title.includes('cleanup')) return 'chore'

  for (const c of commits) {
    const msg = String(c?.message ?? '').toLowerCase()
    if (msg.startsWith('fix')) return 'fix'
    if (msg.startsWith('refactor')) return 'refactor'
    if (msg.startsWith('perf')) return 'perf'
  }

  return 'feat'
}

/**
 * Generate canonical PR title according to conventional commits format.
 *
 * @param {object} task Task object
 * @param {Array<{ sha: string, message: string }>} [commits]
 * @returns {string} PR title
 */
export function generatePrTitle(task, commits = []) {
  const type = inferPrType(task, commits)
  const scope = inferScope(task)
  let cleanTitle = String(task?.title ?? '').trim()

  // Strip leading prefixes like "L: Feature:", "M: Fix:", "feat:", etc.
  cleanTitle = cleanTitle.replace(/^[A-Z]:\s*(Feature|Bug|Fix|Refactor|Task):\s*/i, '')
  cleanTitle = cleanTitle.replace(/^(feat|fix|refactor|perf|docs|chore)(\([^)]+\))?:\s*/i, '')

  const issueNum = typeof task?.issueNumber === 'number' ? task.issueNumber : null
  const issueRef = issueNum ? ` (#${issueNum})` : ''

  return `${type}(${scope}): ${cleanTitle}${issueRef}`
}

/**
 * Generate canonical, structured Pull Request description markdown (#379).
 *
 * @param {object} params
 * @param {object} params.task Task record
 * @param {Array<{ sha: string, message: string }>} [params.commits]
 * @param {object} [params.diffStats]
 * @param {object} [params.verification]
 * @returns {string} Complete Markdown description for PR
 */
export function generatePrDescription({ task, commits = [], diffStats = null, verification = null }) {
  const title = String(task?.title ?? '').trim()
  const body = String(task?.body ?? '').trim()
  const issueNum = typeof task?.issueNumber === 'number' ? task.issueNumber : null
  const issueRef = issueNum ? `Closes #${issueNum}` : ''

  const lines = []

  // 1. Problem statement
  lines.push('### Problem')
  if (body) {
    lines.push(body)
  } else {
    lines.push(`Implementation required for: ${title}`)
  }
  lines.push('')

  // 2. Solution description
  lines.push('### Solution')
  if (task?.spec) {
    // Extract key sections or summary from spec if present
    const specLines = task.spec.split('\n')
    const solutionLines = specLines.filter((l) => !l.startsWith('# Technical Specification') && !l.startsWith('## 1.'))
    lines.push(solutionLines.slice(0, 15).join('\n').trim())
  } else if (Array.isArray(task?.plan?.items) && task.plan.items.length > 0) {
    lines.push('Implemented following plan:')
    for (const item of task.plan.items) {
      lines.push(`- ${item}`)
    }
  } else {
    lines.push(`- Resolved requirements specified in ${title}`)
  }
  lines.push('')

  // 3. Changed components & diff statistics
  if (diffStats && (diffStats.files?.length > 0 || diffStats.filesChanged > 0)) {
    lines.push('### Changed Components & Files')
    lines.push(`- Total files changed: ${diffStats.filesChanged || diffStats.files.length}`)
    if (diffStats.additions || diffStats.deletions) {
      lines.push(`- Changes: +${diffStats.additions} / -${diffStats.deletions}`)
    }
    if (Array.isArray(diffStats.files) && diffStats.files.length > 0) {
      for (const f of diffStats.files.slice(0, 12)) {
        lines.push(`  - \`${f.path}\``)
      }
      if (diffStats.files.length > 12) {
        lines.push(`  - ... and ${diffStats.files.length - 12} more files`)
      }
    }
    lines.push('')
  }

  // 4. Commits list
  if (Array.isArray(commits) && commits.length > 0) {
    lines.push('### Commits')
    for (const c of commits) {
      const shaShort = c.sha ? `\`${c.sha.slice(0, 7)}\` ` : ''
      lines.push(`- ${shaShort}${c.message}`)
    }
    lines.push('')
  }

  // 5. Verification status
  const ver = verification || task?.report?.verification
  if (ver) {
    lines.push('### Verification Results')
    const statusText = ver.status === 'passed' ? '✓ Tests Passed' : (ver.status === 'failed' ? '✗ Tests Failed' : 'Pending')
    lines.push(`- Status: **${statusText}**`)
    if (ver.command) {
      lines.push(`- Command: \`${ver.command}\``)
    }
    if (ver.verifiedAt) {
      lines.push(`- Timestamp: ${new Date(ver.verifiedAt).toISOString()}`)
    }
    lines.push('')
  }

  // 6. Issue reference closure
  if (issueRef) {
    lines.push(issueRef)
  }

  return lines.join('\n').trim()
}

/**
 * Generate release notes entry for CHANGELOG.md.
 *
 * @param {object} params
 * @param {object} params.task
 * @param {Array<{ sha: string, message: string }>} [params.commits]
 * @returns {string} Formatted release notes bullet
 */
export function generateReleaseNotes({ task, commits = [] }) {
  const title = String(task?.title ?? '').trim()
  const issueNum = typeof task?.issueNumber === 'number' ? ` (#${task.issueNumber})` : ''
  const cleanTitle = title.replace(/^[A-Z]:\s*(Feature|Bug|Fix|Refactor|Task):\s*/i, '')

  const lines = [`- **${cleanTitle}${issueNum}**:`]

  if (Array.isArray(commits) && commits.length > 0) {
    for (const c of commits.slice(0, 5)) {
      lines.push(`  - ${c.message}`)
    }
  } else {
    lines.push(`  - Implementation and automated verification complete.`)
  }

  return lines.join('\n')
}

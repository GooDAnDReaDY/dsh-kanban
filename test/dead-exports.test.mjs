import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Issue #403: ensure no dead exports exist that are only called by tests.
// All exported symbols in lib/ must have callers inside lib/ (or be entrypoints).

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const libDir = path.join(projectRoot, 'lib')

function getAllJsFiles(dir) {
  let results = []
  const list = readdirSync(dir)
  for (const file of list) {
    const fullPath = path.join(dir, file)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      results = results.concat(getAllJsFiles(fullPath))
    } else if (file.endsWith('.js')) {
      results.push(fullPath)
    }
  }
  return results
}

test('all lib/ exports are referenced in production code (#403)', () => {
  const ENTRY = new Set(['name', 'apply', 'inject', 'Config', 'schema'])
  const files = getAllJsFiles(libDir)
  const fileContents = new Map()
  for (const f of files) {
    fileContents.set(f, readFileSync(f, 'utf8'))
  }

  const dead = []
  for (const [filePath, content] of fileContents.entries()) {
    const regex = /^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm
    let match
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]
      if (ENTRY.has(name)) continue

      // Count occurrences in own file (excluding export definition line itself)
      const ownMatches = content.match(new RegExp(`\\b${name}\\b`, 'g')) || []
      const ownRefs = ownMatches.length - 1

      // Count occurrences in other lib/ files
      let otherRefs = 0
      for (const [otherPath, otherContent] of fileContents.entries()) {
        if (otherPath === filePath) continue
        const m = otherContent.match(new RegExp(`\\b${name}\\b`, 'g'))
        if (m) otherRefs += m.length
      }

      if (ownRefs === 0 && otherRefs === 0) {
        dead.push(`${name} in ${path.relative(projectRoot, filePath)}`)
      }
    }
  }

  assert.deepEqual(dead, [], 'Dead exports detected in production lib/: ' + dead.join(', '))
})

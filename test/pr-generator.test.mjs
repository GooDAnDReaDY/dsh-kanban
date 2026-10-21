import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseGitLog,
  parseDiffStat,
  inferPrType,
  generatePrTitle,
  generatePrDescription,
  generateReleaseNotes,
} from '../lib/pr-generator.js'

test('parseGitLog parses oneline and tab-delimited git log (#379)', () => {
  const onelineLog = `
952c283 feat(deps,timemachine): add DAG task dependencies and time-machine integration
8779c0d docs: update changelog for 0.2.35
`
  const commits1 = parseGitLog(onelineLog)
  assert.equal(commits1.length, 2)
  assert.equal(commits1[0].sha, '952c283')
  assert.equal(commits1[0].message, 'feat(deps,timemachine): add DAG task dependencies and time-machine integration')

  const tabLog = `a1b2c3d\tfix(webui): resolve button alignment\n`
  const commits2 = parseGitLog(tabLog)
  assert.equal(commits2.length, 1)
  assert.equal(commits2[0].sha, 'a1b2c3d')
  assert.equal(commits2[0].message, 'fix(webui): resolve button alignment')
})

test('parseDiffStat parses file counts, insertions and deletions (#379)', () => {
  const statText = `
 lib/client.js        | 14 +++++++-------
 lib/routes/task.js   | 28 ++++++++++++++++++++++++++++
 2 files changed, 35 insertions(+), 7 deletions(-)
`
  const stats = parseDiffStat(statText)
  assert.equal(stats.filesChanged, 2)
  assert.equal(stats.additions, 35)
  assert.equal(stats.deletions, 7)
  assert.equal(stats.files.length, 2)
  assert.equal(stats.files[0].path, 'lib/client.js')
  assert.equal(stats.files[1].path, 'lib/routes/task.js')
})

test('inferPrType identifies correct prefix from labels and title (#379)', () => {
  assert.equal(inferPrType({ labels: ['type/bug'] }), 'fix')
  assert.equal(inferPrType({ labels: ['type/perf'] }), 'perf')
  assert.equal(inferPrType({ title: 'Fix broken websocket connection' }), 'fix')
  assert.equal(inferPrType({ title: 'Refactor store indexes' }), 'refactor')
  assert.equal(inferPrType({ title: 'Documentation updates' }), 'docs')
  assert.equal(inferPrType({ title: 'Add new export modal' }), 'feat')
})

test('generatePrTitle creates clean conventional title (#379)', () => {
  const task = {
    title: 'L: Feature: Automated PR description generator',
    issueNumber: 379,
    labels: ['scope/agent-tools'],
  }
  const title = generatePrTitle(task)
  assert.equal(title, 'feat(agent-tools): Automated PR description generator (#379)')
})

test('generatePrDescription generates complete structured markdown (#379)', () => {
  const task = {
    title: 'Automated PR Description Generator',
    body: 'Developers need automated PR description generation on Review.',
    issueNumber: 379,
    spec: '## Architecture\nAdded lib/pr-generator.js.',
    report: {
      verification: {
        status: 'passed',
        command: 'npm test',
        verifiedAt: 1792582500000,
      },
    },
  }

  const commits = [
    { sha: '1234567890abcdef', message: 'feat: implement pr generator logic' },
    { sha: 'abcdef1234567890', message: 'test: add unit tests' },
  ]

  const diffStats = {
    filesChanged: 2,
    additions: 120,
    deletions: 5,
    files: [{ path: 'lib/pr-generator.js' }, { path: 'test/pr-generator.test.mjs' }],
  }

  const description = generatePrDescription({ task, commits, diffStats })

  assert.ok(description.includes('### Problem'))
  assert.ok(description.includes('Developers need automated PR description generation on Review.'))
  assert.ok(description.includes('### Solution'))
  assert.ok(description.includes('### Changed Components & Files'))
  assert.ok(description.includes('Total files changed: 2'))
  assert.ok(description.includes('Changes: +120 / -5'))
  assert.ok(description.includes('`lib/pr-generator.js`'))
  assert.ok(description.includes('### Commits'))
  assert.ok(description.includes('`1234567` feat: implement pr generator logic'))
  assert.ok(description.includes('### Verification Results'))
  assert.ok(description.includes('**✓ Tests Passed**'))
  assert.ok(description.includes('`npm test`'))
  assert.ok(description.includes('Closes #379'))
})

test('generateReleaseNotes formats bullet point for changelog (#379)', () => {
  const task = {
    title: 'L: Feature: PR description generator',
    issueNumber: 379,
  }
  const commits = [{ message: 'Added lib/pr-generator.js' }, { message: 'Added UI modal preview' }]
  const notes = generateReleaseNotes({ task, commits })

  assert.ok(notes.includes('- **PR description generator (#379)**:'))
  assert.ok(notes.includes('  - Added lib/pr-generator.js'))
  assert.ok(notes.includes('  - Added UI modal preview'))
})

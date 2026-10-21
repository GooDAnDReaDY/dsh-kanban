import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeText,
  tokenizeWords,
  extractNgrams,
  diceCoefficient,
  jaccardIndex,
  calculateTextSimilarity,
  compareTasks,
  findDuplicates,
} from '../lib/similarity.js'

test('normalizeText strips code fences, URLs, markdown, and punctuation', () => {
  const input = 'Feature: `button` with https://example.com #123\n```js\nconst x = 1\n```\nTesting!'
  const normalized = normalizeText(input)
  assert.equal(normalized.includes('https'), false)
  assert.equal(normalized.includes('123'), false)
  assert.equal(normalized.includes('const x'), false)
  assert.ok(normalized.includes('feature'))
  assert.ok(normalized.includes('button'))
  assert.ok(normalized.includes('testing'))
})

test('tokenizeWords filters out short words and common stop words', () => {
  const words = tokenizeWords('This is a test of the emergency alert system')
  assert.deepEqual(words, ['emergency', 'alert', 'system'])
})

test('extractNgrams generates character n-grams', () => {
  const ngrams = extractNgrams('kanban', 3)
  assert.ok(ngrams.has('kan'))
  assert.ok(ngrams.has('anb'))
  assert.ok(ngrams.has('nba'))
  assert.ok(ngrams.has('ban'))
})

test('diceCoefficient and jaccardIndex calculate set overlap accurately', () => {
  const a = new Set(['cat', 'dog', 'fish'])
  const b = new Set(['dog', 'fish', 'bird'])
  // Intersection = 2, sizes = 3, 3 -> Dice = (2 * 2) / 6 = 2/3
  assert.ok(Math.abs(diceCoefficient(a, b) - 2 / 3) < 0.001)
  // Union = 4 -> Jaccard = 2 / 4 = 0.5
  assert.equal(jaccardIndex(a, b), 0.5)
})

test('calculateTextSimilarity handles exact match, high similarity, and disjoint text', () => {
  assert.equal(calculateTextSimilarity('Implement OAuth authentication', 'Implement OAuth authentication'), 1.0)
  assert.equal(calculateTextSimilarity('', 'test'), 0)

  const high = calculateTextSimilarity('Implement OAuth 2.0 authentication login', 'Add OAuth2 login authentication flow')
  assert.ok(high > 0.5, `Expected high similarity score > 0.5, got ${high}`)

  const disjoint = calculateTextSimilarity('PostgreSQL database migration tool', 'Canvas WebGL rendering performance')
  assert.ok(disjoint < 0.2, `Expected disjoint similarity < 0.2, got ${disjoint}`)
})

test('multilingual similarity supports unicode character matching', () => {
  const sim = calculateTextSimilarity('Настройка авторизации через GitHub', 'Добавить авторизацию GitHub в профиль')
  assert.ok(sim > 0.3, `Expected unicode similarity > 0.45, got ${sim}`)
})

test('compareTasks blends title and description weights', () => {
  const q = { title: 'Fix broken search filter', description: 'Search input fails on special characters' }
  const c1 = { title: 'Fix broken search filter', description: 'Completely different description' }
  const c2 = { title: 'Something else', description: 'Search input fails on special characters' }

  const score1 = compareTasks(q, c1)
  const score2 = compareTasks(q, c2)
  // Title carries 70% weight, so c1 should score much higher than c2
  assert.ok(score1 > score2, 'Title match must outweigh description-only match')
})

test('findDuplicates finds similar cards, excludes self, and sorts descending', () => {
  const candidates = [
    { id: 't1', title: 'Webhook retry backoff logic', issueNumber: 101, repo: 'dsh-kanban', column: 'in-progress' },
    { id: 't2', title: 'Implement webhook exponential retry and backoff', issueNumber: 102, repo: 'dsh-kanban', column: 'backlog' },
    { id: 't3', title: 'Export board metrics to Prometheus', issueNumber: 103, repo: 'dsh-kanban', column: 'done' },
  ]

  const query = { id: 't1', title: 'Webhook retry backoff mechanism', description: 'Retry failed webhooks' }
  const duplicates = findDuplicates(query, candidates, { threshold: 0.35 })

  assert.equal(duplicates.length, 1)
  assert.equal(duplicates[0].id, 't2')
  assert.equal(duplicates[0].issueNumber, 102)
  assert.ok(duplicates[0].score > 0.4)
  assert.ok(duplicates[0].percent >= 40)
})

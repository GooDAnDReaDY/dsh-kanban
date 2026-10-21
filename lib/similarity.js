/**
 * Text Similarity & Duplicate Task Detection Engine (#380)
 *
 * Implements multilingual tokenization and character n-gram Dice/Jaccard
 * similarity algorithms to identify duplicate or highly similar tasks
 * without external dependencies.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'about', 'into', 'over', 'after',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'if', 'when',
  'feature', 'bug', 'task', 'fix', 'add', 'update', 'implement', 'test', 'tests'
])

/**
 * Normalizes input text by removing markdown syntax, code fences,
 * URLs, issue references, and non-letter symbols.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  if (typeof text !== 'string') return ''
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`/g, ' ')
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/#\d+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Splits text into cleaned words, filtering out short tokens and common stop words.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenizeWords(text) {
  const normalized = normalizeText(text)
  if (!normalized) return []
  return normalized
    .split(' ')
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
}

/**
 * Extracts character n-grams from normalized text for sub-word multilingual matching.
 *
 * @param {string} text
 * @param {number} [n=3]
 * @returns {Set<string>}
 */
function extractNgrams(text, n = 3) {
  const normalized = normalizeText(text).replace(/\s+/g, '')
  const ngrams = new Set()
  if (normalized.length < n) {
    if (normalized.length > 0) ngrams.add(normalized)
    return ngrams
  }
  for (let i = 0; i <= normalized.length - n; i++) {
    ngrams.add(normalized.slice(i, i + n))
  }
  return ngrams
}

/**
 * Calculates Dice similarity coefficient between two sets: 2 * |A ∩ B| / (|A| + |B|).
 *
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number} Float between 0.0 and 1.0
 */
function diceCoefficient(setA, setB) {
  if (!setA.size || !setB.size) return 0
  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) intersection++
  }
  return (2 * intersection) / (setA.size + setB.size)
}

/**
 * Calculates Jaccard index between two sets: |A ∩ B| / |A ∪ B|.
 *
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number} Float between 0.0 and 1.0
 */
function jaccardIndex(setA, setB) {
  if (!setA.size || !setB.size) return 0
  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * Calculates hybrid text similarity blending word token overlap and character 3-grams.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Similarity score between 0.0 and 1.0
 */
function calculateTextSimilarity(a, b) {
  if (!a || !b) return 0
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return 1.0

  const wordsA = new Set(tokenizeWords(a))
  const wordsB = new Set(tokenizeWords(b))
  const wordScore = diceCoefficient(wordsA, wordsB)

  const ngramsA = extractNgrams(a, 3)
  const ngramsB = extractNgrams(b, 3)
  const ngramScore = diceCoefficient(ngramsA, ngramsB)

  // Blend word tokens (0.4) and character n-grams (0.6) for morphological tolerance
  return wordScore * 0.4 + ngramScore * 0.6
}

/**
 * Calculates composite similarity between query task parameters and an existing task card.
 *
 * @param {{ title?: string, description?: string }} query
 * @param {{ title?: string, description?: string }} candidate
 * @returns {number} Score between 0.0 and 1.0
 */
function compareTasks(query, candidate) {
  if (!query || !candidate) return 0
  const titleA = query.title || ''
  const titleB = candidate.title || ''

  if (titleA && titleB && titleA.trim().toLowerCase() === titleB.trim().toLowerCase()) {
    return 1.0
  }

  const titleSim = calculateTextSimilarity(titleA, titleB)
  const descA = query.description || ''
  const descB = candidate.description || ''

  if (!descA || !descB) {
    return titleSim
  }

  const descSim = calculateTextSimilarity(descA, descB)
  // Title carries 70% weight, description carries 30% weight
  return titleSim * 0.7 + descSim * 0.3
}

/**
 * Finds duplicate or highly similar tasks from an array of candidate cards.
 *
 * @param {{ title?: string, description?: string, excludeId?: string }} query
 * @param {Array<Object>} candidates
 * @param {{ threshold?: number, limit?: number }} [options]
 * @returns {Array<{ id: string, title: string, issueNumber?: number, score: number, percent: number }>}
 */
function findDuplicates(query, candidates, options = {}) {
  if (!query || !Array.isArray(candidates) || candidates.length === 0) {
    return []
  }
  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.45
  const limit = typeof options.limit === 'number' ? options.limit : 5
  const excludeId = query.excludeId || query.id

  const results = []
  for (const candidate of candidates) {
    if (!candidate || !candidate.id) continue
    if (excludeId && candidate.id === excludeId) continue

    const score = compareTasks(query, candidate)
    if (score >= threshold) {
      results.push({
        id: candidate.id,
        title: candidate.title,
        issueNumber: candidate.issueNumber,
        repo: candidate.repo,
        column: candidate.column,
        score: Math.round(score * 1000) / 1000,
        percent: Math.round(score * 100),
      })
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export {
  normalizeText,
  tokenizeWords,
  extractNgrams,
  diceCoefficient,
  jaccardIndex,
  calculateTextSimilarity,
  compareTasks,
  findDuplicates,
}

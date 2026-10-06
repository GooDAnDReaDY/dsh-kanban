// Fractional ordering index for cards.
//
// String-based implementation using rocicorp/fractional-indexing (CC0-1.0).
// Generates bounded-length order keys strictly between neighbors, avoiding
// O(N^2) string inflation on repeated appends/prepends.

import { generateKeyBetween, generateNKeysBetween } from './fractional-indexing.js'

/**
 * Fractional order key strictly between two neighbors.
 *
 * @param {string} [a] left neighbor order key
 * @param {string} [b] right neighbor order key
 * @returns {string} key strictly between them
 * @throws if a >= b or key contains invalid character
 */
export function keyBetween(a, b) {
  if (a !== undefined && a !== null && b !== undefined && b !== null) {
    if (a >= b) {
      throw new Error(`order violated: ${JSON.stringify(a)} not less than ${JSON.stringify(b)}`)
    }
  }
  if (typeof a === 'string' && /[^0-9a-zA-Z]/.test(a)) {
    throw new Error('order key contains character outside alphabet')
  }
  if (typeof b === 'string' && /[^0-9a-zA-Z]/.test(b)) {
    throw new Error('order key contains character outside alphabet')
  }

  return generateKeyBetween(a ?? null, b ?? null)
}

export { generateKeyBetween, generateNKeysBetween }

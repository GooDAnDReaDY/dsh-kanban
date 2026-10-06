// Fractional ordering index for cards.
//
// Naive approach stores integer index, and dragging card to the top of column
// with ten items requires rewriting all ten. Here order is stored as string,
// and new value is generated BETWEEN two neighbors, so drag-and-drop is always
// a single UPDATE of one row regardless of how many cards are in column.
//
// String-based implementation is intentional. Floating-point numbers fail
// after ~50 insertions into the same position when precision runs out.
//
// Key is read as fraction after implicit '0.': comparison is standard
// lexicographical. Key never ends with first alphabet character to ensure
// subsequent division remains possible.

/** Alphabet in ascending character code order. */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const FIRST = DIGITS[0]

/** Value strictly between `a` and `b`; `b === undefined` means unbounded right. */
function midpoint(a, b) {
  if (b !== undefined && a >= b) {
    throw new Error(`order violated: ${JSON.stringify(a)} not less than ${JSON.stringify(b)}`)
  }
  if (a.endsWith(FIRST) || (b !== undefined && b.endsWith(FIRST))) {
    throw new Error('order key cannot end with first alphabet symbol')
  }

  if (b !== undefined) {
    // Common prefix carried as-is, division continues on remainder
    // to avoid inflating key length unnecessarily.
    let n = 0
    while ((a[n] ?? FIRST) === b[n]) n += 1
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }

  const from = a === '' ? 0 : DIGITS.indexOf(a[0])
  const to = b === undefined ? DIGITS.length : DIGITS.indexOf(b[0])
  if (from < 0 || to < 0) throw new Error('order key contains character outside alphabet')

  if (to - from > 1) {
    return DIGITS[Math.round(0.5 * (from + to))]
  }
  if (b !== undefined && b.length > 1) {
    return b.slice(0, 1)
  }
  // Adjacent symbols: take `a` digit and divide next position.
  return DIGITS[from] + midpoint(a.slice(1), undefined)
}

/**
 * Fractional order key strictly between two neighbors.
 *
 * Both neighbors are optional: without either returns default initial value;
 * without right returns value after `a`; without left returns value before `b`.
 *
 * @param {string} [a] left neighbor order key
 * @param {string} [b] right neighbor order key
 * @returns {string} key strictly between them
 * @throws if `a` is not less than `b` or key contains invalid character
 */
export function keyBetween(a, b) {
  return midpoint(a ?? '', b ?? undefined)
}

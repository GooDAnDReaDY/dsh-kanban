/**
 * Token and cost telemetry integration with @goodandready/dsh-cost-meter (#374).
 * All functions fail-soft without throwing when cost-meter is absent.
 */

/**
 * Check whether @goodandready/dsh-cost-meter plugin is active in current runtime.
 *
 * @param {object} ctx - Cordis context
 * @returns {boolean}
 */
export function isCostMeterAvailable(ctx) {
  if (!ctx || typeof ctx !== 'object') return false
  try {
    if (ctx.costMeter || (typeof ctx.get === 'function' && ctx.get('costMeter'))) return true
    if (ctx.settings && typeof ctx.settings.describe === 'function') {
      const rows = ctx.settings.describe({ redactSecrets: true })
      if (Array.isArray(rows) && rows.some((r) => r?.ns === 'dsh-cost-meter')) return true
    }
    if (ctx.registry && typeof ctx.registry[Symbol.iterator] === 'function') {
      for (const [plugin] of ctx.registry) {
        if (plugin === '@goodandready/dsh-cost-meter' || plugin?.name === '@goodandready/dsh-cost-meter') {
          return true
        }
      }
    }
    return false
  } catch {
    return false
  }
}

/**
 * Extract aggregated token usage from a session's costByModel projection view.
 *
 * @param {object} projectionView - View object from usageByModelProjection
 * @returns {{
 *   totalTokens: number,
 *   uncachedInputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   turnsCount: number,
 *   models: Array<string>
 * }}
 */
export function extractSessionUsage(projectionView) {
  const result = {
    totalTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turnsCount: 0,
    models: [],
  }
  if (!projectionView || typeof projectionView !== 'object') return result

  const modelsList = Array.isArray(projectionView.models) ? projectionView.models : []
  for (const m of modelsList) {
    const key = (m.provider ? m.provider + '/' : '') + (m.model || '')
    if (key && !result.models.includes(key)) result.models.push(key)
    const slots = m.slots && typeof m.slots === 'object' ? m.slots : {}
    for (const slotKey of Object.keys(slots)) {
      const b = slots[slotKey] || {}
      result.uncachedInputTokens += Number(b.uncachedInputTokens) || 0
      result.outputTokens += Number(b.outputTokens) || 0
      result.cacheReadTokens += Number(b.cacheReadTokens) || 0
      result.cacheWriteTokens += Number(b.cacheWriteTokens) || 0
    }
  }

  if (Array.isArray(projectionView.turns)) {
    result.turnsCount = projectionView.turns.length
    if (result.totalTokens === 0 && projectionView.turns.length > 0) {
      for (const t of projectionView.turns) {
        result.uncachedInputTokens += Number(t.uncachedInputTokens) || 0
        result.outputTokens += Number(t.outputTokens) || 0
        result.cacheReadTokens += Number(t.cacheReadTokens) || 0
        result.cacheWriteTokens += Number(t.cacheWriteTokens) || 0
      }
    }
  }

  result.totalTokens = result.uncachedInputTokens + result.outputTokens + result.cacheReadTokens + result.cacheWriteTokens
  return result
}

/**
 * Calculate cost for token usage given rate schedule or fallback tariff.
 * Default tariff: standard DeepSeek rates ($0.14/M input, $0.28/M output, $0.014/M cache hit).
 *
 * @param {{
 *   usage: object,
 *   schedule?: object,
 *   usdRate?: number,
 *   currency?: string
 * }} options
 * @returns {{
 *   costUsd: number,
 *   costFormatted: string,
 *   currency: string
 * }}
 */
export function calculateTokenCost({ usage, schedule, usdRate = 1, currency = '$' }) {
  if (!usage || typeof usage !== 'object') {
    return { costUsd: 0, costFormatted: currency + '0.00', currency }
  }

  const uncachedInput = Number(usage.uncachedInputTokens) || 0
  const output = Number(usage.outputTokens) || 0
  const cacheRead = Number(usage.cacheReadTokens) || 0
  const cacheWrite = Number(usage.cacheWriteTokens) || 0

  const rateInput = Number(schedule?.inputPerMillion ?? schedule?.input) || 0.14
  const rateOutput = Number(schedule?.outputPerMillion ?? schedule?.output) || 0.28
  const rateCacheRead = Number(schedule?.cacheReadPerMillion ?? schedule?.cacheHit) || 0.014
  const rateCacheWrite = Number(schedule?.cacheWritePerMillion) || rateInput

  const costUsd = (uncachedInput * rateInput + output * rateOutput + cacheRead * rateCacheRead + cacheWrite * rateCacheWrite) / 1_000_000
  const converted = costUsd * (Number(usdRate) > 0 ? Number(usdRate) : 1)

  const costFormatted = currency + (converted < 0.01 && converted > 0 ? '<0.01' : converted.toFixed(2))

  return {
    costUsd: Math.round(costUsd * 10000) / 10000,
    costFormatted,
    currency,
  }
}

/**
 * Check whether task cost exceeds configured budget limit.
 *
 * @param {{ costUsd: number, limit: number }} options
 * @returns {{ exceeded: boolean, limit: number, costUsd: number }}
 */
export function checkCostLimit({ costUsd = 0, limit = 0 }) {
  const numLimit = Number(limit) || 0
  if (numLimit <= 0) return { exceeded: false, limit: 0, costUsd }
  return {
    exceeded: costUsd >= numLimit,
    limit: numLimit,
    costUsd,
  }
}

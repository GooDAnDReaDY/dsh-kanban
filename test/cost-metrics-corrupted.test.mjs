import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowToTask, getCorruptedCostMetricsCount, resetCorruptedCostMetricsCount } from '../lib/store.js'

test('store: rowToTask increments corrupted counter on malformed costMetrics (#400)', () => {
  resetCorruptedCostMetricsCount()
  assert.equal(getCorruptedCostMetricsCount(), 0)

  // 1. Valid JSON costMetrics
  const validRow = {
    id: 't-valid',
    title: 'Valid task',
    costMetrics: JSON.stringify({ totalTokens: 1500, costUsd: 0.05 }),
  }
  const task1 = rowToTask(validRow)
  assert.equal(task1.costMetrics.totalTokens, 1500)
  assert.equal(getCorruptedCostMetricsCount(), 0)

  // 2. Corrupted JSON costMetrics
  const corruptedRow = {
    id: 't-corrupted',
    title: 'Corrupted task',
    costMetrics: '{ "totalTokens": 1500, INVALID_JSON... }',
  }
  const task2 = rowToTask(corruptedRow)
  assert.equal(task2.costMetrics, null)
  assert.equal(getCorruptedCostMetricsCount(), 1)

  // 3. Additional corrupted row
  const corruptedRow2 = {
    id: 't-corrupted-2',
    title: 'Corrupted task 2',
    costMetrics: 'not-json-at-all',
  }
  const task3 = rowToTask(corruptedRow2)
  assert.equal(task3.costMetrics, null)
  assert.equal(getCorruptedCostMetricsCount(), 2)

  // 4. Object costMetrics directly passed
  const objectRow = {
    id: 't-obj',
    title: 'Object task',
    costMetrics: { totalTokens: 300, costUsd: 0.01 },
  }
  const task4 = rowToTask(objectRow)
  assert.equal(task4.costMetrics.totalTokens, 300)
  assert.equal(getCorruptedCostMetricsCount(), 2)
})

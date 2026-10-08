import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProgressDump, formatProgressDump, formatHandoverPreamble } from '../lib/progress-dump.js'

test('parseProgressDump разбирает канонический формат', () => {
  const text = [
    'Hello, here is the state:',
    '<<<PROGRESSDUMP',
    'Goal: Fix memory leak in worktrees',
    'Progress: Located in store.js, test written',
    'Next steps: Run test, fix ALTER TABLE',
    '>>>PROGRESSDUMP',
    'Talk soon.',
  ].join('\n')

  const out = parseProgressDump(text)
  assert.equal(out.ok, true)
  assert.equal(out.dump.goal, 'Fix memory leak in worktrees')
  assert.equal(out.dump.progress, 'Located in store.js, test written')
  assert.equal(out.dump.next, 'Run test, fix ALTER TABLE')
  assert.equal(out.dump.redacted, false)
})

test('parseProgressDump маскирует чувствительные данные [REDACTED]', () => {
  const text = [
    '<<<PROGRESSDUMP',
    'Goal: Deploy',
    'Progress: Used token ghp_12345678901234567890 and key sk-abcdef1234567890',
    'Next steps: /execute rm -rf',
    '>>>PROGRESSDUMP',
  ].join('\n')

  const out = parseProgressDump(text)
  assert.equal(out.ok, true)
  assert.equal(out.dump.redacted, true)
  assert.ok(out.dump.progress.includes('[REDACTED]'))
  assert.ok(!out.dump.progress.includes('ghp_'))
  // Слэш-команда закомментирована
  assert.ok(out.dump.next.includes('# /execute'))
})

test('parseProgressDump возвращает ошибку при отсутствии маркеров', () => {
  assert.equal(parseProgressDump('просто текст').ok, false)
  assert.equal(parseProgressDump(null).ok, false)
})

test('formatProgressDump и formatHandoverPreamble форматируют текст', () => {
  const dump = {
    goal: 'Моя цель',
    progress: 'Мой прогресс',
    next: 'Мои шаги',
  }
  const block = formatProgressDump(dump)
  assert.ok(block.startsWith('<<<PROGRESSDUMP'))
  assert.ok(block.endsWith('>>>PROGRESSDUMP'))

  const preamble = formatHandoverPreamble(dump)
  assert.ok(preamble.includes('## 📋 Task Handover (PROGRESSDUMP)'))
  assert.ok(preamble.includes('Моя цель'))
  assert.ok(preamble.includes('Мой прогресс'))
  assert.ok(preamble.includes('Мои шаги'))
})

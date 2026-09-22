import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProgressDump, formatProgressDump, formatHandoverPreamble } from '../lib/progress-dump.js'

test('parseProgressDump разбирает русский формат', () => {
  const text = [
    'Привет, вот срез:',
    '<<<PROGRESSDUMP',
    'Цель: Исправить утечку памяти в воркдеревьях',
    'Прогресс: Найдено место в store.js, написан тест',
    'Следующие шаги: Запустить тест, поправить ALTER TABLE',
    '>>>PROGRESSDUMP',
    'До связи.',
  ].join('\n')

  const out = parseProgressDump(text)
  assert.equal(out.ok, true)
  assert.equal(out.dump.goal, 'Исправить утечку памяти в воркдеревьях')
  assert.equal(out.dump.progress, 'Найдено место в store.js, написан тест')
  assert.equal(out.dump.next, 'Запустить тест, поправить ALTER TABLE')
  assert.equal(out.dump.redacted, false)
})

test('parseProgressDump маскирует чувствительные данные [REDACTED]', () => {
  const text = [
    '<<<PROGRESSDUMP',
    'Цель: Deploy',
    'Прогресс: Использован токен ghp_12345678901234567890 и ключ sk-abcdef1234567890',
    'Следующие шаги: /execute rm -rf',
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
  assert.ok(preamble.includes('## 📋 Эстафета задачи (PROGRESSDUMP)'))
  assert.ok(preamble.includes('Моя цель'))
  assert.ok(preamble.includes('Мой прогресс'))
  assert.ok(preamble.includes('Мои шаги'))
})

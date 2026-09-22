import test from 'node:test'
import assert from 'node:assert/strict'
import { keyBetween } from '../lib/order.js'

test('значение строго между соседями', () => {
  const a = keyBetween(undefined, undefined)
  const b = keyBetween(a, undefined)
  assert.ok(a < b, `${a} должно быть меньше ${b}`)
  const mid = keyBetween(a, b)
  assert.ok(a < mid && mid < b, `${a} < ${mid} < ${b}`)
})

test('без левого соседа выдаётся значение перед правым', () => {
  const b = keyBetween(undefined, undefined)
  const before = keyBetween(undefined, b)
  assert.ok(before < b)
})

test('деление выдерживает тысячу вставок в одно место', () => {
  // Реализация на числах с плавающей точкой проходит первую проверку и
  // разваливается примерно здесь, на пятидесятой вставке.
  const lo = keyBetween(undefined, undefined)
  let hi = keyBetween(lo, undefined)
  for (let i = 0; i < 1000; i += 1) {
    const mid = keyBetween(lo, hi)
    assert.ok(lo < mid && mid < hi, `сломалось на вставке ${i}: ${lo} < ${mid} < ${hi}`)
    hi = mid
  }
})

test('деление выдерживает тысячу вставок вплотную к левому соседу', () => {
  let lo = keyBetween(undefined, undefined)
  const hi = keyBetween(lo, undefined)
  for (let i = 0; i < 1000; i += 1) {
    const mid = keyBetween(lo, hi)
    assert.ok(lo < mid && mid < hi, `сломалось на вставке ${i}`)
    lo = mid
  }
})

test('дописывание в конец не деградирует', () => {
  let last = keyBetween(undefined, undefined)
  for (let i = 0; i < 500; i += 1) {
    const next = keyBetween(last, undefined)
    assert.ok(last < next, `сломалось на добавлении ${i}`)
    last = next
  }
})

test('перевёрнутые соседи отвергаются', () => {
  const a = keyBetween(undefined, undefined)
  const b = keyBetween(a, undefined)
  assert.throws(() => keyBetween(b, a))
})

test('одинаковые соседи отвергаются', () => {
  const a = keyBetween(undefined, undefined)
  assert.throws(() => keyBetween(a, a))
})

test('символ вне алфавита отвергается', () => {
  assert.throws(() => keyBetween('Я', undefined))
})

test('ключи сортируются обычным сравнением строк', () => {
  const keys = []
  let last
  for (let i = 0; i < 50; i += 1) {
    last = keyBetween(last, undefined)
    keys.push(last)
  }
  const shuffled = keys.slice().reverse()
  assert.deepEqual(shuffled.sort(), keys)
})

// Разбор тела задачи: что понимаем, что оставляем текстом, чего не пускаем.
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseBody, parseSpans, isSafeHref } from '../lib/markdown.js'
import { taskBody } from '../lib/routes.js'
import { freshStore } from './helpers.mjs'

const kinds = (text) => parseBody(text).map((b) => b.kind)

test('заголовки разбираются по уровню', () => {
  const out = parseBody('# раз\n\n## два\n\n###### шесть')
  assert.deepEqual(out.map((b) => b.level), [1, 2, 6])
  assert.equal(out[1].spans[0].text, 'два')
})

test('решётка без пробела заголовком не считается', () => {
  // «#4105» в тексте — это номер, а не заголовок.
  assert.deepEqual(kinds('#4105 упоминание'), ['para'])
})

test('списки нумерованные и обычные', () => {
  const out = parseBody('1. раз\n2. два\n\n- пункт\n- ещё')
  assert.deepEqual(out.map((b) => b.ordered), [true, false])
  assert.equal(out[0].items.length, 2)
  assert.equal(out[1].items.length, 2)
})

test('строки абзаца склеиваются, как в markdown', () => {
  const out = parseBody('первая\nвторая\n\nдругой абзац')
  assert.equal(out.length, 2)
  assert.equal(out[0].spans[0].text, 'первая вторая')
})

test('блок кода берётся дословно вместе с разметкой внутри', () => {
  const out = parseBody('```js\nconst a = **не жирный**\n```')
  assert.equal(out[0].kind, 'code')
  assert.equal(out[0].lang, 'js')
  assert.equal(out[0].text, 'const a = **не жирный**')
})

test('незакрытый блок кода не съедает разбор молча', () => {
  const out = parseBody('```\nбез конца')
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'code')
})

test('цитата и разделитель', () => {
  assert.deepEqual(kinds('> цитата\n\n---'), ['quote', 'rule'])
})

test('выделение, код и ссылка внутри строки', () => {
  const out = parseSpans('**жирно**, `код`, _косо_ и [ссылка](https://example.com)')
  assert.deepEqual(out.map((s) => s.kind),
    ['strong', 'text', 'code', 'text', 'em', 'text', 'link'])
  assert.equal(out[6].href, 'https://example.com')
})

test('внутри обратных кавычек разметки нет', () => {
  const out = parseSpans('`**не жирный**`')
  assert.deepEqual(out, [{ kind: 'code', text: '**не жирный**' }])
})

test('опасная ссылка остаётся текстом, а не исчезает', () => {
  // Молча выбрасывать нельзя: человек должен видеть, что там было написано.
  const out = parseSpans('[клик](javascript:alert(1))')
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'text')
  assert.match(out[0].text, /javascript/)
})

test('схемы ссылок: только http и https', () => {
  assert.equal(isSafeHref('https://example.com'), true)
  assert.equal(isSafeHref('http://example.com'), true)
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/относительная', '', undefined]) {
    assert.equal(isSafeHref(bad), false, String(bad))
  }
})

test('пустое тело даёт пустой список блоков', () => {
  for (const empty of ['', '   \n\n  ', undefined, null]) {
    assert.deepEqual(parseBody(empty), [], String(empty))
  }
})

test('маршрут отдаёт разобранное тело, а не строку', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'backlog', title: 'A',
    body: '## Заголовок\n\n- пункт',
  })
  const out = taskBody({ store, id: task.id })
  assert.deepEqual(out.blocks.map((b) => b.kind), ['heading', 'list'])
  assert.equal(typeof out.blocks, 'object')
  cleanup()
})

test('тело несуществующей задачи — честный отказ', () => {
  const { store, cleanup } = freshStore()
  assert.equal(taskBody({ store, id: 'нет-такой' }).error, 'task-not-found')
  cleanup()
})

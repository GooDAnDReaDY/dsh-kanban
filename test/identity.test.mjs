// Имя пакета обязано совпадать в трёх местах: package.json, cordis.patch.yml
// и load({ id }) в lib/client.js. Расхождение НЕ даёт ошибки в журнале —
// серверная половина работает, интерфейса нет, и искать причину приходится
// вручную. Этот тест ловит расхождение до установки.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, runInNewContext } from 'node:vm'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

test('имя пакета совпадает в трёх местах', () => {
  const pkg = JSON.parse(read('package.json'))
  const patch = read('cordis.patch.yml')
  const client = read('lib/client.js')

  assert.equal(pkg.name, '@goodandready/dsh-kanban')
  assert.ok(patch.includes(`name: '${pkg.name}'`),
    'cordis.patch.yml не называет полное имя пакета')
  assert.ok(client.includes(`id: '${pkg.name}'`),
    'lib/client.js грузится под другим идентификатором')
})

test('короткий id патча совпадает с именем плагина cordis', () => {
  const patch = read('cordis.patch.yml')
  assert.ok(patch.includes('id: dsh-kanban'))
})

test('браузерная половина отдаёт apply и список служб', () => {
  const src = read('lib/client.js')
  let loaded
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { loaded = spec } } },
  }
  createContext(sandbox)
  runInNewContext(src, sandbox)

  assert.ok(loaded, 'модуль не зарегистрировался в загрузчике')
  assert.equal(loaded.id, '@goodandready/dsh-kanban')

  const stubs = { react: { createElement: () => null, useState: () => [], useMemo: () => undefined } }
  const exported = loaded.factory((name) => stubs[name])
  assert.equal(typeof exported.apply, 'function')
  // Array.from обязателен: массив рождён внутри vm-контекста, у него другой
  // прототип, и deepStrictEqual отверг бы совпадающее содержимое.
  assert.deepEqual(Array.from(exported.inject), ['slots', 'locale', 'settingsScope'])
})

test('карточка настроек встаёт в слот плагинов, а не своим разделом', () => {
  const client = read('lib/client.js')
  assert.ok(client.includes("'settings.plugin.item'"),
    'карточка не регистрируется в слоте настроек плагинов')
  assert.ok(!client.includes("name: 'settings.section'"),
    'плагин заводит свой раздел настроек, хотя должен обойтись карточкой')
})

test('ключ слота карточки равен пространству настроек', () => {
  const client = read('lib/client.js')
  // Ключ обязан совпадать с именем пространства: вкладка перебирает
  // объявленные пространства и рисует слот с entryKey, равным этому имени.
  assert.ok(/const NS = 'dsh-kanban'/.test(client))
  assert.ok(/key: NS/.test(client))
})

test('в записи слота есть locale — иначе компонент не получит props.t', () => {
  const client = read('lib/client.js')
  assert.ok(/locale: NS/.test(client))
})

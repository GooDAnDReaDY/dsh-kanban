// Имя пакета обязано совпадать в трёх местах: package.json, cordis.patch.yml
// и load({ id }) в lib/client.js. Расхождение НЕ даёт ошибки в журнале —
// серверная половина работает, интерфейса нет, и искать причину приходится
// вручную. Этот тест ловит расхождение до установки.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadClient } from './client-load.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

test('имя пакета совпадает в трёх местах', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.name, '@goodandready-private/dsh-kanban')
  assert.ok(read('cordis.patch.yml').includes(`name: '${pkg.name}'`),
    'cordis.patch.yml не называет полное имя пакета')
  assert.ok(read('lib/client.js').includes(`id: '${pkg.name}'`),
    'lib/client.js грузится под другим идентификатором')
})

test('короткий id патча совпадает с именем плагина cordis', () => {
  assert.ok(read('cordis.patch.yml').includes('id: dsh-kanban'))
})

test('браузерная половина отдаёт apply, службы и помощники', () => {
  const { spec, exported } = loadClient()
  assert.equal(spec.id, '@goodandready-private/dsh-kanban')
  assert.equal(typeof exported.apply, 'function')
  // Array.from обязателен: массив рождён внутри vm-контекста, у него другой
  // прототип, и deepStrictEqual отверг бы совпадающее содержимое.
  assert.deepEqual(Array.from(exported.inject), ['slots', 'locale', 'settingsScope'])
  assert.equal(typeof exported.helpers.neighboursFor, 'function')
})

test('настроечный слот плагинов пробуется первым, а не запасной раздел', () => {
  const src = read('lib/client.js')
  const plugin = src.indexOf("name: 'settings.plugin.item'")
  const section = src.indexOf("name: 'settings.section'")
  assert.ok(plugin > 0, 'карточка не пробует слот настроек плагинов')
  assert.ok(section > plugin, 'запасной раздел объявлен раньше основного слота')
})

test('встраивание в оболочку опирается на объявленные селекторы', () => {
  // Приём хрупкий: он держится на вёрстке чужой оболочки. Если селекторы
  // исчезнут при правке, доска молча перестанет появляться — тест это ловит.
  const src = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
  for (const needle of ['newSession', 'newSessionLabel', 'centerCol', 'dsh-panel-activate', 'cloneNode']) {
    assert.ok(src.includes(needle), `потерян селектор оболочки: ${needle}`)
  }
})

test('порядок колонок в браузерной половине совпадает с серверным', async () => {
  const { COLUMN_ORDER } = await import('../lib/config.js')
  const { exported } = loadClient()
  assert.deepEqual(Array.from(exported.helpers.COLUMN_ORDER), COLUMN_ORDER)
})

test('у каждой колонки есть подпись в обоих языках', () => {
  const src = read('lib/client.js')
  for (const id of ['backlog', 'in-progress', 'review', 'deploy', 'cleanup', 'done']) {
    assert.ok(src.includes(`'column.${id}'`), `нет подписи колонки ${id}`)
  }
})

test('index.js не пользуется тем, чего не импортировал', () => {
  // Обвязка cordis не проверяется модульными тестами: они зовут чистые модули
  // напрямую и через index.js не ходят никогда. Забытый импорт даёт не падение
  // при загрузке, а ReferenceError внутри обработчика — то есть маршрут молча
  // отвечает «bad-request», и ни один тест не краснеет.
  //
  // Ровно так уехали в релиз маршруты архива.
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

  const imported = new Set()
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/[a-z-]+\.js'/g)) {
    for (const name of m[1].split(',')) {
      const clean = name.trim().split(/\s+as\s+/).pop().trim()
      if (clean !== '') imported.add(clean)
    }
  }

  // Что объявлено в наших же модулях и потому может быть забыто в импорте.
  const exported = new Set()
  for (const file of ['routes.js', 'import.js', 'sync.js', 'launcher.js', 'commands.js', 'intake.js']) {
    const mod = readFileSync(new URL('../lib/' + file, import.meta.url), 'utf8')
    for (const m of mod.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) exported.add(m[1])
  }

  const missing = []
  for (const name of exported) {
    if (imported.has(name)) continue
    // Ищем вызов по имени; объявления самого index.js не в счёт.
    const used = new RegExp('(?<![.\\w])' + name + '\\s*\\(').test(src)
    const declared = new RegExp('(?:function|const|let)\\s+' + name + '\\b').test(src)
    if (used && !declared) missing.push(name)
  }

  assert.deepEqual(missing, [], 'index.js зовёт не импортированное: ' + missing.join(', '))
})

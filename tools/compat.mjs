#!/usr/bin/env node
// Совместимость с тем ядром, которое реально установлено.
//
// Именованный импорт отсутствующего экспорта — это SyntaxError на этапе
// разбора: падает не плагин, а загрузка ВСЕГО дерева плагинов, и харнесс
// уходит в цикл перезапусков. Так нас дважды за неделю уронили `settingsNamespace`
// и `CallId` у соседа, причём узнавали мы об этом от владельца.
//
// Проверка живёт отдельно от `npm test`: там нет ни ядра, ни профиля. Здесь
// же имена резолвятся ровно так, как их резолвит харнесс, — из каталога
// профиля.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const LIB = new URL('../lib/', import.meta.url)

/** Каталог профиля: оттуда харнесс и резолвит пакеты ядра. */
function profileDir() {
  const given = process.argv[2]
  if (given) return path.resolve(given)
  const home = process.env.DSH_HOME
  if (home) return path.join(home, 'profiles', 'web')
  return path.join(process.env.HOME ?? '', '.dsh', 'profiles', 'web')
}

/** Что мы просим у ядра: пакет → набор имён. */
function wanted() {
  const asked = new Map()
  for (const name of readdirSync(LIB).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(new URL(name, LIB), 'utf8')
    const rows = src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(@deepseek-ai\/[^']+)'/g)
    for (const row of rows) {
      const names = row[1].split(',')
        .map((one) => one.trim().split(/\s+as\s+/)[0].trim())
        .filter((one) => one !== '' && one !== 'type')
      if (!asked.has(row[2])) asked.set(row[2], new Set())
      for (const one of names) asked.get(row[2]).add(one)
    }
  }
  return asked
}

const dir = profileDir()
let require
try {
  require = createRequire(path.join(dir, 'package.json'))
} catch {
  console.error(`совместимость: профиль ${dir} не найден — проверять не с чем`)
  process.exit(2)
}

const asked = wanted()
if (asked.size === 0) {
  console.error('совместимость: в lib/ нет ни одного импорта ядра — проверка смотрит не туда')
  process.exit(2)
}

let broken = 0
for (const [pkg, names] of [...asked].sort()) {
  let real
  try {
    real = new Set(Object.keys(await import(require.resolve(pkg))))
  } catch (error) {
    console.log(`✗ ${pkg}: не резолвится из профиля (${error.code ?? error.message})`)
    broken += 1
    continue
  }
  const missing = [...names].filter((one) => !real.has(one))
  if (missing.length === 0) {
    console.log(`✓ ${pkg}: ${names.size} имён на месте`)
    continue
  }
  broken += 1
  console.log(`✗ ${pkg}: нет ${missing.join(', ')}`)
  console.log(`   ядро отдаёт: ${[...real].sort().join(', ')}`)
}

console.log(broken === 0
  ? `совместимость с ядром в ${dir}: расхождений нет`
  : `совместимость: расхождений ${broken} — плагин уронит загрузку дерева`)
process.exit(broken === 0 ? 0 : 1)

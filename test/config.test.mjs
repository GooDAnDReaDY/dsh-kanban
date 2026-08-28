import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIG_DEFAULTS,
  COLUMN_ORDER,
  withDefaults,
  wipLimitField,
} from '../lib/config.js'
import { loadClient } from './client-load.mjs'

test('withDefaults заполняет значения по умолчанию', () => {
  const cfg = withDefaults({})
  assert.equal(cfg.defaultProjectRoot, '')
  assert.equal(cfg.startPrompt, '')
  assert.equal(cfg.wipInProgress, 3)
  assert.equal(cfg.wipReview, 0)
})

test('withDefaults переживает undefined', () => {
  assert.deepEqual(withDefaults(undefined), CONFIG_DEFAULTS)
})

test('заданное значение вытесняет умолчание', () => {
  const cfg = withDefaults({ replyInstruction: 'Отвечай кратко.', wipInProgress: 5 })
  assert.equal(cfg.replyInstruction, 'Отвечай кратко.')
  assert.equal(cfg.wipInProgress, 5)
})

test('поле неверного типа откатывается на умолчание', () => {
  const cfg = withDefaults({ wipInProgress: 'три', replyInstruction: 42 })
  assert.equal(cfg.wipInProgress, 3)
  assert.equal(cfg.replyInstruction, CONFIG_DEFAULTS.replyInstruction)
})

test('все поля настроек скалярные — карточка правит только скаляры', () => {
  for (const [key, value] of Object.entries(withDefaults({}))) {
    const kind = typeof value
    assert.ok(kind === 'string' || kind === 'number' || kind === 'boolean',
      `поле ${key} не скалярное: ${kind}`)
  }
})

test('колонки идут в порядке воркфлоу', () => {
  assert.deepEqual(COLUMN_ORDER,
    ['backlog', 'in-progress', 'review', 'deploy', 'cleanup', 'done'])
})

test('предел колонки: ноль означает «без предела»', () => {
  const cfg = withDefaults({})
  assert.equal(wipLimitField(cfg, 'in-progress'), 3)
  assert.equal(wipLimitField(cfg, 'review'), undefined)
  assert.equal(wipLimitField(cfg, 'backlog'), undefined)
})

test('отрицательный предел трактуется как «без предела»', () => {
  const cfg = withDefaults({ wipInProgress: -1 })
  assert.equal(wipLimitField(cfg, 'in-progress'), undefined)
})

test('неизвестная колонка не роняет доступ к пределу', () => {
  const cfg = withDefaults({})
  assert.equal(wipLimitField(cfg, 'нет-такой'), undefined)
})

test('доступ к полям переживает отсутствие настроек', () => {
  assert.equal(wipLimitField(undefined, 'in-progress'), undefined)
})

test('автоперемещение включено, инструмент агента — нет', () => {
  const cfg = withDefaults({})
  assert.equal(cfg.syncIntervalSec, 120)
  // Инструмент выключен намеренно: скилл воркфлоу пока запрещает этому CLI
  // трогать канбан, и включать его раньше правки скилла нельзя.
  assert.equal(cfg.boardToolEnabled, false)
})

test('булева настройка остаётся булевой при мусоре на входе', () => {
  assert.equal(withDefaults({ boardToolEnabled: 'да' }).boardToolEnabled, false)
  assert.equal(withDefaults({ boardToolEnabled: true }).boardToolEnabled, true)
})

test('каждому умолчанию соответствует свой тип узла схемы', () => {
  // Схема собирается из умолчаний по их типу. Незамеченный тип объявляется
  // строкой, и плагин не загружается вовсе с «invalid config» — тестами это
  // не ловится, поэтому сторожим сам набор типов.
  const kinds = new Set(Object.values(CONFIG_DEFAULTS).map((v) => typeof v))
  assert.deepEqual([...kinds].sort(), ['boolean', 'number', 'string'],
    'появился тип умолчания, для которого в схеме нет узла')
})

test('каждая настройка имеет поле в карточке и обе подписи', () => {
  // Настройка без поля недоступна человеку вовсе: она есть на сервере, работает
  // по умолчанию и молча не поддаётся правке. Так уехали в релиз watchRepos и
  // archiveAfterDays — их некуда было вписать.
  const { src } = loadClient()
  const fields = new Set()
  const block = src.slice(src.indexOf('const FIELDS = ['), src.indexOf('function hintKey'))
  for (const m of block.matchAll(/field: '([A-Za-z0-9_]+)'/g)) fields.add(m[1])

  const missing = Object.keys(CONFIG_DEFAULTS).filter((key) => !fields.has(key))
  assert.deepEqual(missing, [], 'нет поля в карточке настроек: ' + missing.join(', '))

  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    const labels = src.split(`'field.${key}':`).length - 1
    assert.equal(labels, 2, `у field.${key} не два перевода, а ${labels}`)
  }
})

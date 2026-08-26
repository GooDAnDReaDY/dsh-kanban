import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIG_DEFAULTS,
  COLUMN_ORDER,
  withDefaults,
  columnLabelField,
  wipLimitField,
} from '../lib/config.js'

test('withDefaults заполняет значения по умолчанию', () => {
  const cfg = withDefaults({})
  assert.equal(cfg.defaultProjectRoot, '')
  assert.equal(cfg.startPrompt, '')
  assert.equal(cfg.labelInProgress, 'kanban/in-progress')
  assert.equal(cfg.labelReview, 'kanban/review')
  assert.equal(cfg.labelDeploy, 'kanban/deploy')
  assert.equal(cfg.labelCleanup, 'kanban/cleanup')
  assert.equal(cfg.wipInProgress, 3)
  assert.equal(cfg.wipReview, 0)
})

test('withDefaults переживает undefined', () => {
  assert.deepEqual(withDefaults(undefined), CONFIG_DEFAULTS)
})

test('заданное значение вытесняет умолчание', () => {
  const cfg = withDefaults({ labelReview: 'ревью', wipInProgress: 5 })
  assert.equal(cfg.labelReview, 'ревью')
  assert.equal(cfg.wipInProgress, 5)
})

test('поле неверного типа откатывается на умолчание', () => {
  const cfg = withDefaults({ wipInProgress: 'три', labelReview: 42 })
  assert.equal(cfg.wipInProgress, 3)
  assert.equal(cfg.labelReview, 'kanban/review')
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

test('метка колонки берётся из настроек, backlog и done без метки', () => {
  const cfg = withDefaults({})
  assert.equal(columnLabelField(cfg, 'in-progress'), 'kanban/in-progress')
  assert.equal(columnLabelField(cfg, 'cleanup'), 'kanban/cleanup')
  assert.equal(columnLabelField(cfg, 'backlog'), '')
  assert.equal(columnLabelField(cfg, 'done'), '')
})

test('пустая метка означает «не ставить метку»', () => {
  const cfg = withDefaults({ labelReview: '' })
  assert.equal(columnLabelField(cfg, 'review'), '')
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

test('неизвестная колонка не роняет доступ к метке и пределу', () => {
  const cfg = withDefaults({})
  assert.equal(columnLabelField(cfg, 'нет-такой'), '')
  assert.equal(wipLimitField(cfg, 'нет-такой'), undefined)
})

test('доступ к полям переживает отсутствие настроек', () => {
  assert.equal(columnLabelField(undefined, 'review'), '')
  assert.equal(wipLimitField(undefined, 'in-progress'), undefined)
})

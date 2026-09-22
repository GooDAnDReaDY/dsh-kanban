import test from 'node:test'
import assert from 'node:assert/strict'
import { TASK_TEMPLATES, getTemplateById } from '../lib/templates.js'

test('TASK_TEMPLATES содержит 5 стандартных пресетов (#220)', () => {
  assert.equal(TASK_TEMPLATES.length, 5)
  const ids = TASK_TEMPLATES.map((t) => t.id)
  assert.deepEqual(ids, ['feature', 'bugfix', 'refactor', 'security', 'release'])

  for (const tmpl of TASK_TEMPLATES) {
    assert.ok(tmpl.title, `у шаблона ${tmpl.id} должен быть title`)
    assert.ok(tmpl.promptTemplate, `у шаблона ${tmpl.id} должен быть promptTemplate`)
    assert.ok(Array.isArray(tmpl.checklist), `у шаблона ${tmpl.id} должен быть checklist`)
    assert.ok(tmpl.checklist.length > 0, `у шаблона ${tmpl.id} чек-лист не должен быть пустым`)
  }
})

test('getTemplateById находит шаблон по id или undefined (#220)', () => {
  const feat = getTemplateById('feature')
  assert.ok(feat)
  assert.equal(feat.id, 'feature')
  assert.equal(feat.priority, 'medium')

  const nonExistent = getTemplateById('unknown-tmpl')
  assert.equal(nonExistent, undefined)
})

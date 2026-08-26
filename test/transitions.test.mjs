import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveColumn, isDraftPull, resolveTransition, waitingFromEvent,
  branchOfTask, pullsOfTask,
} from '../lib/transitions.js'

test('ветка есть, PR нет — работа идёт', () => {
  assert.equal(deriveColumn({ branchExists: true }), 'in-progress')
})

test('WIP PR не двигает карточку в ревью', () => {
  // WIP открывают рано; он означает «работа идёт», а не «смотрите».
  const obs = { branchExists: true, pulls: [{ state: 'open', title: 'WIP: черновик' }] }
  assert.equal(deriveColumn(obs), 'in-progress')
})

test('признак draft тоже считается черновиком', () => {
  const obs = { branchExists: true, pulls: [{ state: 'open', title: 'Готово', draft: true }] }
  assert.equal(deriveColumn(obs), 'in-progress')
})

test('PR снят с WIP — карточка едет в ревью', () => {
  const obs = { branchExists: true, pulls: [{ state: 'open', title: 'feat: готово' }] }
  assert.equal(deriveColumn(obs), 'review')
})

test('PR влит — карточка едет в deploy', () => {
  const obs = { branchExists: true, pulls: [{ state: 'closed', merged: true, title: 'feat: готово' }] }
  assert.equal(deriveColumn(obs), 'deploy')
})

test('issue закрыт, но ветка цела — это cleanup, а не done', () => {
  // Задача не завершена, пока cleanup не сделан. Доска, отправляющая карточку
  // в done по закрытию issue, врёт ровно там, где копятся забытые ветки.
  const obs = { issue: { state: 'closed' }, branchExists: true }
  assert.equal(deriveColumn(obs), 'cleanup')
})

test('issue закрыт и ветки нет — done', () => {
  assert.equal(deriveColumn({ issue: { state: 'closed' }, branchExists: false }), 'done')
})

test('закрытый issue сильнее целого PR', () => {
  const obs = { issue: { state: 'closed' }, branchExists: false, pulls: [{ state: 'open', title: 'x' }] }
  assert.equal(deriveColumn(obs), 'done')
})

test('без наблюдений колонка не выводится', () => {
  assert.equal(deriveColumn({}), undefined)
  assert.equal(deriveColumn(undefined), undefined)
  assert.equal(deriveColumn({ issue: { state: 'open' }, pulls: [] }), undefined)
})

test('черновик узнаётся по разным написаниям', () => {
  assert.equal(isDraftPull({ title: 'WIP: что-то' }), true)
  assert.equal(isDraftPull({ title: 'wip - что-то' }), true)
  assert.equal(isDraftPull({ title: 'Draft: что-то' }), true)
  assert.equal(isDraftPull({ title: 'feat: wipe cache' }), false, 'слово wipe — не WIP')
  assert.equal(isDraftPull({ title: 'готово' }), false)
})

test('Gitea сильнее инструмента, инструмент сильнее сессии', () => {
  const out = resolveTransition('backlog', [
    { column: 'in-progress', source: 'session' },
    { column: 'review', source: 'gitea' },
    { column: 'done', source: 'tool' },
  ])
  assert.equal(out.column, 'review')
  assert.equal(out.source, 'gitea')
})

test('предложение в ту же колонку отбрасывается', () => {
  assert.equal(resolveTransition('review', [{ column: 'review', source: 'gitea' }]), undefined)
})

test('слабый источник побеждает, когда сильный молчит', () => {
  const out = resolveTransition('backlog', [{ column: 'in-progress', source: 'session' }])
  assert.equal(out.source, 'session')
})

test('неизвестный источник не участвует', () => {
  assert.equal(resolveTransition('backlog', [{ column: 'done', source: 'откуда-то' }]), undefined)
})

test('пустой список предложений ничего не даёт', () => {
  assert.equal(resolveTransition('backlog', []), undefined)
  assert.equal(resolveTransition('backlog', undefined), undefined)
})

test('запрос разрешения и вопрос поднимают ожидание', () => {
  assert.equal(waitingFromEvent('approval/asked'), true)
  assert.equal(waitingFromEvent('question/requested'), true)
})

test('решение, начало хода и сообщение человека снимают ожидание', () => {
  assert.equal(waitingFromEvent('approval/decided'), false)
  assert.equal(waitingFromEvent('turn/start'), false)
  assert.equal(waitingFromEvent('user/message'), false)
})

test('прочие события про ожидание ничего не говорят', () => {
  assert.equal(waitingFromEvent('turn/end'), undefined)
  assert.equal(waitingFromEvent('assistant/chunk'), undefined)
  assert.equal(waitingFromEvent(undefined), undefined)
})

test('известная ветка признаётся, только пока существует', () => {
  assert.equal(branchOfTask({ branch: 'feat/7-x' }, [{ name: 'feat/7-x' }]), 'feat/7-x')
  assert.equal(branchOfTask({ branch: 'feat/7-x' }, [{ name: 'main' }]), undefined)
})

test('ветка задачи ищется по номеру issue, а не по угаданному шаблону', () => {
  // Имя ветки выбирает агент; общее в нём — номер issue.
  assert.equal(branchOfTask({ issueNumber: 7 }, ['main', 'fix/7-context-provide']), 'fix/7-context-provide')
  assert.equal(branchOfTask({ issueNumber: 7 }, ['feat/17-other']), undefined, 'номер 17 не содержит задачу 7')
  assert.equal(branchOfTask({ issueNumber: 7 }, ['main']), undefined)
  assert.equal(branchOfTask({}, ['feat/7-x']), undefined)
})

test('PR задачи узнаётся по ветке', () => {
  const pulls = [{ head: { ref: 'feat/7-x' }, title: 'A' }, { head: { ref: 'other' }, title: 'B' }]
  assert.deepEqual(pullsOfTask({ issueNumber: 7 }, pulls, 'feat/7-x').map((p) => p.title), ['A'])
})

test('PR задачи узнаётся по упоминанию issue', () => {
  const pulls = [{ head: { ref: 'x' }, title: 'feat: что-то', body: 'Refs: #7' }]
  assert.deepEqual(pullsOfTask({ issueNumber: 7 }, pulls, undefined).map((p) => p.title), ['feat: что-то'])
})

test('упоминание чужого номера не притягивает PR', () => {
  const pulls = [{ head: { ref: 'x' }, title: 'feat', body: 'Refs: #71' }]
  assert.equal(pullsOfTask({ issueNumber: 7 }, pulls, undefined).length, 0)
})

test('своя задача без issue не притягивает чужие PR', () => {
  const pulls = [{ head: { ref: 'x' }, title: 'feat', body: 'Refs: #7' }]
  assert.equal(pullsOfTask({}, pulls, undefined).length, 0)
})

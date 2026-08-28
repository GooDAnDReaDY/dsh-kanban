import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { freshStore } from './helpers.mjs'
import { withDefaults } from '../lib/config.js'
import { resolveConflict } from '../lib/transitions.js'
import { verifySignature, parseEvent } from '../lib/webhook.js'
import { planOutbound, createOutbox } from '../lib/outbound.js'
import { createGiteaClient } from '../lib/gitea.js'
import { applyObservation } from '../lib/sync.js'

const okJson = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
})

// ----------------------------------------------------------- разрешение конфликтов

test('двигалась только Gitea — она и побеждает', () => {
  const out = resolveConflict({
    localColumn: 'in-progress', remoteColumn: 'review',
    localUpdatedAt: 100, remoteUpdatedAt: 300, syncedAt: 200,
  })
  assert.equal(out.winner, 'remote')
  assert.equal(out.column, 'review')
  assert.equal(out.overridden, undefined)
})

test('двигалась только доска — Gitea не тянет карточку назад', () => {
  const out = resolveConflict({
    localColumn: 'review', remoteColumn: 'in-progress',
    localUpdatedAt: 300, remoteUpdatedAt: 100, syncedAt: 200,
  })
  assert.equal(out.winner, 'local')
  assert.equal(out.overridden, undefined)
})

test('двигались обе — побеждает более позднее, проигравшее НАЗЫВАЕТСЯ', () => {
  const out = resolveConflict({
    localColumn: 'review', remoteColumn: 'deploy',
    localUpdatedAt: 300, remoteUpdatedAt: 400, syncedAt: 200,
  })
  assert.equal(out.winner, 'remote')
  assert.equal(out.column, 'deploy')
  assert.equal(out.overridden, 'review', 'проигравшая сторона обязана быть названа')
})

test('двигались обе, доска позже — победа доски с названным проигравшим', () => {
  const out = resolveConflict({
    localColumn: 'cleanup', remoteColumn: 'deploy',
    localUpdatedAt: 500, remoteUpdatedAt: 400, syncedAt: 200,
  })
  assert.equal(out.winner, 'local')
  assert.equal(out.overridden, 'deploy')
})

test('колонки совпали — конфликта нет', () => {
  assert.equal(resolveConflict({
    localColumn: 'review', remoteColumn: 'review',
    localUpdatedAt: 500, remoteUpdatedAt: 400, syncedAt: 200,
  }).winner, 'none')
})

test('Gitea молчит — доска остаётся при своём', () => {
  assert.equal(resolveConflict({
    localColumn: 'review', remoteColumn: undefined,
    localUpdatedAt: 500, remoteUpdatedAt: 400, syncedAt: 200,
  }).winner, 'local')
})

test('первая сверка принимает положение дел, а не спорит с ним', () => {
  // Прошлого раза не было, защищать в карточке нечего: её только что завели.
  const out = resolveConflict({
    localColumn: 'backlog', remoteColumn: 'review',
    localUpdatedAt: 999999, remoteUpdatedAt: 1, syncedAt: 0,
  })
  assert.equal(out.winner, 'remote')
  assert.equal(out.overridden, undefined, 'при первой сверке перекрывать нечего')
})

// ----------------------------------------------------------- журнал расхождений

test('победа доски над Gitea записывается в журнал', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'cleanup', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
    syncedAt: 1000,
  })
  store.updateTask(task.id, { title: 'A' }) // поднимаем updatedAt выше syncedAt
  const fresh = store.getTask(task.id)
  applyObservation({
    store, task: fresh,
    observation: { column: 'deploy', branch: undefined, pull: { number: 9 } },
    remoteUpdatedAt: new Date(fresh.updatedAt - 5000).toISOString(),
    now: Date.now(),
  })
  const log = store.listTransitions(task.id)
  assert.equal(store.getTask(task.id).column, 'cleanup', 'доска победила — колонка прежняя')
  assert.equal(log.length, 1, 'расхождение обязано попасть в журнал')
  assert.ok(log[0].detail.includes('расхождение'))
  assert.ok(log[0].detail.includes('deploy'))
  cleanup()
})

test('победа Gitea над доской называет перекрытое', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'review', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
    syncedAt: 1000,
  })
  const fresh = store.getTask(task.id)
  applyObservation({
    store, task: fresh,
    observation: { column: 'deploy', pull: { number: 9 } },
    remoteUpdatedAt: new Date(fresh.updatedAt + 5000).toISOString(),
  })
  assert.equal(store.getTask(task.id).column, 'deploy')
  const log = store.listTransitions(task.id)
  assert.ok(log[0].detail.includes('перекрыто'))
  assert.ok(log[0].detail.includes('review'))
  cleanup()
})

test('время сверки записывается даже когда ничего не поменялось', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'review', title: 'A', owner: 'o', repo: 'r', issueNumber: 7,
  })
  applyObservation({ store, task: store.getTask(task.id), observation: { column: 'review' }, now: 12345 })
  assert.equal(store.getTask(task.id).syncedAt, 12345)
  cleanup()
})

// ----------------------------------------------------------- вебхук

test('подпись проверяется и принимает верную', () => {
  const body = '{"a":1}'
  const secret = 'тайна'
  const sig = createSignature(secret, body)
  assert.equal(verifySignature(secret, body, sig), true)
})

test('подделанная подпись отвергается', () => {
  const body = '{"a":1}'
  assert.equal(verifySignature('тайна', body, createSignature('другая', body)), false)
  assert.equal(verifySignature('тайна', body, 'a'.repeat(64)), false)
})

test('мусор вместо подписи отвергается без падения', () => {
  assert.equal(verifySignature('тайна', '{}', ''), false)
  assert.equal(verifySignature('тайна', '{}', 'не-шестнадцатеричное'), false)
  assert.equal(verifySignature('тайна', '{}', undefined), false)
})

test('без секрета вебхук не принимается вовсе', () => {
  // Иначе кто угодно снаружи двигал бы карточки.
  assert.equal(verifySignature('', '{}', 'a'.repeat(64)), false)
})

test('событие issue даёт адрес задачи', () => {
  const out = parseEvent({
    repository: { name: 'dsh-kanban', owner: { login: 'goodandready' } },
    issue: { number: 7 },
  })
  assert.deepEqual({ ...out }, { owner: 'goodandready', repo: 'dsh-kanban', issueNumber: 7 })
})

test('событие pull request тоже даёт номер', () => {
  const out = parseEvent({
    repository: { name: 'r', owner: { username: 'o' } },
    pull_request: { number: 9 },
  })
  assert.equal(out.issueNumber, 9)
})

test('событие ветки даёт репозиторий без номера', () => {
  const out = parseEvent({ repository: { name: 'r', owner: { login: 'o' } }, ref: 'refs/heads/feat/7-x' })
  assert.deepEqual({ ...out }, { owner: 'o', repo: 'r' })
})

test('событие без репозитория не разбирается', () => {
  assert.equal(parseEvent({}), undefined)
  assert.equal(parseEvent({ repository: {} }), undefined)
  assert.equal(parseEvent(undefined), undefined)
})

// ----------------------------------------------------------- отправка в Gitea

test('в Gitea уходит только закрытие issue', () => {
  // Метки колонок доска не ставит: колонку она выводит из состояния issue,
  // ветки и pull request, а метка лишь пересказывала бы то, что там уже есть.
  const config = withDefaults({})
  const task = { issueNumber: 7, owner: 'o', repo: 'r', labels: ['bug', 'hotfix'] }
  for (const column of ['backlog', 'in-progress', 'review', 'deploy', 'cleanup']) {
    assert.deepEqual(planOutbound(task, column, config), [], `колонка ${column} что-то отправила`)
  }
})

test('чужие метки доска не трогает вовсе', () => {
  // На issue живут метки процесса — bug, feat, hotfix. Теперь доска не только
  // не стирает их, но и не назначает ничего.
  const config = withDefaults({})
  const task = { issueNumber: 7, owner: 'o', repo: 'r', labels: ['hotfix', 'feat'] }
  const ops = planOutbound(task, 'done', config)
  assert.equal(ops.length, 1)
  assert.equal(ops[0].kind, 'close')
})

test('перевод в done закрывает issue', () => {
  const ops = planOutbound({ issueNumber: 7, owner: 'o', repo: 'r', labels: [] }, 'done', withDefaults({}))
  assert.deepEqual(ops, [{ kind: 'close', owner: 'o', repo: 'r', index: 7 }])
})

test('своей задаче без issue отправлять нечего', () => {
  assert.deepEqual(planOutbound({ labels: [] }, 'done', withDefaults({})), [])
})

test('очередь отправляет накопленное', async () => {
  const { store, cleanup } = freshStore()
  const sent = []
  const outbox = createOutbox({
    gitea: { closeIssue: async (op) => sent.push(op) },
    store,
  })
  outbox.push('t1', [{ kind: 'close', owner: 'o', repo: 'r', index: 7 }])
  const out = await outbox.flush()
  assert.equal(out.sent, 1)
  assert.equal(outbox.size(), 0)
  assert.equal(sent.length, 1)
  cleanup()
})

test('недоступный Gitea не теряет отправку, а откладывает', async () => {
  const { store, cleanup } = freshStore()
  const outbox = createOutbox({
    gitea: { closeIssue: async () => { throw new Error('нет связи') } },
    store, logger: { warn() {} },
  })
  outbox.push('t1', [{ kind: 'close', owner: 'o', repo: 'r', index: 7 }])
  const out = await outbox.flush()
  assert.equal(out.retried, 1)
  assert.equal(outbox.size(), 1, 'операция обязана остаться в очереди')
  cleanup()
})

test('исчерпав попытки, отправка попадает в журнал задачи, а не исчезает', async () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'review', title: 'A' })
  const outbox = createOutbox({
    gitea: { closeIssue: async () => { throw new Error('нет связи') } },
    store, logger: { warn() {} }, maxAttempts: 2,
  })
  outbox.push(task.id, [{ kind: 'close', owner: 'o', repo: 'r', index: 7 }])
  await outbox.flush()
  const out = await outbox.flush()
  assert.equal(out.dropped, 1)
  assert.equal(outbox.size(), 0)
  const log = store.listTransitions(task.id)
  assert.equal(log.length, 1, 'о потерянной отправке обязана остаться запись')
  assert.ok(log[0].detail.includes('не отправлено в Gitea'))
  cleanup()
})

// ----------------------------------------------------------- вспомогательное

function createSignature(secret, body) {
  // Тот же расчёт, что делает Gitea на своей стороне.
  return createHmac('sha256', secret).update(body).digest('hex')
}


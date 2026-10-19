import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers.mjs'
import { withDefaults } from '../lib/config.js'
import {
  buildBoard, applyMove, createTask, updateTask, deleteTask, taskLog,
  taskBySession, isTrustedRequest, getRejectionStatus, rejectUntrustedRequest,
  getClientIp, parseTaskPath, exportBoard, importBoard,
  isLoopbackAddress, isLanAddress, isTrustedHost,
} from '../lib/routes.js'

const config = withDefaults({})

test('buildBoard отдаёт колонки в порядке воркфлоу', () => {
  const { store, cleanup } = freshStore()
  const out = buildBoard({ store, config, board: 'main' })
  assert.deepEqual(out.columns.map((c) => c.id),
    ['backlog', 'in-progress', 'review', 'deploy', 'cleanup', 'done'])
  assert.equal(out.columns.find((c) => c.id === 'in-progress').limit, 3)
  assert.equal(out.columns.find((c) => c.id === 'backlog').limit, undefined)
  assert.deepEqual(out.tasks, [])
  cleanup()
})

test('buildBoard без корня отдаёт пустой projectRoot, не падает', () => {
  const { store, cleanup } = freshStore()
  const out = buildBoard({ store, config, board: 'main' })
  assert.deepEqual(out.projectRoot, { path: '', set: false })
  cleanup()
})

test('buildBoard отдаёт projectRoot как пришёл', () => {
  const { store, cleanup } = freshStore()
  const out = buildBoard({
    store, config, board: 'main',
    projectRoot: { path: '/projects', set: true },
  })
  assert.deepEqual(out.projectRoot, { path: '/projects', set: true })
  cleanup()
})

test('buildBoard считает карточки по колонкам', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.createTask({ board: 'main', column: 'backlog', title: 'B' })
  store.createTask({ board: 'main', column: 'review', title: 'C' })
  const out = buildBoard({ store, config, board: 'main' })
  assert.equal(out.columns.find((c) => c.id === 'backlog').count, 2)
  assert.equal(out.columns.find((c) => c.id === 'review').count, 1)
  cleanup()
})

test('фильтр repo отбирает задачи одного репозитория', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'one' })
  store.createTask({ board: 'main', column: 'backlog', title: 'B', owner: 'o', repo: 'two' })
  const out = buildBoard({ store, config, board: 'main', repo: 'one' })
  assert.deepEqual(out.tasks.map((t) => t.title), ['A'])
  cleanup()
})

test('превышение предела помечается, но не запрещается', () => {
  const { store, cleanup } = freshStore()
  const tight = withDefaults({ wipInProgress: 1 })
  store.createTask({ board: 'main', column: 'in-progress', title: 'A' })
  const b = store.createTask({ board: 'main', column: 'backlog', title: 'B' })
  const out = applyMove({ store, config: tight, id: b.id, column: 'in-progress' })
  assert.equal(out.task.column, 'in-progress')
  assert.equal(out.overLimit, true)
  cleanup()
})

test('перенос внутри колонки не пишет переход', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  const b = store.createTask({ board: 'main', column: 'backlog', title: 'B' })
  applyMove({ store, config, id: b.id, column: 'backlog', beforeId: a.id })
  assert.equal(store.listTransitions(b.id).length, 0)
  cleanup()
})

test('перенос в другую колонку пишет переход с источником', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  applyMove({ store, config, id: a.id, column: 'review' })
  const log = store.listTransitions(a.id)
  assert.equal(log.length, 1)
  assert.equal(log[0].fromCol, 'backlog')
  assert.equal(log[0].toCol, 'review')
  assert.equal(log[0].source, 'manual')
  cleanup()
})

test('перенос несуществующей задачи отдаёт 404, а не падает', () => {
  const { store, cleanup } = freshStore()
  const out = applyMove({ store, config, id: 'нет-такой', column: 'done' })
  assert.equal(out.status, 404)
  assert.equal(out.error, 'task-not-found')
  cleanup()
})

test('своя задача создаётся с заголовком', () => {
  const { store, cleanup } = freshStore()
  const out = createTask({ store, input: { title: '  Прибраться в логах  ', labels: ['chore', 7] } })
  assert.equal(out.task.title, 'Прибраться в логах')
  assert.deepEqual(out.task.labels, ['chore'])
  assert.equal(out.task.column, 'backlog')
  cleanup()
})

test('задача без заголовка отвергается', () => {
  const { store, cleanup } = freshStore()
  assert.equal(createTask({ store, input: { title: '   ' } }).status, 400)
  assert.equal(createTask({ store, input: {} }).status, 400)
  cleanup()
})

test('неизвестная колонка при создании откатывается в backlog', () => {
  const { store, cleanup } = freshStore()
  const out = createTask({ store, input: { title: 'A', column: 'нет-такой' } })
  assert.equal(out.task.column, 'backlog')
  cleanup()
})

test('правка меняет заголовок и метки, но не колонку', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'review', title: 'Старый' })
  const out = updateTask({ store, id: a.id, input: { title: 'Новый', labels: ['bug'], column: 'done' } })
  assert.equal(out.task.title, 'Новый')
  assert.deepEqual(out.task.labels, ['bug'])
  assert.equal(out.task.column, 'review')
  cleanup()
})

test('правка пишет приоритет, чужие значения отбрасываются', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  const out = updateTask({ store, id: a.id, input: { priority: 'high' } })
  assert.equal(out.task.priority, 'high')
  // Чужое значение не роняет правку и не пишется.
  const out2 = updateTask({ store, id: a.id, input: { priority: 'urgent', title: 'B' } })
  assert.equal(out2.task.priority, 'high')
  assert.equal(out2.task.title, 'B')
  // Пустой приоритет сбрасывает.
  const out3 = updateTask({ store, id: a.id, input: { priority: '' } })
  assert.equal(out3.task.priority, '')
  cleanup()
})

test('правка пишет дедлайн, ноль снимает, мусор отбрасывается', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  const out = updateTask({ store, id: a.id, input: { dueAt: 1700000000000 } })
  assert.equal(out.task.dueAt, 1700000000000)
  // Отрицательное и не-число не пишутся.
  const out2 = updateTask({ store, id: a.id, input: { dueAt: -5, title: 'B' } })
  assert.equal(out2.task.dueAt, 1700000000000)
  assert.equal(out2.task.title, 'B')
  // Ноль снимает дедлайн.
  const out3 = updateTask({ store, id: a.id, input: { dueAt: 0 } })
  assert.equal(out3.task.dueAt, 0)
  cleanup()
})

test('buildBoard помечает просроченные по дедлайну', () => {
  const { store, cleanup } = freshStore()
  const now = Date.now()
  store.createTask({ board: 'main', column: 'backlog', title: 'прошёл', dueAt: now - 1000 })
  store.createTask({ board: 'main', column: 'backlog', title: 'будущий', dueAt: now + 100000 })
  store.createTask({ board: 'main', column: 'backlog', title: 'без срока' })
  const out = buildBoard({ store, config, board: 'main' })
  const byTitle = Object.fromEntries(out.tasks.map((t) => [t.title, t]))
  assert.equal(byTitle['прошёл'].overdue, true)
  assert.equal(byTitle['будущий'].overdue, false)
  assert.equal(byTitle['без срока'].overdue, false)
  cleanup()
})

test('правка несуществующей задачи отдаёт 404', () => {
  const { store, cleanup } = freshStore()
  assert.equal(updateTask({ store, id: 'нет', input: { title: 'A' } }).status, 404)
  assert.equal(deleteTask({ store, id: 'нет' }).status, 404)
  assert.equal(taskLog({ store, id: 'нет' }).status, 404)
  cleanup()
})

test('журнал задачи читается через маршрут', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  applyMove({ store, config, id: a.id, column: 'in-progress' })
  assert.equal(taskLog({ store, id: a.id }).transitions.length, 1)
  cleanup()
})

test('задача по сессии: отсутствие — штатный ответ null', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A' })
  store.updateTask(a.id, { sessionId: 'kanban-1-abc' })
  assert.equal(taskBySession({ store, sessionId: 'kanban-1-abc' }).task.id, a.id)
  assert.equal(taskBySession({ store, sessionId: 'msgw-xyz' }).task, null)
  cleanup()
})

test('правка с чужого сайта отклоняется (isTrustedRequest) (#261)', () => {
  // Отсутствие заголовка sec-fetch-site отклоняется (#261)
  assert.equal(isTrustedRequest({ headers: {} }), false)
  assert.equal(isTrustedRequest(undefined), false)
  assert.equal(isTrustedRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isTrustedRequest({ headers: { 'sec-fetch-site': 'other' } }), false)

  // Чужой origin отклоняется
  assert.equal(isTrustedRequest({
    headers: {
      'sec-fetch-site': 'same-origin',
      origin: 'http://evil.com',
      host: 'localhost:3000',
    },
  }), false)

  // Чужой remoteAddress отклоняется
  assert.equal(isTrustedRequest({
    headers: {
      'sec-fetch-site': 'same-origin',
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
    },
    socket: { remoteAddress: '198.51.100.1' },
  }), false)

  // Легитимный same-origin с loopback разрешается
  assert.equal(isTrustedRequest({
    headers: {
      'sec-fetch-site': 'same-origin',
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }), true)

  // DSH Desktop: sec-fetch-site и origin отсутствуют, remoteAddress loopback — разрешается (#363)
  assert.equal(isTrustedRequest({
    headers: {
      host: '127.0.0.1:3000',
      cookie: 'token=xyz',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }), true)

  // Запрос без sec-fetch-site с не-loopback адреса отклоняется (#363)
  assert.equal(isTrustedRequest({
    headers: {
      host: '192.168.1.111:3000',
    },
    socket: { remoteAddress: '192.168.1.50' },
  }), false)
})

test('isLoopbackAddress, isLanAddress, isTrustedHost валидируют адреса (#369)', () => {
  // Loopback
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.0.1.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('localhost'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('[::1]'), true)
  assert.equal(isLoopbackAddress('192.168.1.1'), false)
  assert.equal(isLoopbackAddress('evil.com'), false)
  assert.equal(isLoopbackAddress(undefined), false)

  // LAN
  assert.equal(isLanAddress('192.168.1.1'), true)
  assert.equal(isLanAddress('10.0.0.1'), true)
  assert.equal(isLanAddress('172.16.0.1'), true)
  assert.equal(isLanAddress('172.31.255.255'), true)
  assert.equal(isLanAddress('127.0.0.1'), true)
  assert.equal(isLanAddress('172.32.0.1'), false)
  assert.equal(isLanAddress('8.8.8.8'), false)
  assert.equal(isLanAddress('evil.com'), false)

  // Trusted host
  assert.equal(isTrustedHost('localhost:3000'), true)
  assert.equal(isTrustedHost('127.0.0.1:3000'), true)
  assert.equal(isTrustedHost('[::1]:3000'), true)
  assert.equal(isTrustedHost('minipc.local:3000'), true)
  assert.equal(isTrustedHost('192.168.1.111:3000'), true)
  assert.equal(isTrustedHost('10.0.0.5:80'), true)
  assert.equal(isTrustedHost('attacker.evil.com:3000'), false)
  assert.equal(isTrustedHost('rebound.example.com'), false)
  assert.equal(isTrustedHost('8.8.8.8:3000'), false)
  assert.equal(isTrustedHost(''), false)
  assert.equal(isTrustedHost(undefined), false)
})

test('DNS-rebinding и поддельный origin отклоняются (isTrustedRequest) (#369)', () => {
  // Rebound page targeting loopback with matching Origin and Host
  assert.equal(isTrustedRequest({
    headers: {
      'sec-fetch-site': 'same-origin',
      origin: 'http://attacker.rebound.com:3000',
      host: 'attacker.rebound.com:3000',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }), false)

  // Rebound request without sec-fetch-site
  assert.equal(isTrustedRequest({
    headers: {
      host: 'attacker.rebound.com:3000',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }), false)

  // Public IP in host header rejected even with loopback socket
  assert.equal(isTrustedRequest({
    headers: {
      host: '203.0.113.1:3000',
      'sec-fetch-site': 'same-origin',
      origin: 'http://203.0.113.1:3000',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }), false)

  // Rebound Referer header rejected
  assert.equal(isTrustedRequest({
    headers: {
      host: 'localhost:3000',
      'sec-fetch-site': 'same-origin',
      origin: 'http://localhost:3000',
      referer: 'http://attacker.rebound.com/page',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }), false)

  // Unauthenticated LAN browser request without connection is rejected (#384)
  assert.equal(isTrustedRequest({
    headers: {
      host: '192.168.1.111:3000',
      'sec-fetch-site': 'same-origin',
      origin: 'http://192.168.1.111:3000',
    },
    socket: { remoteAddress: '192.168.1.50' },
  }), false)

  // Authenticated LAN browser request with connection service allowed (#384)
  assert.equal(isTrustedRequest({
    headers: {
      host: '192.168.1.111:3000',
      'sec-fetch-site': 'same-origin',
      origin: 'http://192.168.1.111:3000',
    },
    socket: { remoteAddress: '192.168.1.50' },
  }, { connection: { requestRejection: () => undefined } }), true)

  // Unauthenticated .local browser request without connection is rejected (#384)
  assert.equal(isTrustedRequest({
    headers: {
      host: 'minipc.local:3000',
      'sec-fetch-site': 'same-origin',
      origin: 'http://minipc.local:3000',
    },
    socket: { remoteAddress: '192.168.1.50' },
  }), false)

  // Authenticated .local browser request with connection service allowed (#384)
  assert.equal(isTrustedRequest({
    headers: {
      host: 'minipc.local:3000',
      'sec-fetch-site': 'same-origin',
      origin: 'http://minipc.local:3000',
    },
    socket: { remoteAddress: '192.168.1.50' },
  }, { connection: { requestRejection: () => undefined } }), true)

  // Legitimate IPv6 loopback
  assert.equal(isTrustedRequest({
    headers: {
      host: '[::1]:3000',
      'sec-fetch-site': 'same-origin',
      origin: 'http://[::1]:3000',
    },
    socket: { remoteAddress: '::1' },
  }), true)
})

test('путь задачи разбирается вместе с действием', () => {
  assert.deepEqual(parseTaskPath('/dsh-kanban/task/abc'), { id: 'abc', action: undefined })
  assert.deepEqual(parseTaskPath('/dsh-kanban/task/abc/move'), { id: 'abc', action: 'move' })
  assert.deepEqual(parseTaskPath('/dsh-kanban/task/abc/log'), { id: 'abc', action: 'log' })
  assert.deepEqual(parseTaskPath('/dsh-kanban/task/abc/message'), { id: 'abc', action: 'message' })
  assert.equal(parseTaskPath('/dsh-kanban/board'), undefined)
  assert.equal(parseTaskPath('/dsh-kanban/task/'), undefined)
})

test('идентификатор задачи в пути раскодируется', () => {
  assert.equal(parseTaskPath('/dsh-kanban/task/a%2Fb').id, 'a/b')
})

test('экспорт отдаёт все доски, задачи и переходы', () => {
  const { store, cleanup } = freshStore()
  const a = store.createTask({ board: 'main', column: 'backlog', title: 'A', priority: 'high', dueAt: 1700000000000 })
  store.addTransition({ taskId: a.id, fromCol: undefined, toCol: 'backlog', source: 'manual' })
  const dump = exportBoard({ store })
  assert.equal(dump.version, 1)
  assert.ok(dump.boards.some((b) => b.id === 'main'))
  assert.equal(dump.tasks.length, 1)
  assert.equal(dump.tasks[0].title, 'A')
  assert.equal(dump.tasks[0].priority, 'high')
  assert.equal(dump.tasks[0].dueAt, 1700000000000)
  assert.equal(dump.transitions.length, 1)
  cleanup()
})

test('импорт восстанавливает задачи идемпотентно', () => {
  const { store, cleanup } = freshStore()
  const input = {
    version: 1,
    boards: [{ id: 'main', title: 'Проектная доска', kind: 'project', position: 'i', createdAt: 1 }],
    tasks: [{
      id: 'x1', board: 'main', column: 'backlog', title: 'Из бэкапа', body: 'тело',
      priority: 'medium', dueAt: 1700000000000, labels: ['bug'], createdAt: 2,
    }],
  }
  const first = importBoard({ store, input })
  assert.equal(first.imported, 1)
  assert.equal(first.skipped, 0)
  assert.equal(store.getTask('x1').title, 'Из бэкапа')
  assert.equal(store.getTask('x1').priority, 'medium')
  // Повторный импорт не плодит дублей.
  const second = importBoard({ store, input })
  assert.equal(second.imported, 0)
  assert.equal(second.skipped, 1)
  assert.equal(store.listTasks().length, 1)
  cleanup()
})

test('импорт отклоняет битый снимок', () => {
  const { store, cleanup } = freshStore()
  assert.equal(importBoard({ store, input: null }).status, 400)
  assert.equal(importBoard({ store, input: {} }).status, 400)
  assert.equal(importBoard({ store, input: { version: 2, tasks: [] } }).status, 400)
  assert.equal(importBoard({ store, input: { version: 1, tasks: 'не список' } }).status, 400)
  cleanup()
})

test('все зарегистрированные маршруты имеют уникальные пути (#178)', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(path.join(root, 'lib/index.js'), 'utf8')
  const matches = [...src.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(matches.length > 0, 'маршруты не найдены в lib/index.js')
  const seen = new Set()
  const duplicates = []
  for (const p of matches) {
    if (seen.has(p)) duplicates.push(p)
    seen.add(p)
  }
  assert.deepEqual(duplicates, [], 'найдены повторяющиеся пути маршрутов: ' + duplicates.join(', '))
})


test('аутентификация через connection.requestRejection защищает LAN-запросы (#384)', () => {
  const lanReq = {
    headers: {
      host: '192.168.1.111:3000',
      'sec-fetch-site': 'same-origin',
      origin: 'http://192.168.1.111:3000',
    },
    socket: { remoteAddress: '192.168.1.50' },
  }

  // 1. LAN без connection -> 401
  assert.equal(getRejectionStatus(lanReq), 401)
  assert.equal(isTrustedRequest(lanReq), false)

  // 2. LAN с connection, возвращающим 401 -> 401
  const unauthConn = { connection: { requestRejection: () => 401 } }
  assert.equal(getRejectionStatus(lanReq, unauthConn), 401)
  assert.equal(isTrustedRequest(lanReq, unauthConn), false)

  // 3. LAN с connection, возвращающим 403 -> 403
  const forbidConn = { connection: { requestRejection: () => 403 } }
  assert.equal(getRejectionStatus(lanReq, forbidConn), 403)
  assert.equal(isTrustedRequest(lanReq, forbidConn), false)

  // 4. LAN с упавшим connection -> 403 (fail closed)
  const throwConn = { connection: { requestRejection: () => { throw new Error('boom') } } }
  assert.equal(getRejectionStatus(lanReq, throwConn), 403)
  assert.equal(isTrustedRequest(lanReq, throwConn), false)

  // 5. LAN с успешной аутентификацией (undefined) -> undefined (allowed)
  const authConn = { connection: { requestRejection: () => undefined } }
  assert.equal(getRejectionStatus(lanReq, authConn), undefined)
  assert.equal(isTrustedRequest(lanReq, authConn), true)

  // 6. Loopback без connection разрешается для локальных скриптов и тестов
  const loopReq = {
    headers: {
      host: '127.0.0.1:3000',
      'sec-fetch-site': 'same-origin',
      origin: 'http://127.0.0.1:3000',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }
  assert.equal(getRejectionStatus(loopReq), undefined)
  assert.equal(isTrustedRequest(loopReq), true)

  // 7. rejectUntrustedRequest отклоняет неавторизованный запрос со статусом 401
  let statusCode = null
  let bodyPayload = null
  const res401 = {
    writeHead(code) { statusCode = code },
    end(data) { bodyPayload = JSON.parse(data) },
  }
  assert.equal(rejectUntrustedRequest(lanReq, res401), true)
  assert.equal(statusCode, 401)
  assert.equal(bodyPayload.error, 'unauthorized')

  // 8. rejectUntrustedRequest отклоняет cross-site запрос со статусом 403
  const crossReq = {
    headers: {
      host: '127.0.0.1:3000',
      'sec-fetch-site': 'cross-site',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }
  let crossStatus = null
  let crossBody = null
  const res403 = {
    writeHead(code) { crossStatus = code },
    end(data) { crossBody = JSON.parse(data) },
  }
  assert.equal(rejectUntrustedRequest(crossReq, res403), true)
  assert.equal(crossStatus, 403)
  assert.equal(crossBody.error, 'cross-site')

  // 9. rejectUntrustedRequest пропускает доверенный запрос
  assert.equal(rejectUntrustedRequest(lanReq, {}, authConn), false)
})

// Архив выполненного и подхват задач из Gitea.
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseWatchList, watchedRepos, shouldTake, archiveBefore, isWatched } from '../lib/intake.js'
import { intakeAll, archiveOverdue } from '../lib/sync.js'
import { setArchived, listArchive, buildBoard, deleteTask } from '../lib/routes.js'
import { withDefaults } from '../lib/config.js'
import { freshStore } from './helpers.mjs'

const config = withDefaults({})
const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

const issue = (number, extra = {}) => ({
  number, title: 'задача ' + number, body: '', state: 'open', labels: [], html_url: 'u', ...extra,
})

// ------------------------------------------------- список репозиториев

test('список разбирается через запятую, пробелы не в счёт', () => {
  assert.deepEqual(parseWatchList(' раз , два,три '), ['раз', 'два', 'три'])
})

test('пустая настройка не означает «следить за всеми»', () => {
  // Первый же запуск с незаполненной настройкой залил бы доску всеми
  // открытыми issue организации.
  for (const empty of ['', '  ', ',,', undefined, null]) {
    assert.deepEqual(parseWatchList(empty), [], String(empty))
    assert.deepEqual(watchedRepos({ config: { watchRepos: empty }, owner: 'o' }), [])
  }
})

test('имя допускается полное и короткое', () => {
  const out = watchedRepos({ config: { watchRepos: 'чужой/репо, свой' }, owner: 'о' })
  assert.deepEqual(out, [{ owner: 'чужой', repo: 'репо' }, { owner: 'о', repo: 'свой' }])
})

test('короткое имя без владельца отбрасывается, а не гадается', () => {
  assert.deepEqual(watchedRepos({ config: { watchRepos: 'свой' }, owner: undefined }), [])
})

test('повтор в списке репозиторий не задваивает', () => {
  const out = watchedRepos({ config: { watchRepos: 'о/р, о/р, р' }, owner: 'о' })
  assert.deepEqual(out, [{ owner: 'о', repo: 'р' }])
})

// ------------------------------------------------- брать или не брать

test('открытый issue без карточки берётся', () => {
  const { store, cleanup } = freshStore()
  assert.equal(shouldTake({ store, owner: 'o', repo: 'r', issue: issue(1) }).take, true)
  cleanup()
})

test('закрытый issue не берётся: он уже не работа', () => {
  const { store, cleanup } = freshStore()
  const out = shouldTake({ store, owner: 'o', repo: 'r', issue: issue(1, { state: 'closed' }) })
  assert.equal(out.take, false)
  assert.match(out.why, /закрыт/)
  cleanup()
})

test('pull request на доску не тащим', () => {
  // PR — ход работы, а не сама работа; в Gitea он тоже issue.
  const { store, cleanup } = freshStore()
  const out = shouldTake({ store, owner: 'o', repo: 'r', issue: issue(1, { pull_request: {} }) })
  assert.equal(out.take, false)
  assert.match(out.why, /pull request/)
  cleanup()
})

test('issue с уже заведённой карточкой второй раз не берётся', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 1 })
  const out = shouldTake({ store, owner: 'o', repo: 'r', issue: issue(1) })
  assert.equal(out.take, false)
  assert.match(out.why, /уже есть/)
  cleanup()
})

test('удалённая карточка не возвращается', () => {
  // Удаление значит «видеть её здесь не хочу»; возвращать каждый проход —
  // спорить с человеком каждые две минуты.
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 1,
  })
  store.deleteTask(task.id)
  const out = shouldTake({ store, owner: 'o', repo: 'r', issue: issue(1) })
  assert.equal(out.take, false)
  assert.match(out.why, /удалили/)
  cleanup()
})

test('отказ помнится только для своего issue', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({
    board: 'main', column: 'backlog', title: 'A', owner: 'o', repo: 'r', issueNumber: 1,
  })
  store.deleteTask(task.id)
  assert.equal(shouldTake({ store, owner: 'o', repo: 'r', issue: issue(2) }).take, true)
  assert.equal(shouldTake({ store, owner: 'o', repo: 'другой', issue: issue(1) }).take, true)
  cleanup()
})

test('своя задача без issue отказом не считается', () => {
  // У неё нет номера, и запоминать нечего.
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'simple', column: 'backlog', title: 'своя' })
  assert.doesNotThrow(() => store.deleteTask(task.id))
  cleanup()
})

// ------------------------------------------------- проход подхвата

test('подхват заводит карточки и не задваивает их на втором проходе', async () => {
  const { store, cleanup } = freshStore()
  const gitea = { listIssues: async () => [issue(1), issue(2)] }
  const cfg = { ...config, watchRepos: 'o/r' }

  const first = await intakeAll({ gitea, store, config: cfg, owner: 'o' })
  assert.equal(first.added, 2)
  const second = await intakeAll({ gitea, store, config: cfg, owner: 'o' })
  assert.equal(second.added, 0)
  assert.equal(second.skipped, 2)
  assert.equal(store.listTasks({ board: 'main' }).length, 2)
  cleanup()
})

test('недоступный репозиторий не роняет остальные', async () => {
  const { store, cleanup } = freshStore()
  const gitea = {
    listIssues: async ({ repo }) => {
      if (repo === 'плохой') throw new Error('репозиторий не найден')
      return [issue(1)]
    },
  }
  const out = await intakeAll({
    gitea, store, config: { ...config, watchRepos: 'o/плохой, o/хороший' }, owner: 'o',
    logger: { warn() {} },
  })
  assert.equal(out.added, 1)
  assert.equal(out.failed, 1)
  assert.match(out.problem.message, /не найден/)
  cleanup()
})

test('пустой список репозиториев ничего не забирает', async () => {
  const { store, cleanup } = freshStore()
  let called = false
  const gitea = { listIssues: async () => { called = true; return [issue(1)] } }
  const out = await intakeAll({ gitea, store, config, owner: 'o' })
  assert.equal(out.added, 0)
  assert.equal(called, false, 'к Gitea не должно быть ни одного обращения')
  cleanup()
})

// ------------------------------------------------- архив

test('порог считается в днях, ноль отключает', () => {
  assert.equal(archiveBefore({ now: NOW, afterDays: 7 }), NOW - 7 * DAY)
  for (const off of [0, -1, undefined, 'неделя']) {
    assert.equal(archiveBefore({ now: NOW, afterDays: off }), undefined, String(off))
  }
})

test('в архив уходит отстоявшее срок, свежее остаётся', () => {
  // Задачу не состарить напрямую — своего пути у хранилища нет и быть не
  // должно. Вместо этого сдвигаем «сейчас» вперёд: с точки зрения порога это
  // ровно то же самое, а ждать неделю в тесте не приходится.
  const { store, cleanup } = freshStore()
  const old = store.createTask({ board: 'main', column: 'done', title: 'старая' })

  const out = archiveOverdue({
    store, config: { ...config, archiveAfterDays: 7 }, now: Date.now() + 8 * DAY,
  })
  assert.equal(out.archived, 1)
  assert.equal(store.getTask(old.id).archivedAt > 0, true)

  const fresh = store.createTask({ board: 'main', column: 'done', title: 'свежая' })
  assert.equal(archiveOverdue({ store, config: { ...config, archiveAfterDays: 7 } }).archived, 0)
  assert.equal(store.getTask(fresh.id).archivedAt, 0)
  cleanup()
})

test('переехавшая в done карточка считает срок заново', () => {
  // Отметка входа в колонку двигается переносом; иначе задача, полежавшая
  // неделю в ревью, уехала бы в архив в ту же секунду, что и в «Выполнено».
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'review', title: 'A' })
  store.moveTask(task.id, { column: 'done' })
  assert.equal(archiveOverdue({ store, config: { ...config, archiveAfterDays: 7 } }).archived, 0)
  cleanup()
})

test('застрявшее в ревью не архивируется никогда', () => {
  // Задача, висящая в ревью месяц, — это сигнал, а не мусор.
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'review', title: 'висит' })
  const out = archiveOverdue({ store, config: { ...config, archiveAfterDays: 0.000001 }, now: NOW })
  assert.equal(out.archived, 0)
  cleanup()
})

test('нулевой порог не убирает ничего', () => {
  const { store, cleanup } = freshStore()
  store.createTask({ board: 'main', column: 'done', title: 'A' })
  assert.equal(archiveOverdue({ store, config: { ...config, archiveAfterDays: 0 }, now: NOW }).archived, 0)
  cleanup()
})

test('архивная карточка уходит с доски, но не удаляется', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'done', title: 'A' })
  setArchived({ store, id: task.id, archived: true, now: NOW })
  assert.equal(buildBoard({ store, config }).tasks.length, 0)
  assert.equal(listArchive({ store }).tasks.length, 1)
  assert.notEqual(store.getTask(task.id), undefined)
  cleanup()
})

test('возврат ставит карточку в ту же колонку', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'done', title: 'A' })
  setArchived({ store, id: task.id, archived: true, now: NOW })
  const back = setArchived({ store, id: task.id, archived: false })
  assert.equal(back.task.column, 'done')
  assert.equal(back.task.archivedAt, 0)
  assert.equal(buildBoard({ store, config }).tasks.length, 1)
  cleanup()
})

test('архивация несуществующей задачи — честный отказ', () => {
  const { store, cleanup } = freshStore()
  const out = setArchived({ store, id: 'нет-такой', archived: true })
  assert.equal(out.error, 'task-not-found')
  assert.equal(out.status, 404)
  cleanup()
})

test('счётчики колонок архив не считают', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'done', title: 'A' })
  setArchived({ store, id: task.id, archived: true, now: NOW })
  const done = buildBoard({ store, config }).columns.find((c) => c.id === 'done')
  assert.equal(done.count, 0)
  cleanup()
})

test('удаление задачи из архива всё ещё возможно', () => {
  const { store, cleanup } = freshStore()
  const task = store.createTask({ board: 'main', column: 'done', title: 'A' })
  setArchived({ store, id: task.id, archived: true, now: NOW })
  assert.deepEqual(deleteTask({ store, id: task.id }), { ok: true })
  assert.equal(listArchive({ store }).tasks.length, 0)
  cleanup()
})

// ------------------------------------------------- подхват по одному репозиторию (#99)

test('подхват сужается до одного репозитория', async () => {
  // Событие вебхука говорит про один репозиторий; полный обход означал бы
  // обращение ко всем при каждом чихе в любом из них.
  const { store, cleanup } = freshStore()
  const asked = []
  const gitea = {
    listIssues: async ({ repo }) => { asked.push(repo); return [issue(1)] },
  }
  const out = await intakeAll({
    gitea, store, config: { ...config, watchRepos: 'o/раз, o/два, o/три' }, owner: 'o',
    only: (pair) => pair.repo === 'два',
  })
  assert.deepEqual(asked, ['два'])
  assert.equal(out.added, 1)
  cleanup()
})

test('без сужения обходятся все отслеживаемые', () => {
  const { store, cleanup } = freshStore()
  assert.deepEqual(
    watchedRepos({ config: { watchRepos: 'o/раз, o/два' }, owner: 'o' }).map((p) => p.repo),
    ['раз', 'два'],
  )
  cleanup()
})

test('репозиторий вне списка отслеживаемым не считается', () => {
  // Событие оттуда подхвата не заслуживает: по таймеру мы туда не ходим, и
  // через вебхук ходить не должны — иначе список перестаёт что-либо решать.
  const cfg = { watchRepos: 'o/свой' }
  assert.equal(isWatched({ config: cfg, owner: 'o', defaultOwner: 'o', repo: 'свой' }), true)
  assert.equal(isWatched({ config: cfg, owner: 'o', defaultOwner: 'o', repo: 'чужой' }), false)
  assert.equal(isWatched({ config: cfg, owner: 'другой', defaultOwner: 'o', repo: 'свой' }), false)
})

test('пустой список не делает отслеживаемым никого', () => {
  assert.equal(isWatched({ config: { watchRepos: '' }, owner: 'o', defaultOwner: 'o', repo: 'р' }), false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, stubCtx } from './client-load.mjs'

/**
 * Значения рождены внутри vm-контекста: у них другой прототип, и строгое
 * сравнение отвергло бы совпадающее содержимое. Переносим в свой контекст.
 */
const pair = (o) => ({ afterId: o.afterId, beforeId: o.beforeId })

const { exported } = loadClient()
const h = exported.helpers
const column = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

test('перенос в начало колонки: соседа слева нет', () => {
  assert.deepEqual(pair(h.neighboursFor(column, 'c', 0)), { afterId: undefined, beforeId: 'a' })
})

test('перенос в конец колонки: соседа справа нет', () => {
  assert.deepEqual(pair(h.neighboursFor(column, 'c', 2)), { afterId: 'b', beforeId: undefined })
})

test('перенос в середину даёт обоих соседей', () => {
  assert.deepEqual(pair(h.neighboursFor(column, 'c', 1)), { afterId: 'a', beforeId: 'b' })
})

test('перетаскиваемая карточка не может быть своим же соседом', () => {
  const out = pair(h.neighboursFor(column, 'b', 1))
  assert.notEqual(out.afterId, 'b')
  assert.notEqual(out.beforeId, 'b')
  assert.deepEqual(out, { afterId: 'a', beforeId: 'c' })
})

test('индекс за пределами списка прижимается к краю', () => {
  assert.deepEqual(pair(h.neighboursFor(column, 'a', 99)), { afterId: 'c', beforeId: undefined })
  assert.deepEqual(pair(h.neighboursFor(column, 'a', -5)), { afterId: undefined, beforeId: 'b' })
})

test('перенос в пустую колонку не даёт соседей', () => {
  assert.deepEqual(pair(h.neighboursFor([], 'a', 0)), { afterId: undefined, beforeId: undefined })
})

test('карточки колонки отбираются по колонке', () => {
  const tasks = [{ id: '1', column: 'backlog' }, { id: '2', column: 'review' }, { id: '3', column: 'backlog' }]
  assert.deepEqual(Array.from(h.tasksOf(tasks, 'backlog')).map((t) => t.id), ['1', '3'])
  assert.equal(Array.from(h.tasksOf(tasks, 'done')).length, 0)
})

test('подпись карточки показывает репозиторий и номер issue', () => {
  assert.equal(h.cardRef({ repo: 'dsh-kanban', issueNumber: 12 }), 'dsh-kanban#12')
  assert.equal(h.cardRef({ repo: 'dsh-kanban' }), 'dsh-kanban')
  assert.equal(h.cardRef({}), '')
  assert.equal(h.cardRef(undefined), '')
})

test('строка состояния собирается из заполненных полей', () => {
  assert.equal(h.cardStatus({ model: 'claude-opus-5', branch: 'feat/x' }), 'claude-opus-5 · feat/x')
  assert.equal(h.cardStatus({ model: 'claude-opus-5' }), 'claude-opus-5')
  assert.equal(h.cardStatus({}), '')
})

test('пустой ответ доски всё равно даёт шесть колонок', () => {
  const out = h.normalizeBoard(undefined)
  assert.deepEqual(Array.from(out.columns).map((c) => c.id),
    ['backlog', 'in-progress', 'review', 'deploy', 'cleanup', 'done'])
  assert.equal(Array.from(out.tasks).length, 0)
})


test('каждой ошибке маршрута отвечает свой ключ перевода', () => {
  assert.equal(h.errorKey('gitea-absent'), 'error.giteaAbsent')
  assert.equal(h.errorKey('gitea-unconfigured'), 'error.giteaUnconfigured')
  assert.equal(h.errorKey('task-has-no-issue'), 'error.taskHasNoIssue')
  assert.equal(h.errorKey('что-то новое'), 'error.unknown')
})

test('при живом слоте плагинов карточка встаёт именно туда', () => {
  const { ctx, registered } = stubCtx({ available: ['settings.plugin.item', 'app.section'] })
  exported.apply(ctx)
  const card = registered.find((e) => e.name === 'settings.plugin.item')
  assert.ok(card, 'карточка не зарегистрирована')
  assert.equal(card.key, 'dsh-kanban', 'ключ слота не равен пространству настроек')
  assert.equal(card.locale, 'dsh-kanban', 'без locale компонент не получит props.t')
})

test('без слота плагинов карточка уходит в запасной раздел', () => {
  // Соседний плагин делает так же: если настроечного слота в сборке нет,
  // регистрация не пройдёт, и настройки просто пропали бы.
  const { ctx, registered } = stubCtx({ available: ['settings.section'] })
  exported.apply(ctx)
  assert.ok(registered.some((e) => e.name === 'settings.section'))
})

test('доска больше не занимает слот настроек', () => {
  // Раздела верхнего уровня в сборке нет, а настройки — не место для доски:
  // она встраивается прямо в оболочку.
  const { ctx, registered } = stubCtx({ available: ['settings.plugin.item', 'settings.section'] })
  exported.apply(ctx)
  assert.equal(registered.filter((e) => e.id === '@goodandready-private/dsh-kanban.board').length, 0)
})

test('без DOM встраивание молча ничего не делает и не падает', () => {
  // В тестах документа нет; плагин обязан пережить это, а не рухнуть.
  const { ctx } = stubCtx({ available: ['settings.plugin.item'] })
  assert.doesNotThrow(() => exported.apply(ctx))
})

test('переключатель доски уведомляет подписчиков только при смене', () => {
  const toggle = exported.helpers.createToggle()
  let calls = 0
  const off = toggle.subscribe(() => { calls += 1 })
  assert.equal(toggle.isOpen(), false)
  toggle.set(true)
  assert.equal(toggle.isOpen(), true)
  assert.equal(calls, 1)
  toggle.set(true)
  assert.equal(calls, 1, 'повторная установка того же значения будит подписчиков')
  toggle.toggle()
  assert.equal(toggle.isOpen(), false)
  assert.equal(calls, 2)
  off()
  toggle.set(true)
  assert.equal(calls, 2, 'отписка не сработала')
})

test('когда ни одного слота нет, регистрация не роняет плагин', () => {
  const { ctx, registered } = stubCtx({ available: [] })
  assert.doesNotThrow(() => exported.apply(ctx))
  assert.equal(registered.length, 0)
})

test('поиск ищет по заголовку, репозиторию, номеру и меткам', () => {
  const task = { title: 'Дробный индекс', repo: 'dsh-kanban', issueNumber: 12, labels: ['feat', 'p2'] }
  assert.equal(h.matchesQuery(task, 'дробн'), true)
  assert.equal(h.matchesQuery(task, 'KANBAN'), true, 'поиск обязан быть регистронезависимым')
  assert.equal(h.matchesQuery(task, '#12'), true)
  assert.equal(h.matchesQuery(task, 'feat'), true)
  assert.equal(h.matchesQuery(task, 'чего-то нет'), false)
})

test('пустой поиск пропускает всё, включая пробелы', () => {
  const task = { title: 'A' }
  assert.equal(h.matchesQuery(task, ''), true)
  assert.equal(h.matchesQuery(task, '   '), true)
  assert.equal(h.matchesQuery(task, undefined), true)
})

test('поиск переживает задачу без полей', () => {
  assert.equal(h.matchesQuery({}, 'что-нибудь'), false)
  assert.equal(h.matchesQuery({}, ''), true)
})

test('владелец и репозиторий разбираются из полного имени', () => {
  // Владельца отдельным полем не спрашиваем: он следует из выбора.
  assert.deepEqual({ ...h.splitFullName('goodandready/dsh-kanban') },
    { owner: 'goodandready', repo: 'dsh-kanban' })
})

test('негодное полное имя не даёт пары, а не половину', () => {
  assert.equal(h.splitFullName('dsh-kanban'), undefined)
  assert.equal(h.splitFullName('/dsh-kanban'), undefined)
  assert.equal(h.splitFullName('goodandready/'), undefined)
  assert.equal(h.splitFullName('a/b/c'), undefined)
  assert.equal(h.splitFullName(''), undefined)
  assert.equal(h.splitFullName(undefined), undefined)
})

test('подпись репозитория показывает число открытых задач', () => {
  const t = (k) => ({ 'dialog.archived': 'архив' })[k] ?? k
  assert.equal(h.repoOption({ fullName: 'o/r', openIssues: 4 }, t), 'o/r · 4')
  assert.equal(h.repoOption({ fullName: 'o/r', openIssues: 0 }, t), 'o/r')
  assert.equal(h.repoOption({ fullName: 'o/r', openIssues: 2, archived: true }, t), 'o/r · 2 · архив')
})

test('подпись собирается и без полного имени', () => {
  const t = (k) => k
  assert.equal(h.repoOption({ owner: 'o', repo: 'r' }, t), 'o/r')
})

test('открытие чата: без службы сессий честно возвращает отказ', () => {
  // Служба берётся через get, а не через inject: её отсутствие не должно
  // мешать доске загрузиться, но человеку об этом надо сказать.
  assert.equal(h.openSession({ get: () => undefined }, 'kanban-1'), false)
  assert.equal(h.openSession({}, 'kanban-1'), false)
  assert.equal(h.openSession(undefined, 'kanban-1'), false)
})

test('открытие чата: без идентификатора сессии не зовёт службу', () => {
  let called = false
  const ctx = { get: () => ({ open: () => { called = true } }) }
  assert.equal(h.openSession(ctx, ''), false)
  assert.equal(h.openSession(ctx, undefined), false)
  assert.equal(called, false)
})

test('открытие чата: служба зовётся с идентификатором сессии', () => {
  const seen = []
  const ctx = { get: (name) => (name === 'sessions' ? { open: (id) => seen.push(id) } : undefined) }
  assert.equal(h.openSession(ctx, 'kanban-42'), true)
  assert.deepEqual(seen, ['kanban-42'])
})

test('открытие чата: падение службы не роняет доску', () => {
  const ctx = { get: () => ({ open: () => { throw new Error('нет такой сессии') } }) }
  assert.equal(h.openSession(ctx, 'kanban-1'), false)
})

test('кнопка возврата подписана на обоих языках', () => {
  // Разметку шапки заглушка React не разворачивает: состояние доски приходит
  // из сети, и до неё компонент возвращает заглушку загрузки. Проверяем то,
  // что проверяемо без браузера, — что подписи не забыты ни в одном словаре.
  const { src } = loadClient()
  for (const key of ['board.back', 'board.backHint']) {
    const found = src.split(`'${key}':`).length - 1
    assert.equal(found, 2, `у ${key} не два перевода, а ${found}`)
  }
})

test('кнопка возврата зовёт onClose, а не свой способ закрытия', () => {
  // Способов закрытия уже три, и четвёртый разошёлся бы с ними при первой же
  // правке. Здесь сверяем именно это намерение.
  const { src } = loadClient()
  const bar = src.slice(src.indexOf("className: 'dkb-bar'"), src.indexOf("dkb-barTitle'"))
  assert.ok(bar.includes('props.onClose'), 'кнопка закрывает доску в обход общего пути')
})

test('проект и номер задачи разделены', () => {
  // Слипшиеся, они читаются как один непонятный идентификатор, а это две
  // разные вещи: имя проекта — принадлежность, номер — адрес.
  const h = loadClient().exported.helpers
  const out = h.taskRef({ repo: 'memory-brain', issueNumber: 1368, issueUrl: 'https://gitea/x' })
  const kids = Array.from(out.children ?? [])
  assert.equal(kids.length, 2, 'ожидались отдельные имя и номер')
  assert.equal(kids[0].props.className, 'dkb-refRepo')
  assert.equal(kids[0].children[0], 'memory-brain')
  assert.match(kids[1].props.className, /dkb-refNum/)
  assert.equal(kids[1].children[0], '#1368')
})

test('номер ведёт на issue и не открывает карточку', () => {
  const h = loadClient().exported.helpers
  const num = Array.from(h.taskRef({ repo: 'r', issueNumber: 7, issueUrl: 'https://gitea/7' }).children)[1]
  assert.equal(num.type, 'a')
  assert.equal(num.props.href, 'https://gitea/7')
  assert.equal(typeof num.props.onClick, 'function', 'щелчок обязан гаситься, иначе откроется карточка')
})

test('небезопасный адрес ссылкой не становится', () => {
  const h = loadClient().exported.helpers
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/относительный', '']) {
    const num = Array.from(h.taskRef({ repo: 'r', issueNumber: 7, issueUrl: bad }).children)[1]
    assert.equal(num.type, 'span', String(bad))
  }
})

test('задача без issue номера не показывает', () => {
  const h = loadClient().exported.helpers
  const kids = Array.from(h.taskRef({ repo: 'r' }).children).filter(Boolean)
  assert.equal(kids.length, 1)
  assert.equal(h.taskRef({}), null)
  assert.equal(h.taskRef(undefined), null)
})

test('подписи управления в шапке — с прописной буквы', () => {
  // Смешение прописных и строчных в одном ряду выглядит халтурой. Правило:
  // подпись кнопки — имя, значит с прописной; встроенный текст — часть фразы,
  // значит со строчной.
  const { src } = loadClient()
  const controls = [
    'board.back', 'board.archive', 'board.search', 'board.sync', 'board.refresh',
    'board.newTask', 'board.clearFilters',
    'facet.repo', 'facet.type', 'facet.priority', 'facet.status',
    'boardName.main', 'boardName.simple',
  ]
  const wrong = []
  for (const key of controls) {
    for (const m of src.matchAll(new RegExp("'" + key + "': '([^']*)'", 'g'))) {
      const value = m[1]
      if (value !== '' && value[0] !== value[0].toUpperCase()) wrong.push(key + ' = ' + value)
    }
  }
  assert.deepEqual(wrong, [], 'подпись управления со строчной: ' + wrong.join(', '))
})

test('известные пространства меток переводятся, незнакомые остаются как есть', () => {
  // Подставлять свой перевод пространству, заведённому вчера, доска не вправе.
  const h = loadClient().exported.helpers
  const t = (k) => (k === 'facet.type' ? 'Тип' : k)
  assert.equal(h.facetLabel('type', t), 'Тип')
  assert.equal(h.facetLabel('выдумка', t), 'выдумка')
})

test('названия наших досок переводятся, переименованные не трогаются', () => {
  const h = loadClient().exported.helpers
  const t = (k) => (k === 'boardName.main' ? 'Проектная доска' : k)
  assert.equal(h.boardTitle({ id: 'main', title: 'из базы' }, t), 'Проектная доска')
  assert.equal(h.boardTitle({ id: 'своя', title: 'Моя доска' }, t), 'Моя доска')
  assert.equal(h.boardTitle(undefined, t), '')
})

test('каждое известное пространство меток имеет обе подписи', () => {
  const { src } = loadClient()
  for (const ns of ['repo', 'type', 'priority', 'status', 'scope', 'risk', 'signal', 'release']) {
    const found = src.split(`'facet.${ns}':`).length - 1
    assert.equal(found, 2, `у facet.${ns} не два перевода, а ${found}`)
  }
})

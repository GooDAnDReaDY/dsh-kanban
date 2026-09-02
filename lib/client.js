// Браузерная половина dsh-kanban: экран доски и карточка настроек.
//
// Идентификатор ниже обязан совпадать с `name` в package.json и с `name:` в
// cordis.patch.yml. Расхождение НЕ даёт ошибки в журнале: загрузчик молча не
// разрешает пакет, серверная половина работает, интерфейса нет.
//
// Модуль грузится загрузчиком и импортировать файлы репозитория не может,
// поэтому чистые помощники живут здесь же и выставляются наружу как `helpers`
// — тесты поднимают этот файл через node:vm и проверяют их без браузера.
window.__ModuleLoader__.load({
  id: '@goodandready/dsh-kanban',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const ReactDOM = require('react-dom/client')

    const NS = 'dsh-kanban'
    const COLUMN_ORDER = ['backlog', 'in-progress', 'review', 'deploy', 'cleanup', 'done']

    // ---------------------------------------------------------- чистая часть

    /**
     * Соседи для переноса карточки. Хранилище работает не с числовым индексом,
     * а с парой соседей: `afterId` — карточка выше, `beforeId` — ниже.
     */
    function neighboursFor(columnTasks, dragId, index) {
      const rest = (columnTasks || []).filter((t) => t.id !== dragId)
      const clamped = Math.max(0, Math.min(index, rest.length))
      return {
        afterId: clamped > 0 ? rest[clamped - 1].id : undefined,
        beforeId: clamped < rest.length ? rest[clamped].id : undefined,
      }
    }

    function tasksOf(tasks, column) {
      return (tasks || []).filter((t) => t.column === column)
    }

    /**
     * Порядок задач внутри колонки.
     *
     * `manual` — как прислал сервер: ручной порядок плюс живое вперёд.
     * `old`/`new` сортируют по дате заведения, но НЕ ломают ни группировку по
     * проектам, ни «живое вперёд»: карточки переставляются внутри своего
     * проекта, а идущая работа остаётся наверху группы. Иначе заголовки
     * проектов пришлось бы рисовать над каждой карточкой.
     */
    function sortTasks(tasks, order) {
      const list = tasks || []
      if (order !== 'old' && order !== 'new') return list
      const sign = order === 'old' ? 1 : -1
      const groups = []
      const at = new Map()
      for (const task of list) {
        const key = task.repo || ''
        if (!at.has(key)) { at.set(key, groups.length); groups.push([]) }
        groups[at.get(key)].push(task)
      }
      const alive = (task) => (task.state === 'running' || task.state === 'waiting' || task.state === 'queued' ? 0 : 1)
      const out = []
      for (const group of groups) {
        out.push(...group.slice().sort((a, b) => alive(a) - alive(b)
          || sign * ((a.createdAt || 0) - (b.createdAt || 0))))
      }
      return out
    }

    /**
     * Карточки одной сессии: номер и общее число.
     *
     * Пять карточек, запущенных пачкой, выглядят несвязанными, и очередь
     * понятна только тому, кто её запускал, и только пока помнит. Порядок тот
     * же, в каком агент их берёт: идущая первой, дальше по времени постановки.
     *
     * @returns {Object<string, {at: number, total: number}>} по идентификатору задачи
     */
    /**
     * Применить одно действие ко всем отмеченным.
     *
     * Отдельного группового маршрута не заводим: это те же действия, что для
     * одной задачи. Отказ части не срывает остальные — задачи независимы, — но
     * и не съедается молча: итог называется числом, иначе человек останется
     * уверен, что в архиве десять карточек, а их там семь.
     *
     * @returns {Promise<{done: number, failed: number}>}
     */
    async function applyToEach(ids, act) {
      let done = 0
      let failed = 0
      for (const id of ids || []) {
        try { await act(id); done += 1 } catch { failed += 1 }
      }
      return { done, failed }
    }

    /**
     * Чем запускали в прошлый раз, на эту доску.
     *
     * Живёт у человека в браузере, а не в настройках плагина: это привычка
     * одного, а не свойство доски. Хранилище может быть недоступно (закрытое
     * окно, запрет на данные сайта) — тогда просто нечего вспомнить, и окно
     * запуска обязано открыться как обычно.
     */
    const RECALL_KEY = 'dsh-kanban:launch:'

    function recallLaunch(board) {
      try {
        const raw = window.localStorage.getItem(RECALL_KEY + (board || 'main'))
        const saved = raw ? JSON.parse(raw) : null
        return saved && typeof saved === 'object' ? saved : {}
      } catch { return {} }
    }

    function rememberLaunch(board, choice) {
      try {
        window.localStorage.setItem(RECALL_KEY + (board || 'main'), JSON.stringify(choice))
      } catch { /* нечем запомнить — не повод ломать запуск */ }
    }

    /**
     * Подставить запомненное, но только то, что ядро всё ещё предлагает.
     *
     * Исчезнувший из сборки уровень доступа или профиль подставлять нельзя:
     * задача пошла бы не с теми правами или не собралась бы вовсе. Тогда
     * возвращаемся к тому, что предлагает харнесс.
     *
     * @param {Array<string>} known допустимые значения
     */
    function stillOffered(value, known, fallback) {
      return typeof value === 'string' && (known || []).indexOf(value) >= 0 ? value : fallback
    }

    function packInfo(tasks) {
      const bySession = new Map()
      for (const task of tasks || []) {
        const id = task && typeof task.sessionId === 'string' ? task.sessionId : ''
        if (id === '') continue
        if (!bySession.has(id)) bySession.set(id, [])
        bySession.get(id).push(task)
      }
      const out = {}
      for (const group of bySession.values()) {
        // Одна задача в сессии — не пачка: отметка «1 из 1» ничего не сообщает.
        if (group.length < 2) continue
        const order = group.slice().sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0))
        order.forEach((task, at) => { out[task.id] = { at: at + 1, total: order.length } })
      }
      return out
    }

    /**
     * Разложить колонку по ответственным.
     *
     * Группа «никто» идёт первой: свободные задачи — то, ради чего в эту
     * раскладку и заглядывают. Дальше по алфавиту, чтобы порядок не плясал от
     * того, кто первым попался в списке.
     *
     * @returns {Array<{who: string, tasks: object[]}>}
     */
    function groupByAssignee(tasks) {
      const by = new Map()
      for (const task of tasks || []) {
        const who = typeof task.assignee === 'string' && task.assignee !== '' ? task.assignee : ''
        if (!by.has(who)) by.set(who, [])
        by.get(who).push(task)
      }
      return [...by.entries()]
        .sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])))
        .map(([who, list]) => ({ who, tasks: list }))
    }

    function cardRef(task) {
      if (!task || !task.repo) return ''
      if (typeof task.issueNumber !== 'number') return task.repo
      return task.repo + '#' + task.issueNumber
    }

    /**
     * Проект и номер задачи РАЗДЕЛЬНО.
     *
     * Слипшиеся, они читаются как один непонятный идентификатор, а это две
     * разные вещи: имя проекта — принадлежность, номер — адрес.
     *
     * Номер становится ссылкой на issue: чаще всего она нужна именно с
     * карточки, а раньше пряталась в окне задачи.
     */
    function taskRef(task, t) {
      if (!task || !task.repo) return null
      const number = typeof task.issueNumber === 'number' ? '#' + task.issueNumber : ''
      const href = typeof task.issueUrl === 'string' && /^https?:\/\//i.test(task.issueUrl)
        ? task.issueUrl
        : ''
      return React.createElement('span', { className: 'dkb-ref' },
        React.createElement('span', { className: 'dkb-refRepo', title: task.repo }, task.repo),
        number === ''
          ? null
          : href === ''
            ? React.createElement('span', { className: 'dkb-refNum' }, number)
            : React.createElement('a', {
              className: 'dkb-refNum dkb-refLink', href, target: '_blank', rel: 'noreferrer noopener',
              title: t ? t('panel.issue') : undefined,
              // Щелчок по номеру — «открыть issue», а не «открыть карточку».
              // Два разных намерения, и путать их нельзя.
              onClick: (e) => e.stopPropagation(),
            }, number),
      )
    }

    function cardStatus(task) {
      const parts = []
      if (task && typeof task.model === 'string' && task.model !== '') parts.push(task.model)
      if (task && typeof task.branch === 'string' && task.branch !== '') parts.push(task.branch)
      return parts.join(' · ')
    }

    /**
     * Короткая строка плана для карточки: «3 из 7 · пишу тесты».
     *
     * План из одного пункта и план из двадцати выглядят одинаково, потому что
     * на карточку едут только числа и текущий пункт; сам список остаётся в
     * окне задачи.
     */
    function planLine(task, t) {
      const progress = task && task.plan && task.plan.progress
      if (!progress || !progress.total) return ''
      // На идущем пункте показываем ЕГО номер, а не число сделанных: «3 из 7 ·
      // пишу тесты» читается как «идёт третий», и так оно и есть. Когда
      // текущего пункта нет — план не начат или закончен, — показываем сделанные.
      const shown = progress.text ? progress.current : progress.done
      const counter = t('plan.counter', { done: shown, total: progress.total })
      return progress.text ? counter + ' · ' + progress.text : counter
    }

    /**
     * Подпись состояния. Ожидание рисуется отдельной точкой и здесь молчит,
     * иначе одно и то же сказано дважды.
     */
    function stateLabel(task, t) {
      const state = task && task.state
      if (state === 'running') return t('state.running')
      if (state === 'stopped') return t('state.stopped')
      return ''
    }

    /**
     * Свёрнута ли колонка.
     *
     * Пустая сжимается сама: шесть колонок по 220 пикселей не помещаются на
     * ноутбуке. Ручное решение человека сильнее автоматики в обе стороны —
     * иначе развёрнутая пустая колонка схлопывалась бы у него на глазах.
     *
     * @param {object} column колонка из ответа доски
     * @param {object} manual карта id -> явное решение человека
     */
    function isCollapsed(column, manual) {
      const own = manual && manual[column.id]
      if (own === true || own === false) return own
      return (column.count || 0) === 0
    }

    /**
     * Относительное время одной строкой: «5 мин», «3 ч», «3 дня».
     *
     * Разбор на единицу и число делает сервер незачем — правило простое и без
     * настроек, а лишний круг данных дороже пяти строк здесь. Абсолютную дату
     * отдаём подсказкой при наведении: точная дата требует чтения и сравнения
     * с сегодняшним числом, а на доску смотрят ради скорости.
     */
    function agoText(now, then, t) {
      if (typeof then !== 'number' || then <= 0) return ''
      const delta = Math.max(0, now - then)
      const min = Math.floor(delta / 60000)
      if (min < 1) return t('time.now')
      if (min < 60) return t('time.min', { n: min })
      const hours = Math.floor(min / 60)
      if (hours < 24) return t('time.hour', { n: hours })
      return t('time.day', { n: Math.floor(hours / 24) })
    }

    /** Дата без времени: «26 авг». Год добавляем, только когда он не нынешний. */
    function shortDate(then) {
      if (typeof then !== 'number' || then <= 0) return ''
      try {
        const d = new Date(then)
        const sameYear = d.getFullYear() === new Date().getFullYear()
        return d.toLocaleDateString(undefined, sameYear
          ? { day: 'numeric', month: 'short' }
          : { day: 'numeric', month: 'short', year: 'numeric' })
      } catch { return '' }
    }

    /** Абсолютная дата для подсказки. Нечитаемая отметка — пустая подсказка. */
    function exactAt(then) {
      if (typeof then !== 'number' || then <= 0) return ''
      try { return new Date(then).toLocaleString() } catch { return '' }
    }

    /**
     * Что сказать о сверке.
     *
     * Доска, переставшая обновляться, не имеет права молчать: отличить
     * «ничего не изменилось» от «мы ослепли» иначе нечем.
     *
     * @returns {{tone: 'ok'|'bad'|'idle', text: string, title: string}}
     */
    function syncLine(sync, now, t) {
      const state = (sync && sync.state) || 'never'
      if (state === 'running') return { tone: 'idle', text: t('sync.running'), title: '' }
      if (state === 'never') return { tone: 'idle', text: t('sync.never'), title: '' }

      if (state === 'failed') {
        const where = (sync.problem && sync.problem.where) || ''
        const why = (sync.problem && sync.problem.message) || ''
        // Время ПОСЛЕДНЕГО УСПЕХА, а не последней попытки: вопрос человека —
        // когда доска в последний раз видела правду.
        const seen = sync.okAt
          ? t('sync.lastSeen', { ago: agoText(now, sync.okAt, t) })
          : t('sync.neverSeen')
        return {
          tone: 'bad',
          text: t('sync.failed'),
          title: [where, why, seen].filter(Boolean).join(' · '),
        }
      }
      return {
        tone: 'ok',
        text: t('sync.okAgo', { ago: agoText(now, sync.okAt, t) }),
        title: exactAt(sync.okAt),
      }
    }

    /**
     * Каким цветом писать поверх фона метки.
     *
     * Считаем воспринимаемую яркость и выбираем чёрный либо белый — так же
     * делает сам Gitea. Без этого `priority/low` на светло-зелёном становится
     * нечитаемой, а `type/security` на тёмно-красном сливается.
     *
     * @param {string} hex шесть шестнадцатеричных цифр без решётки
     */
    function readableOn(hex) {
      const n = parseInt(String(hex || ''), 16)
      if (!isFinite(n)) return ''
      const r = (n >> 16) & 255
      const g = (n >> 8) & 255
      const b = n & 255
      // Коэффициенты воспринимаемой яркости: глаз чувствительнее к зелёному.
      return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#111' : '#fff'
    }

    /**
     * Цвет полосы срочности слева на карточке.
     *
     * Только `priority`: полоса одна, и отдавать её первой попавшейся метке
     * нельзя. Задача без срочности остаётся без полосы, а не получает серую —
     * пустая полоса читалась бы как «низкий приоритет», а это неправда.
     */
    function priorityColor(task) {
      const values = (task && task.facets && task.facets.priority) || []
      for (const value of values) {
        const hex = task.labelColors && task.labelColors['priority/' + value]
        if (hex) return '#' + hex
      }
      return ''
    }

    /** Стиль метки. Без цвета — прежний нейтральный вид, а не чёрный прямоугольник. */
    function tagStyle(task, name) {
      const hex = task && task.labelColors ? task.labelColors[name] : undefined
      if (!hex) return undefined
      return { background: '#' + hex, color: readableOn(hex), borderColor: 'transparent' }
    }

    /**
     * Отрисовать разобранное тело задачи.
     *
     * Собираем ЭЛЕМЕНТАМИ, а не строкой HTML. Тело пишет кто угодно, и
     * `dangerouslySetInnerHTML` здесь означал бы выполнение чужого кода в
     * интерфейсе владельца. При сборке элементами подстановка невозможна по
     * построению — не потому, что кто-то не забыл про экранирование.
     */
    function renderSpans(spans, keyBase) {
      return (spans || []).map((span, i) => {
        const key = keyBase + '-' + i
        if (span.kind === 'code') return React.createElement('code', { className: 'dkb-code', key }, span.text)
        if (span.kind === 'strong') return React.createElement('strong', { key }, span.text)
        if (span.kind === 'em') return React.createElement('em', { key }, span.text)
        if (span.kind === 'link') {
          return React.createElement('a', {
            key, href: span.href, target: '_blank', rel: 'noreferrer noopener',
          }, span.text)
        }
        return span.text
      })
    }

    function renderBlocks(blocks) {
      return (blocks || []).map((block, i) => {
        const key = 'b' + i
        if (block.kind === 'heading') {
          // Заголовки тела не спорят с заголовком окна: рисуем их своим
          // классом, а не h1..h6, у которых свой размер в оболочке.
          return React.createElement('div', {
            key, className: 'dkb-mdHead dkb-mdHead' + Math.min(block.level, 3),
          }, renderSpans(block.spans, key))
        }
        if (block.kind === 'code') {
          return React.createElement('pre', { key, className: 'dkb-mdCode' }, block.text)
        }
        if (block.kind === 'rule') return React.createElement('hr', { key, className: 'dkb-mdRule' })
        if (block.kind === 'quote') {
          return React.createElement('blockquote', { key, className: 'dkb-mdQuote' },
            renderSpans(block.spans, key))
        }
        if (block.kind === 'list') {
          return React.createElement(block.ordered ? 'ol' : 'ul', { key, className: 'dkb-mdList' },
            (block.items || []).map((item, j) => React.createElement('li', { key: key + '-' + j },
              renderSpans(item, key + '-' + j))))
        }
        return React.createElement('p', { key, className: 'dkb-mdPara' }, renderSpans(block.spans, key))
      })
    }

    /**
     * Подпись пространства меток.
     *
     * Ключа нет — показываем имя как есть. Это не пропуск, а решение: набор
     * меток в Gitea меняют без нас, и подставлять свой перевод новому
     * пространству значило бы врать о том, чего мы не знаем.
     */
    /**
     * Название колонки: своё, если задано в настройках, иначе переведённое.
     *
     * Настройка одна на все колонки — парами `идентификатор=Название` через
     * запятую. Шесть отдельных полей ради переименования, которое делают раз в
     * жизни, засорили бы карточку настроек сильнее, чем помогли.
     */
    function columnTitle(col, t) {
      const own = col && col.name
      return own !== undefined && own !== '' ? own : t('column.' + (col && col.id))
    }

    function facetLabel(ns, t) {
      const key = 'facet.' + ns
      const text = t(key)
      return text === key ? ns : text
    }

    /**
     * Название доски.
     *
     * Заведённые нами `main` и `simple` переводим по идентификатору: их
     * названия лежат в базе на одном языке и на другом интерфейсе остались бы
     * чужими. Переименованную человеком доску не трогаем — это его слово.
     */
    function boardTitle(board, t) {
      const key = 'boardName.' + (board && board.id)
      const text = t(key)
      return text === key ? (board && board.title) || '' : text
    }

    function normalizeBoard(payload) {
      const columns = payload && Array.isArray(payload.columns) && payload.columns.length > 0
        ? payload.columns
        : COLUMN_ORDER.map((id) => ({ id, count: 0, limit: undefined, overLimit: false }))
      return {
        board: (payload && payload.board) || 'main',
        kind: (payload && payload.kind) || 'project',
        // Своё «сейчас» на случай ответа без него: часы браузера и сервера
        // расходятся, и лучше считать по одному из них, чем по нулю.
        now: (payload && typeof payload.now === 'number') ? payload.now : Date.now(),
        boards: payload && Array.isArray(payload.boards) ? payload.boards : [],
        facets: payload && Array.isArray(payload.facets) ? payload.facets : [],
        sync: (payload && payload.sync) || { state: 'never' },
        columns,
        tasks: payload && Array.isArray(payload.tasks) ? payload.tasks : [],
        // Фактический корень проектов: {path, set} — путь и признак «задан
        // настройкой». Сервер знает и настройку, и рабочую папку харнесса,
        // браузеру ни то ни другое не доступно.
        projectRoot: payload && typeof payload.projectRoot === 'object' && payload.projectRoot !== null
          ? { path: String(payload.projectRoot.path || ''), set: payload.projectRoot.set === true }
          : { path: '', set: false },
      }
    }

    /** Отбор по репозиторию стоит в одном ряду с метками; имя должно совпадать с сервером. */
    const REPO_FACET = 'repo'

    /**
     * Подходит ли задача под выбранное.
     *
     * Между пространствами — И, внутри пространства — ИЛИ: срочность у задачи
     * одна, и «И» внутри пространства всегда давало бы пусто.
     *
     * Метки уже разобраны сервером и приезжают в `task.facets`. Разбирать их
     * здесь во второй раз значило бы завести вторую правду о том, где кончается
     * пространство и начинается значение.
     */
    function matchesFilters(task, selected) {
      const keys = Object.keys(selected || {})
      for (const ns of keys) {
        const wanted = selected[ns] || []
        if (wanted.length === 0) continue
        const have = ns === REPO_FACET
          ? [task && task.repo ? task.repo : '']
          : ((task && task.facets && task.facets[ns]) || [])
        if (!have.some((v) => wanted.indexOf(v) >= 0)) return false
      }
      return true
    }

    /** Выбрано ли что-нибудь: пустой набор доску не сужает. */
    function anySelected(selected) {
      const keys = Object.keys(selected || {})
      for (const ns of keys) if ((selected[ns] || []).length > 0) return true
      return false
    }

    /** Переключить значение. Новая карта, а не правка на месте: иначе React не перерисует. */
    function toggleValue(selected, ns, value) {
      const current = (selected || {})[ns] || []
      const next = current.indexOf(value) >= 0
        ? current.filter((v) => v !== value)
        : current.concat([value])
      const out = Object.assign({}, selected || {})
      if (next.length === 0) delete out[ns]
      else out[ns] = next
      return out
    }

    /**
     * Человеческая причина отказа. Пустой список без объяснения читается как
     * «issue нет», и человек идёт искать несуществующую проблему.
     */
    function errorKey(error) {
      switch (error) {
        case 'gitea-absent': return 'error.giteaAbsent'
        case 'gitea-unconfigured': return 'error.giteaUnconfigured'
        case 'task-not-found': return 'error.taskNotFound'
        case 'task-has-no-issue': return 'error.taskHasNoIssue'
        case 'issue-not-found': return 'error.issueNotFound'
        case 'title-required': return 'error.titleRequired'
        case 'cross-site': return 'error.crossSite'
        case 'model-not-selected': return 'error.modelNotSelected'
        case 'start-failed': return 'error.startFailed'
        default: return 'error.unknown'
      }
    }

    /**
     * Открыть чат поднятой сессии.
     *
     * Служба сессий берётся через `get`, а не объявляется в `inject`: если её в
     * сборке не окажется, доска обязана сказать об этом человеку, а не
     * отказаться загружаться целиком.
     *
     * @returns {boolean} удалось ли открыть
     */
    function openSession(ctx, sessionId) {
      if (!sessionId) return false
      const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      if (!sessions || typeof sessions.open !== 'function') return false
      try {
        sessions.open(sessionId)
        return true
      } catch {
        return false
      }
    }

    /**
     * Подпись репозитория в списке: имя и сколько в нём открытых задач.
     * Архивный помечается словом, а не только положением в списке.
     */
    function repoOption(r, t) {
      const full = r.fullName || ((r.owner || '') + '/' + (r.repo || ''))
      const parts = [full]
      if ((r.openIssues || 0) > 0) parts.push('· ' + r.openIssues)
      if (r.archived) parts.push('· ' + t('dialog.archived'))
      return parts.join(' ')
    }

    /**
     * Разобрать `владелец/репозиторий` в пару.
     *
     * Владельца отдельным полем не спрашиваем: он однозначно следует из
     * выбранного репозитория, а лишнее поле — лишний способ ошибиться.
     */
    function splitFullName(fullName) {
      const parts = String(fullName || '').split('/')
      if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return undefined
      return { owner: parts[0], repo: parts[1] }
    }

    /**
     * Отбор карточек по строке поиска: заголовок, репозиторий, номер issue.
     *
     * Фильтр держится на стороне браузера намеренно: доска и так вся в памяти,
     * а поход на сервер за каждой буквой сделал бы набор дёрганым.
     */
    function matchesQuery(task, query) {
      const needle = String(query || '').trim().toLowerCase()
      if (needle === '') return true
      const hay = [
        task && task.title,
        task && task.repo,
        task && typeof task.issueNumber === 'number' ? '#' + task.issueNumber : '',
        task && Array.isArray(task.labels) ? task.labels.join(' ') : '',
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.indexOf(needle) >= 0
    }

    /**
     * Идентификатор сессии для чипа. Ядро отдаёт его либо свойством, либо
     * через useSession — берём первое, что есть.
     */
    function chipSessionId(props, session) {
      return String((props && props.sessionId) || (session && (session.sessionId || session.id)) || '').trim()
    }

    const helpers = {
      neighboursFor, tasksOf, sortTasks, packInfo, groupByAssignee, applyToEach, recallLaunch, rememberLaunch, stillOffered,
      cardRef, taskRef, cardStatus, facetLabel, boardTitle,
      columnTitle, planLine, stateLabel, isCollapsed,
      agoText, exactAt, shortDate, syncLine, readableOn, tagStyle, priorityColor, renderBlocks, renderSpans, matchesFilters, anySelected, toggleValue, normalizeBoard, errorKey,
      chipSessionId, matchesQuery, splitFullName, repoOption, openSession, COLUMN_ORDER,
      // createToggle подставляется ниже, когда объявлен: он нужен тестам, а
      // объявление живёт рядом со встраиванием в оболочку.
    }

    // ------------------------------------------------------------------ сеть

    async function api(path, options) {
      const res = await fetch('/dsh-kanban' + path, Object.assign({
        headers: { 'Content-Type': 'application/json' },
      }, options))
      let payload = null
      try { payload = await res.json() } catch { payload = null }
      if (!res.ok) {
        const err = new Error((payload && payload.error) || 'request-failed')
        err.key = errorKey(payload && payload.error)
        throw err
      }
      return payload
    }

    // ----------------------------------------------------------------- стили

    const css =
      '.dkb-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none}' +
      '.dkb-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}' +
      '.dkb-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}' +
      '.dkb-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}' +
      '.dkb-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
      '.dkb-sub{color:var(--dsw-alias-label-secondary);font-size:13px}' +
      '.dkb-chevron{color:var(--dsw-alias-label-secondary);flex:none;transition:transform .16s}' +
      '.dkb-chevronOpen{transform:rotate(180deg)}' +
      '.dkb-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}' +
      '.dkb-group{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:14px 0 2px}' +
      '.dkb-field{display:flex;flex-direction:column;gap:6px;padding:10px 0}' +
      '.dkb-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}' +
      '.dkb-hint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.5}' +
      '.dkb-input{height:34px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;box-sizing:border-box;width:100%}' +
      '.dkb-area{min-height:96px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:13px;box-sizing:border-box;width:100%;resize:vertical;font:inherit}' +
      '.dkb-input:disabled,.dkb-area:disabled{opacity:.55}' +
      '.dkb-foot{border-top:1px solid var(--dsw-alias-border-l2);display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px}' +
      '.dkb-footSplit{justify-content:space-between}' +
      '.dkb-footLeft{display:flex;align-items:center;gap:8px}' +
      '.dkb-note{min-width:0;flex:1;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}' +
      '.dkb-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}' +
      '.dkb-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}' +
      '.dkb-discard{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;color:var(--dsw-alias-label-secondary);background:transparent}' +
      '.dkb-discard:disabled,.dkb-save:disabled{opacity:.4;cursor:default}' +
      // Строка в боковой панели. Метрики и переменные взяты у оболочки, чтобы
      // строка не выделялась среди родных: та же высота, те же состояния.
      // Кнопка — клон родной, поэтому вид берётся у оболочки. Своего здесь
      // ровно столько, чтобы разложить значок и подпись внутри клона.
      '.dkb-entry-clone{align-items:center;gap:8px;display:flex}' +
      '.dkb-entry-clone[data-active]{font-weight:600}' +
      '.dkb-entryIcon{flex:none;justify-content:center;align-items:center;display:inline-flex}' +
      '.dkb-entryLabel{text-overflow:ellipsis;overflow:hidden}' +
      '[data-dsh-frame][data-sidebar-collapsed] .dkb-entryLabel{display:none}' +
      // Экран поверх колонки разговора. Показывается атрибутом на <html>, а
      // соседи колонки прячутся — иначе доска легла бы поверх живого чата.
      '[data-pane=conversation],[class*=centerCol]{position:relative}' +
      '[data-dsh-kanban-view]{z-index:60;background:var(--dsw-alias-bg-base);display:none;position:absolute;inset:0}' +
      'html[data-dsh-kanban-active]:not([data-dsh-ssh-active]) [data-dsh-kanban-view]{display:block}' +
      'html[data-dsh-kanban-active]:not([data-dsh-ssh-active]) [data-pane=conversation]>:not([data-dsh-kanban-view]),' +
      'html[data-dsh-kanban-active]:not([data-dsh-ssh-active]) [class*=centerCol]>:not([data-dsh-kanban-view]){display:none!important}' +
      // Сама доска
      '.dkb-screen{box-sizing:border-box;background:var(--dsw-alias-bg-base);min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);flex-direction:column;gap:12px;padding:14px 16px 56px;display:flex}' +
      '.dkb-bar{flex:none;align-items:center;gap:8px;display:flex;flex-wrap:wrap}' +
      // Всё управление в шапке одной высоты: пять разных высот подряд читаются
      // как ряд, собранный из чужих деталей.
      '.dkb-bar .dkb-input,.dkb-bar .dkb-search,.dkb-bar .dkb-save,.dkb-bar .dkb-discard,.dkb-bar .dkb-facetHead,.dkb-bar .dkb-back{height:30px;box-sizing:border-box;padding-top:0;padding-bottom:0;border-radius:8px;font-size:13px;line-height:28px;display:inline-flex;align-items:center}' +
      '.dkb-bar .dkb-facet{display:inline-flex}' +
      '.dkb-back{appearance:none;font:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;align-items:center;gap:6px;padding:4px 10px;font-size:13px;display:flex;flex:none}' +
      '.dkb-back:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dkb-backIcon{align-items:center;display:flex}' +
      '.dkb-archive{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px}' +
      '.dkb-archiveList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}' +
      '.dkb-archiveRow{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;align-items:center;gap:12px;padding:8px 12px;display:flex}' +
      '.dkb-start{display:contents}' +
      '.dkb-pack{color:var(--dsw-alias-label-secondary)}' +
      '.dkb-who{color:var(--dsw-alias-label-secondary)}' +
      '.dkb-sameSession{outline:1px solid var(--dsw-alias-label-secondary);outline-offset:1px}' +
      '.dkb-waitCount{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:0 10px;height:30px;cursor:pointer;color:var(--dsw-alias-label-primary)}' +
      '.dkb-archiveOpen{background:none;border:0;padding:0;text-align:left;cursor:pointer;font:inherit}' +
      '.dkb-archiveTitle{flex:1;font-size:13px;color:var(--dsw-alias-label-primary)}' +
      '.dkb-urgent{border-left-width:3px;border-left-style:solid;padding-left:9px}' +
      '.dkb-cardMenu{position:relative;align-self:flex-start;opacity:0;transition:opacity .12s}' +
      '.dkb-taskCard:hover .dkb-cardMenu,.dkb-taskCard:focus-within .dkb-cardMenu,.dkb-taskCard:focus-visible .dkb-cardMenu{opacity:1}' +
      '.dkb-groupHead{appearance:none;width:100%;font:inherit;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:0;border-top:1px solid var(--dsw-alias-border-l2);align-items:center;gap:6px;padding:8px 2px 4px;font-size:11px;font-weight:600;display:flex}' +
      '.dkb-groupHead:first-child{border-top:0;padding-top:2px}' +
      '.dkb-groupHead:hover{color:var(--dsw-alias-label-primary)}' +
      '.dkb-groupCount{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-weight:400}' +
      '.dkb-shown{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:12px;flex:none}' +
      '.dkb-moveBtn{appearance:none;font:inherit;cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;padding:0;font-size:11px;text-decoration:underline dotted}' +
      '.dkb-moveBtn:hover{color:var(--dsw-alias-label-primary)}' +
      '.dkb-taskCard:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:2px}' +
      '.dkb-sync{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:12px;flex:none}' +
      '.dkb-syncBad{color:var(--dsw-alias-status-danger,#e5534b);cursor:help}' +
      '.dkb-facet{position:relative;flex:none}' +
      '.dkb-facetHead{appearance:none;font:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 10px;font-size:13px;white-space:nowrap}' +
      '.dkb-facetHead:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dkb-facetOn{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dkb-facetList{position:absolute;top:calc(100% + 4px);left:0;z-index:60;min-width:180px;max-height:280px;overflow-y:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:var(--dsw-shadow-lv2);padding:6px;display:flex;flex-direction:column;gap:2px}' +
      '.dkb-facetRow{align-items:center;gap:8px;padding:4px 6px;border-radius:6px;font-size:13px;cursor:pointer;display:flex}' +
      '.dkb-facetRow:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dkb-facetName{flex:1;color:var(--dsw-alias-label-primary)}' +
      '.dkb-barTitle{color:var(--dsw-alias-label-primary);white-space:nowrap;margin:0;font-size:16px;font-weight:700;margin-right:auto}' +
      '.dkb-cols{overscroll-behavior-inline:contain;scrollbar-color:var(--dsw-alias-border-l3) var(--dsw-alias-interactive-bg-hover);scrollbar-width:thin;flex:1;gap:12px;min-height:0;padding-bottom:6px;display:flex;overflow:auto hidden}' +
      '.dkb-cols::-webkit-scrollbar{height:10px}' +
      '.dkb-cols::-webkit-scrollbar-track{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px}' +
      '.dkb-cols::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);background-clip:content-box;border:2px solid #0000;border-radius:999px}' +
      '.dkb-col{flex:1 1 220px;min-width:220px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;flex-direction:column;min-height:0;display:flex;overflow:hidden}' +
      '.dkb-colOver{border-color:var(--dsw-alias-border-l3)}' +
      '.dkb-colHead{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;flex:none;align-items:center;gap:6px;padding:10px 12px;display:flex}' +
      '.dkb-colHead:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dkb-colShut{flex:0 0 auto;min-width:0;width:40px}' +
      '.dkb-colShut .dkb-colHead{writing-mode:vertical-rl;height:100%;width:auto;padding:12px 10px;justify-content:flex-start;gap:10px}' +
      '.dkb-colShut .dkb-colHead .dkb-dot{writing-mode:horizontal-tb}' +
      '.dkb-colShut .dkb-count{writing-mode:horizontal-tb}' +
      '.dkb-dot{border-radius:50%;flex:none;width:8px;height:8px}' +
      '.dkb-dot[data-col=backlog]{background:var(--dsw-alias-label-tertiary)}' +
      '.dkb-dot[data-col=in-progress]{background:var(--dsw-alias-state-warn-primary)}' +
      '.dkb-dot[data-col=review]{background:var(--dsw-alias-state-business-primary)}' +
      '.dkb-dot[data-col=deploy]{background:var(--dsw-alias-state-business-primary)}' +
      '.dkb-dot[data-col=cleanup]{background:var(--dsw-alias-label-tertiary)}' +
      '.dkb-dot[data-col=done]{background:var(--dsw-alias-state-success-primary)}' +
      '.dkb-colName{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;margin:0;font-size:13px;font-weight:700;overflow:hidden}' +
      '.dkb-count{min-width:20px;text-align:center;color:var(--dsw-alias-bg-base);background:var(--dsw-alias-label-tertiary);border-radius:999px;flex:none;padding:1px 8px;font-size:12px;font-weight:600}' +
      '.dkb-count[data-col=in-progress]{background:var(--dsw-alias-state-warn-primary)}' +
      '.dkb-count[data-col=review]{background:var(--dsw-alias-state-business-primary)}' +
      '.dkb-count[data-col=deploy]{background:var(--dsw-alias-state-business-primary)}' +
      '.dkb-count[data-col=done]{background:var(--dsw-alias-state-success-primary)}' +
      '.dkb-countOver{background:var(--dsw-alias-state-error-primary);color:#fff}' +
      '.dkb-overdue{border-color:var(--dsw-alias-state-error-primary)}' +
      '.dkb-dueOver{color:var(--dsw-alias-state-error-primary);font-weight:600}' +
      '.dkb-list{flex-direction:column;flex:1;gap:8px;min-height:0;padding:2px 8px 10px;display:flex;overflow-y:auto}' +
      '.dkb-empty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:24px 8px;font-size:12px}' +
      '.dkb-taskCard{text-align:left;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;color:var(--dsw-alias-label-primary);border-radius:10px;flex-direction:column;gap:6px;padding:10px 12px;font-family:inherit;transition:box-shadow .12s,border-color .12s,transform .12s;display:flex}' +
      '.dkb-taskCard:hover{box-shadow:var(--dsw-shadow-lv2);border-color:var(--dsw-alias-border-l3);transform:translateY(-1px)}' +
      '.dkb-taskTitle{-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:13px;font-weight:600;line-height:1.35;display:-webkit-box;overflow:hidden}' +
      '.dkb-mdBody{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow-y:auto}' +
      '.dkb-mdPara{margin:0;overflow-wrap:anywhere}' +
      '.dkb-mdHead{color:var(--dsw-alias-label-primary);font-weight:700;margin:6px 0 0;line-height:1.35}' +
      '.dkb-mdHead1{font-size:15px}' +
      '.dkb-mdHead2{font-size:14px}' +
      '.dkb-mdHead3{font-size:13px;color:var(--dsw-alias-label-secondary)}' +
      '.dkb-mdList{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:3px}' +
      '.dkb-mdCode{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);font-size:12px;overflow-x:auto;white-space:pre}' +
      '.dkb-mdQuote{margin:0;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}' +
      '.dkb-mdRule{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:2px 0;width:100%}' +
      '.dkb-code{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px;font-size:12px}' +
      '.dkb-issueLink{color:var(--dsw-alias-label-secondary)}' +
      '.dkb-taskHead{align-items:center;gap:6px;flex-wrap:wrap;display:flex}' +
      '.dkb-ref{align-items:baseline;gap:5px;min-width:0;display:inline-flex}' +
      '.dkb-refRepo{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 7px;font-size:11px;font-weight:600}' +
      '.dkb-refNum{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);letter-spacing:.02em}' +
      '.dkb-refLink{text-decoration:none}' +
      '.dkb-refLink:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}' +
      '.dkb-taskRef{color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;font-size:11px;display:flex}' +
      '.dkb-planLine{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.35;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box}' +
      '.dkb-state{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 5px;font-size:10px;line-height:16px}' +
      '.dkb-stateLive{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);font-weight:600}' +
      '.dkb-batchList{list-style:none;margin:0;padding:0;max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:4px}' +
      '.dkb-batchRow{align-items:baseline;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary);display:flex}' +
      '.dkb-pick{margin:0;flex:none;opacity:0;transition:opacity .12s}' +
      '.dkb-taskCard:hover .dkb-pick,.dkb-taskCard:focus-within .dkb-pick,.dkb-pickOn{opacity:1}' +
      '.dkb-toChat{appearance:none;font:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:0;padding:0;font-size:11px;text-decoration:underline dotted}' +
      '.dkb-toChat:hover{color:var(--dsw-alias-label-primary)}' +
      '.dkb-planList{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}' +
      '.dkb-planItem{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4;display:flex;gap:8px;align-items:baseline}' +
      '.dkb-planItem.dkb-planDone{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}' +
      '.dkb-planItem.dkb-planActive{color:var(--dsw-alias-label-primary);font-weight:600;text-decoration:none}' +
      '.dkb-planMark{flex:none;width:14px;text-align:center}' +
      '.dkb-tags{display:flex;flex-wrap:wrap;gap:4px}' +
      // Ожидание — не колонка, а состояние карточки: агент стоит и ждёт человека.
      '.dkb-waiting{color:var(--dsw-alias-state-warn-primary);font-weight:600}' +
      '.dkb-waitDot{border-radius:50%;flex:none;width:8px;height:8px;background:var(--dsw-alias-state-warn-primary);display:inline-block}' +
      '.dkb-tag{white-space:nowrap;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid transparent;border-radius:999px;padding:1px 7px;font-size:11px;line-height:1.5;font-weight:500}' +
      // Снизу оставлен запас: поверх интерфейса висят плавающие виджеты соседних
      // плагинов (например счётчик расходов), и без запаса последняя кнопка
      // оказывается под ними — нажать нельзя, а выглядит как «ничего не работает».
      '.dkb-modal{position:absolute;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:24px 24px 84px;box-sizing:border-box;z-index:70}' +
      '.dkb-panel{width:min(720px,100%);max-height:100%;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;box-sizing:border-box;overflow-y:auto;display:flex;flex-direction:column;gap:12px}' +
      '.dkb-panelBody{white-space:pre-wrap;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;margin:0}' +
      '.dkb-log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}' +
      '.dkb-logRow{color:var(--dsw-alias-label-secondary);font-size:12px}' +
      '.dkb-dialog{position:absolute;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:80}' +
      '.dkb-dialogBox{width:min(560px,94%);max-height:86%;overflow-y:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}' +
      '.dkb-issue{appearance:none;font:inherit;text-align:left;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;color:var(--dsw-alias-label-primary);font-size:13px}' +
      '.dkb-issueUsed{opacity:.5}' +
      '.dkb-row{display:flex;gap:8px;align-items:center}' +
      '.dkb-search{min-width:120px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;flex:0 240px;padding:6px 10px;font-size:13px}' +
      '.dkb-search::placeholder{color:var(--dsw-alias-label-tertiary)}' +
      // Указатель места вставки: без него карточку отпускают вслепую.
      '.dkb-slot{height:2px;border-radius:2px;background:transparent;flex:none}' +
      '.dkb-slotOn{background:var(--dsw-alias-state-business-primary)}' +
      '.dkb-danger{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:5px 14px;font-size:13px;color:var(--dsw-alias-state-error-primary);background:transparent}' +
      '.dkb-danger:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}'


    // ---------------------------------------------------------------- строки

    // Правило регистра, чтобы подписи не расползались:
    //
    //   подпись УПРАВЛЕНИЯ — с прописной: «Архив», «Поиск», «Обновить». Это
    //   имя кнопки, а не продолжение фразы;
    //   встроенный текст и состояние — со строчной: «ждёт ответа», «здесь
    //   3 дн», «показано 12 из 81». Это часть предложения, а не ярлык.
    //
    // Смешение того и другого в одном ряду и выглядит халтурой.
    const en = {
      'title': 'Kanban',
      'subtitle': 'Task board: Gitea issues and a session per task',
      'section.label': 'Kanban',
      'group.gitea': 'Gitea',
      'group.general': 'General',
      'field.giteaUrl': 'Instance URL',
      'field.giteaTokenRef': 'Credential name',
      'hint.giteaUrl': 'For example https://gitea.example.com. Empty means importing is unavailable.',
      'hint.giteaTokenRef': 'The NAME of a DSH credential holding the token. Never type the token itself here.',
      'group.limits': 'Column limits',
      'group.sync': 'Automatic moves',
      'field.syncIntervalSec': 'Check Gitea every, seconds',
      'field.staleAfterMin': 'Call a task silent after, minutes',
      'field.giteaOwner': 'Gitea organisation',
      'hint.giteaOwner': 'Whose repositories the board watches. Empty is fine while the token belongs to exactly one organisation.',
      'field.columnNames': 'Your own column names',
      'hint.columnNames': 'Pairs «id=Name», comma separated, for example «backlog=Ideas, review=Check». Empty keeps the usual names.',
      'field.watchRepos': 'Narrow the pull to these repositories',
      'hint.watchRepos': 'Comma separated, «owner/repo» or just «repo». Empty means every repository of the organisation that has open issues.',
      'field.archiveAfterDays': 'Archive a done card after, days',
      'hint.archiveAfterDays': 'Counted from the moment the card entered Done. Zero keeps everything on the board.',
      'field.boardToolEnabled': 'Let the agent move cards',
      'field.pushToGitea': 'Close the issue in Gitea',
      'field.webhookSecretRef': 'Webhook credential name',
      'hint.pushToGitea': 'A card reaching Done closes its issue. The board sets no labels: the stage is already visible from the branch and the pull request.',
      'hint.webhookSecretRef': 'NAME of a DSH credential holding the Gitea webhook secret. Empty leaves only polling.',
      'hint.syncIntervalSec': 'Zero turns the check off. Below fifteen seconds is raised to fifteen.',
      'hint.staleAfterMin': 'Only tasks that have a session are marked. Zero turns the mark off.',
      'hint.boardToolEnabled': 'Off until the workflow skill stops forbidding this CLI to touch a kanban.',
      'field.defaultProjectRoot': 'Project root',
      'field.startPrompt': 'First message template',
      'field.replyInstruction': 'Standing note',
      'field.wipInProgress': 'In progress limit',
      'field.wipReview': 'Review limit',
      'hint.defaultProjectRoot': 'Where project working copies live. Empty means the harness working directory.',
      'hint.startPrompt': 'Template for the first message to the agent. Empty means the built-in template.',
      'hint.replyInstruction': 'Appended to every first message — the answer language, for instance. Empty adds nothing.',
      'hint.label': 'Empty means no label is set for this column.',
      'hint.limit': 'Zero means no limit. Going over is highlighted, never blocked.',
      'settings.loading': 'Loading settings…',
      'settings.unavailable': 'The host does not know the dsh-kanban settings namespace. Restart the Web UI after installing the plugin.',
      'settings.readOnly': 'Settings are read-only in this session.',
      'settings.saveFailed': 'Failed to save: {fields}',
      'settings.saved': 'Saved.',
      'save': 'Save',
      'discard': 'Discard',
      'column.backlog': 'Backlog',
      'column.in-progress': 'In progress',
      'column.review': 'Review',
      'column.deploy': 'Deploy',
      'column.cleanup': 'Cleanup',
      'column.done': 'Done',
      'board.loading': 'Loading the board…',
      'board.empty': 'No tasks yet.',
      'board.waiting': 'needs you',
      'board.sync': 'Check Gitea',
      'board.syncing': 'Checking…',
      'board.noMatch': 'Nothing matches the search.',
      'board.search': 'Search',
      'board.limit': 'limit {n}',
      'board.newTask': 'Task',
      'board.refresh': 'Refresh',
      'board.allRepos': 'All repositories',
      'board.repo': 'repository',
      'dialog.title': 'New task',
      'dialog.own': 'Own task',
      'dialog.fromGitea': 'From Gitea',
      'dialog.repo': 'Repository',
      'dialog.pickRepo': 'Pick a repository',
      'dialog.loadingRepos': 'Loading repositories…',
      'dialog.noRepos': 'No repositories available',
      'dialog.taskTitle': 'Title',
      'dialog.taskBody': 'Description',
      'dialog.taskLabels': 'Labels',
      'dialog.taskColumn': 'Column',
      'dialog.bodyHint': 'Goes to the agent as the first message when the task starts.',
      'dialog.labelsHint': 'comma separated',
      'dialog.archived': 'archived',
      'dialog.create': 'Create',
      'dialog.cancel': 'Cancel',
      'move.title': 'Move to “{column}”?',
      'board.expand': 'Expand the column',
      'card.move': 'move',
      'card.toChat': 'to the chat',
      'card.due': 'due {date}',
      'card.pick': 'Select for a group start',
      'card.queue': 'to a queue...',
      'card.unqueue': 'take out of the queue',
      'queue.title': 'Add to a running session',
      'queue.hint': 'The task joins the session queue: the agent takes it when it finishes the current work. Until then the card stays where it is.',
      'queue.session': 'Session',
      'queue.option': '{title} - tasks: {n}',
      'queue.add': 'To the queue',
      'error.no-live-sessions': 'No running session to queue into.',
      'error.session-not-live': 'That session is no longer running.',
      'error.task-not-queued': 'This task is not in a queue.',
      'batch.title': 'Start {n} tasks in one chat',
      'batch.hint': 'One session for all of them. Tasks arrive one at a time: the agent takes the next when it finishes the current one. Only the first moves to In progress — the rest wait their turn where they are.',
      'batch.start': 'Start',
      'state.queued': 'queued · {n}',
      'board.pickedCount': 'selected {n}',
      'board.pickNone': 'Clear selection',
      'board.pickStart': 'Start selected',
      'dialog.kind': 'What kind of task',
      'dialog.kindProject': 'Project',
      'dialog.kindPlain': 'Not a project',
      'dialog.kindProjectHint': 'An issue is created in Gitea and the card is bound to it. The card lives on the project board.',
      'dialog.kindPlainHint': 'A note that touches no repository. It lives on the simple board and never reaches Gitea.',
      'dialog.repoNew': '— a new repository —',
      'dialog.repoNamePlaceholder': 'name of the new repository',
      'dialog.repoNewHint': 'It will be created in the organisation: private and empty, no README and no scaffolding. Creating a repository cannot be undone from here.',
      'error.repo-required': 'Choose a repository or name a new one.',
      'error.bad-repo-name': 'A repository name may contain only Latin letters, digits, dot, dash and underscore.',
      'error.repo-not-created': 'The repository was not created; nothing else was done.',
      'error.issue-not-created': 'The issue was not created. If the repository was new, it stayed — nothing was deleted.',
      'board.archive': 'Archive',
      'board.metrics': 'Metrics',
      'metrics.hint': '{n} tasks on the board · done in a week: {week} · in a month: {month}',
      'metrics.columns': 'Time spent in a column',
      'metrics.median': 'median {time}',
      'metrics.mean': 'average {time}',
      'metrics.stale': 'Sitting still longer than {days} days',
      'metrics.noStale': 'Nothing has been sitting that long.',
      'metrics.empty': 'No transitions yet — nothing to measure.',
      'board.export': 'Download',
      'board.import': 'Import',
      'board.exportHint': 'Download the whole board as JSON',
      'board.imported': 'Imported {n} tasks',
      'error.badImport': 'That file is not a valid board backup.',
      'panel.archive': 'To the archive',
      'archive.hint': 'Cards that spent their term in Done. Nothing is deleted: a restored card returns to the column it left.',
      'archive.empty': 'The archive is empty.',
      'archive.since': 'archived {ago} ago',
      'archive.restore': 'Back to the board',
      'sync.running': 'checking with Gitea…',
      'sync.never': 'not checked with Gitea yet',
      'sync.okAgo': 'checked {ago} ago',
      'sync.failed': 'the check is failing',
      'sync.lastSeen': 'last successful check {ago} ago',
      'sync.neverSeen': 'no successful check since the harness started',
      'facet.repo': 'Repository',
      'facet.author': 'Author',
      'facet.assignee': 'Assignee',
      'board.mine': 'Mine: {n}',
      'board.mineHint': 'Tasks assigned to {who}',
      'group.repo': 'By project',
      'group.assignee': 'By assignee',
      'group.nobody': 'nobody took it',
      'card.assigneeHint': 'Who took the task',
      'panel.assignee': 'taken by {who}',
      'panel.assignMe': 'Take it',
      'panel.assignDrop': 'Drop it',
      'error.gitea-unreachable': 'Gitea did not answer, so there is nobody to take the task as.',
      'board.pickArchive': 'To the archive',
      'board.pickUnqueue': 'Out of the queue',
      'board.pickMove': 'Move to…',
      'board.someFailed': 'Done for {done} of {total}; the rest refused.',
      'card.stop': 'stop',
      'card.revive': 'resume work',
      'revive.same': 'The old session came back — the chat is where you left it.',
      'revive.fresh': 'The old session was gone, so a new one started; the previous chat is not there any more.',
      'card.pack': 'batch {at} of {total}',
      'card.packHint': 'Started together, one session; the agent takes them in this order.',
      'stop.idle': 'The agent was not running — there was nothing to stop.',
      'stop.no-session': 'This task has no session.',
      'board.waitCount': 'Waiting for you: {n}',
      'board.waitCountHint': 'Tasks where the agent asked a question or wants permission.',
      'order.manual': 'As laid out',
      'order.old': 'Oldest first',
      'order.new': 'Newest first',
      'facet.type': 'Type',
      'facet.priority': 'Priority',
      'facet.status': 'Status',
      'facet.scope': 'Scope',
      'facet.risk': 'Risk',
      'facet.signal': 'Signal',
      'facet.release': 'Release',
      'boardName.main': 'Project board',
      'boardName.simple': 'Simple board',
      'board.clearFilters': 'Clear filters',
      'board.shown': 'showing {shown} of {total}',
      'board.noRepo': 'no project',
      'board.back': 'To the chat',
      'board.backHint': 'Close the board and return to the conversation',
      'panel.openChat': 'Open the chat',
      'panel.bodyLoading': 'reading the description…',
      'panel.author': 'by {who}',
      'panel.created': 'created {ago} ago',
      'panel.updated': 'last change {ago} ago',
      'time.now': 'just now',
      'time.min': '{n} min',
      'time.hour': '{n} h',
      'time.day': '{n} d',
      'board.collapse': 'Collapse the column',
      'plan.title': 'Agent plan',
      'plan.counter': '{done} of {total}',
      'state.running': 'working',
      'state.stopped': 'stopped',
      'move.confirm': 'Move',
      'move.backlog': 'Work on the task stops: the agent’s running turn is aborted. With no session, the card just moves.',
      'move.in-progress': 'The agent is told to start or continue the implementation.',
      'move.review': 'The agent takes the work to review: drops the draft mark from the pull request and asks for a check.',
      'move.deploy': 'The agent merges the pull request and deploys. This move IS your explicit go-ahead for the deploy — the agent will not ask again.',
      'move.cleanup': 'The agent deletes the Gitea branch, the worktree and the local branch, and records that in the issue.',
      'move.done': 'The task counts as finished. This is a human decision: the agent never moves a card here itself.',
      'dialog.imported': 'already on the board',
      'dialog.noIssues': 'No open issues found.',
      'panel.close': 'Close',
      'panel.issue': 'Issue',
      'panel.log': 'Transitions',
      'panel.noLog': 'No transitions yet.',
      'panel.refresh': 'Refresh from Gitea',
      'panel.delete': 'Delete',
      'panel.deleteConfirm': 'Delete "{title}"? This cannot be undone.',
      'panel.start': 'Start',
      'panel.agentPreset': 'Agent profile',
      'panel.presetDefault': 'Harness default',
      'panel.permission': 'Access level',
      'error.permission-unavailable': 'This deployment offers no access levels — the task was not started, so it could not run with wider rights than asked.',
      'error.permission-refused': 'The access level was refused; the task was not started.',
      'panel.provider': 'Provider',
      'panel.model': 'Model',
      'panel.pickProvider': 'Pick a provider',
      'panel.pickProviderFirst': 'Pick a provider first',
      'panel.pickModel': 'Pick a model',
      'panel.noProviders': 'No providers available',
      'panel.noModels': 'This provider offers no models',
      'panel.starting': 'Starting…',
      'panel.continue': 'Continue',
      'panel.continueHint': 'The task keeps its own chat: the existing session is opened, not a new one.',
      'panel.message': 'Message to the agent',
      'panel.messageHint': 'Edit before sending. Empty falls back to the built-in text.',
      'panel.startHint': 'A dedicated agent session opens for this task. Branch and worktree are created by the agent after its preflight, not here.',
      'panel.workDir': 'Working folder: {path}',
      'panel.workDirHint': 'The project root is not set in settings, so this folder is used.',
      'panel.priority': 'Priority',
      'panel.priorityNone': 'No priority',
      'priority.high': 'High',
      'priority.medium': 'Medium',
      'priority.low': 'Low',
      'panel.labels': 'Labels',
      'panel.due': 'Due date',
      'panel.saveEdit': 'Save',
      'board.overdueCount': 'Overdue: {n}',
      'board.overdueHint': 'Show only overdue tasks',
      'error.startFailed': 'Could not start the session.',
      'error.sessionNotOpened': 'The session started ({id}) but this build cannot switch to it. Find it in the session list.',
      'error.modelNotSelected': 'No model selected — pick one in Settings, or type it here.',
      'chip.moveTo': 'Move to',
      'chip.openCard': 'Open the card',
      'chip.note': 'Leave a note',
      'chip.noteHint': 'The note is appended to the task body. The body goes to the agent with the first message, so a note left before the start reaches the work and one left after does not.',
      'chip.noteSave': 'Append',
      'error.giteaAbsent': 'The Gitea plugin is not installed, so importing is unavailable.',
      'error.giteaUnconfigured': 'Configure Gitea in the Gitea plugin card first.',
      'error.taskNotFound': 'Task not found.',
      'error.taskHasNoIssue': 'This task has no Gitea issue behind it.',
      'error.issueNotFound': 'Issue not found.',
      'error.titleRequired': 'A title is required.',
      'error.crossSite': 'Request rejected as cross-site.',
      'error.unknown': 'Request failed.',
    }

    // Китайский — вторая встроенная локаль ядра. Русского здесь нет:
    // он приезжает языковым пакетом `dsh-russian-lang`, который
    // регистрирует `ru` для этого пространства извне.
    const zh = {
      'title': '看板',
      'subtitle': '任务看板：Gitea issue，每个任务一个会话',
      'section.label': '看板',
      'group.gitea': 'Gitea',
      'group.general': '通用',
      'field.giteaUrl': '实例地址',
      'field.giteaTokenRef': '凭据名称',
      'hint.giteaUrl': '例如 https://gitea.example.com。留空则无法导入。',
      'hint.giteaTokenRef': '保存令牌的 DSH 凭据的名称。切勿在此直接填写令牌本身。',
      'group.limits': '列的上限',
      'group.sync': '自动移动',
      'field.syncIntervalSec': '核对 Gitea 的间隔（秒）',
      'field.staleAfterMin': '多久无动静视为沉默（分钟）',
      'field.giteaOwner': 'Gitea 组织',
      'hint.giteaOwner': '看板监视谁的仓库。若令牌只属于一个组织，可以留空。',
      'field.columnNames': '自定义列名',
      'hint.columnNames': '「id=名称」成对，用逗号分隔，例如「backlog=想法, review=检查」。留空则沿用默认名称。',
      'field.watchRepos': '只收取这些仓库',
      'hint.watchRepos': '逗号分隔，写「owner/repo」或只写「repo」。留空表示组织下所有有开放 issue 的仓库。',
      'field.archiveAfterDays': '完成多少天后归档',
      'hint.archiveAfterDays': '从卡片进入「已完成」时算起。填 0 表示都留在看板上。',
      'field.boardToolEnabled': '允许 Agent 移动卡片',
      'field.pushToGitea': '在 Gitea 中关闭 issue',
      'field.webhookSecretRef': 'Webhook 凭据名称',
      'hint.pushToGitea': '卡片进入「已完成」即关闭其 issue。看板不设置任何标签：阶段从分支和 pull request 上已经看得出来。',
      'hint.webhookSecretRef': '保存 Gitea webhook 密钥的 DSH 凭据的名称。留空则只剩轮询。',
      'hint.syncIntervalSec': '填 0 关闭核对。小于十五秒会被提到十五秒。',
      'hint.staleAfterMin': '只标记有会话的任务。填 0 关闭该标记。',
      'hint.boardToolEnabled': '在工作流技能仍禁止此 CLI 触碰看板之前保持关闭。',
      'field.defaultProjectRoot': '项目根目录',
      'field.startPrompt': '首条消息模板',
      'field.replyInstruction': '固定附言',
      'field.wipInProgress': '「进行中」上限',
      'field.wipReview': '「评审」上限',
      'hint.defaultProjectRoot': '项目工作副本所在之处。留空表示 harness 的工作目录。',
      'hint.startPrompt': '发给 Agent 的首条消息模板。留空使用内置模板。',
      'hint.replyInstruction': '追加到每条首消息之后——例如回答所用的语言。留空则不追加。',
      'hint.label': '留空表示这一列不设置标签。',
      'hint.limit': '填 0 表示不限。超出只会高亮，绝不阻拦。',
      'settings.loading': '正在加载设置…',
      'settings.unavailable': '宿主不认识 dsh-kanban 设置命名空间。安装插件后请重启 Web UI。',
      'settings.readOnly': '本会话中设置为只读。',
      'settings.saveFailed': '保存失败：{fields}',
      'settings.saved': '已保存。',
      'save': '保存',
      'discard': '放弃',
      'column.backlog': '待办',
      'column.in-progress': '进行中',
      'column.review': '评审',
      'column.deploy': '发布',
      'column.cleanup': '清理',
      'column.done': '已完成',
      'board.loading': '正在加载看板…',
      'board.empty': '还没有任务。',
      'board.waiting': '需要你',
      'board.sync': '核对 Gitea',
      'board.syncing': '核对中…',
      'board.noMatch': '没有符合搜索的内容。',
      'board.search': '搜索',
      'board.limit': '上限 {n}',
      'board.newTask': '任务',
      'board.refresh': '刷新',
      'board.allRepos': '全部仓库',
      'board.repo': '仓库',
      'dialog.title': '新任务',
      'dialog.own': '自建任务',
      'dialog.fromGitea': '来自 Gitea',
      'dialog.repo': '仓库',
      'dialog.pickRepo': '选择仓库',
      'dialog.loadingRepos': '正在加载仓库…',
      'dialog.noRepos': '没有可用的仓库',
      'dialog.taskTitle': '标题',
      'dialog.taskBody': '描述',
      'dialog.taskLabels': '标签',
      'dialog.taskColumn': '列',
      'dialog.bodyHint': '任务启动时作为首条消息发给 Agent。',
      'dialog.labelsHint': '用逗号分隔',
      'dialog.archived': '已归档',
      'dialog.create': '创建',
      'dialog.cancel': '取消',
      'move.title': '移动到「{column}」？',
      'board.expand': '展开该列',
      'card.move': '移动',
      'card.toChat': '进入对话',
      'card.due': '截止 {date}',
      'card.pick': '选中以便批量启动',
      'card.queue': '加入队列…',
      'card.unqueue': '移出队列',
      'queue.title': '加入正在运行的会话',
      'queue.hint': '任务进入该会话的队列：Agent 做完手头的工作后就会接手。在那之前卡片留在原处。',
      'queue.session': '会话',
      'queue.option': '{title} - 任务数：{n}',
      'queue.add': '加入队列',
      'error.no-live-sessions': '没有正在运行的会话可供排队。',
      'error.session-not-live': '该会话已不再运行。',
      'error.task-not-queued': '该任务并不在队列中。',
      'batch.title': '在一个对话里启动 {n} 个任务',
      'batch.hint': '所有任务共用一个会话。任务逐个送达：Agent 做完当前的才会接下一个。只有第一个进入「进行中」，其余在原处等候。',
      'batch.start': '启动',
      'state.queued': '排队中 · {n}',
      'board.pickedCount': '已选 {n}',
      'board.pickNone': '取消选择',
      'board.pickStart': '启动所选',
      'dialog.kind': '任务类型',
      'dialog.kindProject': '项目任务',
      'dialog.kindPlain': '非项目',
      'dialog.kindProjectHint': '会在 Gitea 中创建 issue 并与卡片绑定。卡片位于项目看板。',
      'dialog.kindPlainHint': '不涉及任何仓库的便签。它位于简易看板，永远不会到达 Gitea。',
      'dialog.repoNew': '— 新建仓库 —',
      'dialog.repoNamePlaceholder': '新仓库的名称',
      'dialog.repoNewHint': '将在该组织中创建：私有且为空，没有 README，也没有任何脚手架。创建仓库无法从这里撤销。',
      'error.repo-required': '请选择仓库，或为新仓库起个名字。',
      'error.bad-repo-name': '仓库名称只能包含拉丁字母、数字、点、连字符和下划线。',
      'error.repo-not-created': '仓库没有创建，其他动作也未执行。',
      'error.issue-not-created': 'issue 没有创建。如果仓库是新建的，它仍然保留——没有删除任何东西。',
      'board.archive': '归档',
      'board.metrics': '指标',
      'metrics.hint': '看板上有 {n} 个任务 · 一周完成 {week} 个 · 一个月完成 {month} 个',
      'metrics.columns': '在每一列停留的时间',
      'metrics.median': '中位数 {time}',
      'metrics.mean': '平均 {time}',
      'metrics.stale': '停滞超过 {days} 天',
      'metrics.noStale': '没有停滞这么久的任务。',
      'metrics.empty': '还没有流转记录，无从统计。',
      'board.export': '下载',
      'board.import': '导入',
      'board.exportHint': '将整个看板下载为 JSON',
      'board.imported': '已导入 {n} 个任务',
      'error.badImport': '该文件不是有效的看板备份。',
      'panel.archive': '移入归档',
      'archive.hint': '在「已完成」里待够时间的卡片。什么都没有删除：恢复的卡片会回到它离开的那一列。',
      'archive.empty': '归档是空的。',
      'archive.since': '已归档 {ago}',
      'archive.restore': '放回看板',
      'sync.running': '正在与 Gitea 核对…',
      'sync.never': '还没有与 Gitea 核对过',
      'sync.okAgo': '{ago}前核对过',
      'sync.failed': '核对一直失败',
      'sync.lastSeen': '最后一次成功核对在 {ago}前',
      'sync.neverSeen': '自 harness 启动以来没有一次成功的核对',
      'facet.repo': '仓库',
      'facet.author': '创建者',
      'facet.assignee': '负责人',
      'board.mine': '我的：{n}',
      'board.mineHint': '指派给 {who} 的任务',
      'group.repo': '按项目',
      'group.assignee': '按负责人',
      'group.nobody': '无人接手',
      'card.assigneeHint': '谁接下了这个任务',
      'panel.assignee': '由 {who} 接手',
      'panel.assignMe': '我来接',
      'panel.assignDrop': '放手',
      'error.gitea-unreachable': 'Gitea 没有响应，无从得知以谁的身份接手。',
      'board.pickArchive': '移入归档',
      'board.pickUnqueue': '移出队列',
      'board.pickMove': '移动到…',
      'board.someFailed': '{total} 个中完成了 {done} 个，其余被拒绝。',
      'card.stop': '停止',
      'card.revive': '继续工作',
      'revive.same': '原会话已恢复，对话还在原处。',
      'revive.fresh': '原会话已不在，因此新开了一个；先前的对话不在其中。',
      'card.pack': '批次 {at}/{total}',
      'card.packHint': '一起启动，同一个会话；Agent 按这个顺序接手。',
      'stop.idle': 'Agent 本来就没有在跑，没有什么可停。',
      'stop.no-session': '该任务没有会话。',
      'board.waitCount': '等你回应：{n}',
      'board.waitCountHint': 'Agent 提了问题或在请求许可的任务。',
      'order.manual': '按摆放顺序',
      'order.old': '旧的在前',
      'order.new': '新的在前',
      'facet.type': '类型',
      'facet.priority': '优先级',
      'facet.status': '状态',
      'facet.scope': '范围',
      'facet.risk': '风险',
      'facet.signal': '信号',
      'facet.release': '发布',
      'boardName.main': '项目看板',
      'boardName.simple': '简易看板',
      'board.clearFilters': '清除筛选',
      'board.shown': '显示 {shown} / {total}',
      'board.noRepo': '无项目',
      'board.back': '回到对话',
      'board.backHint': '关闭看板并回到对话',
      'panel.openChat': '打开对话',
      'panel.bodyLoading': '正在读取描述…',
      'panel.author': '由 {who} 创建',
      'panel.created': '{ago}前创建',
      'panel.updated': '最后改动在 {ago}前',
      'time.now': '刚刚',
      'time.min': '{n} 分钟',
      'time.hour': '{n} 小时',
      'time.day': '{n} 天',
      'board.collapse': '收起该列',
      'plan.title': 'Agent 的计划',
      'plan.counter': '{done}/{total}',
      'state.running': '工作中',
      'state.stopped': '已停下',
      'move.confirm': '移动',
      'move.backlog': '任务上的工作会停止：Agent 正在进行的一轮被中断。没有会话时，卡片只是挪个位置。',
      'move.in-progress': '通知 Agent 开始或继续实现。',
      'move.review': 'Agent 把工作送去评审：取消 pull request 的草稿标记并请求检查。',
      'move.deploy': 'Agent 合并 pull request 并发布。这一移动本身就是你对发布的明确许可——Agent 不会再问一次。',
      'move.cleanup': 'Agent 删除 Gitea 上的分支、worktree 和本地分支，并把做过的事记录到 issue 里。',
      'move.done': '任务算作完成。这是人的决定：Agent 从不自己把卡片移到这里。',
      'dialog.imported': '已经在看板上',
      'dialog.noIssues': '没有找到开放的 issue。',
      'panel.close': '关闭',
      'panel.issue': 'issue',
      'panel.log': '流转记录',
      'panel.noLog': '还没有流转记录。',
      'panel.refresh': '从 Gitea 刷新',
      'panel.delete': '删除',
      'panel.deleteConfirm': '删除「{title}」？此操作无法撤销。',
      'panel.start': '启动',
      'panel.agentPreset': 'Agent 预设',
      'panel.presetDefault': '按 harness 的默认',
      'panel.permission': '权限级别',
      'error.permission-unavailable': '这套部署没有提供权限级别——任务没有启动，以免它以超出所请求的权限运行。',
      'error.permission-refused': '权限级别被拒绝，任务没有启动。',
      'panel.provider': '供应商',
      'panel.model': '模型',
      'panel.pickProvider': '选择供应商',
      'panel.pickProviderFirst': '请先选择供应商',
      'panel.pickModel': '选择模型',
      'panel.noProviders': '没有可用的供应商',
      'panel.noModels': '该供应商没有可用模型',
      'panel.starting': '正在启动…',
      'panel.continue': '继续',
      'panel.continueHint': '任务保有自己的对话：打开的是已有会话，而不是新的。',
      'panel.message': '发给 Agent 的消息',
      'panel.messageHint': '发送前可以修改。留空则使用内置文本。',
      'panel.startHint': '会为该任务打开一个专属的 Agent 会话。分支和 worktree 由 Agent 在自检之后创建，不在这里。',
      'panel.workDir': '工作目录：{path}',
      'panel.workDirHint': '设置中未指定项目根目录，因此使用此目录。',
      'panel.priority': '优先级',
      'panel.priorityNone': '无优先级',
      'priority.high': '高',
      'priority.medium': '中',
      'priority.low': '低',
      'panel.labels': '标签',
      'panel.due': '截止日期',
      'panel.saveEdit': '保存',
      'board.overdueCount': '已逾期：{n}',
      'board.overdueHint': '仅显示已逾期的任务',
      'error.startFailed': '会话没能启动。',
      'error.sessionNotOpened': '会话已启动（{id}），但此版本无法切换过去。请到会话列表中查找。',
      'error.modelNotSelected': '没有选择模型——请在设置中选择，或在此处填写。',
      'chip.moveTo': '移动到',
      'chip.openCard': '打开卡片',
      'chip.note': '留个便签',
      'chip.noteHint': '便签会追加到任务正文。正文随首条消息发给 Agent，所以启动前留的便签能到达工作，启动后留的则不会。',
      'chip.noteSave': '追加',
      'error.giteaAbsent': '没有安装 Gitea 插件，因此无法导入。',
      'error.giteaUnconfigured': '请先在 Gitea 插件的设置卡片中完成配置。',
      'error.taskNotFound': '没有找到任务。',
      'error.taskHasNoIssue': '该任务背后没有 Gitea issue。',
      'error.issueNotFound': '没有找到 issue。',
      'error.titleRequired': '标题不能为空。',
      'error.crossSite': '请求被判定为跨站而拒绝。',
      'error.unknown': '请求失败。',
    }

    function fallbackT(key, vars) {
      // Запасной перевод — английский: русский приезжает языковым пакетом,
      // а до службы локализации доска обязана говорить хоть на чём-то.
      let text = en[key] !== undefined ? en[key] : key
      if (vars) {
        for (const name of Object.keys(vars)) {
          text = text.split('{' + name + '}').join(String(vars[name]))
        }
      }
      return text
    }

    // ------------------------------------------------------- карточка настроек

    const FIELDS = [
      { field: 'giteaUrl', kind: 'text', group: 'gitea' },
      { field: 'giteaTokenRef', kind: 'text', group: 'gitea' },
      { field: 'defaultProjectRoot', kind: 'text', group: 'general' },
      { field: 'startPrompt', kind: 'area', group: 'general' },
      { field: 'replyInstruction', kind: 'text', group: 'general' },
      { field: 'wipInProgress', kind: 'number', group: 'limits' },
      { field: 'wipReview', kind: 'number', group: 'limits' },
      { field: 'giteaOwner', kind: 'text', group: 'gitea' },
      { field: 'syncIntervalSec', kind: 'number', group: 'sync' },
      { field: 'staleAfterMin', kind: 'number', group: 'sync' },
      { field: 'columnNames', kind: 'text', group: 'general' },
      { field: 'watchRepos', kind: 'text', group: 'sync' },
      { field: 'archiveAfterDays', kind: 'number', group: 'sync' },
      { field: 'boardToolEnabled', kind: 'bool', group: 'sync' },
      { field: 'pushToGitea', kind: 'bool', group: 'sync' },
      { field: 'webhookSecretRef', kind: 'text', group: 'sync' },
    ]

    function hintKey(spec) {
      if (spec.group === 'sync') return 'hint.' + spec.field
      if (spec.group === 'gitea') return 'hint.' + spec.field
      if (spec.group === 'labels') return 'hint.label'
      if (spec.group === 'limits') return 'hint.limit'
      return 'hint.' + spec.field
    }

    function Chevron(props) {
      return React.createElement('svg', {
        className: 'dkb-chevron' + (props.open ? ' dkb-chevronOpen' : ''),
        width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true',
      }, React.createElement('path', {
        d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5',
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function KanbanSettingsCard(props) {
      // Все хуки объявлены выше любого возврата: ранний возврат над хуком даёт
      // React error 310 при первом же изменении состояния.
      const ctx = props.ctx
      const t = props.t || fallbackT
      const [open, setOpen] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [failed, setFailed] = React.useState('')
      const [saved, setSaved] = React.useState(false)

      const scope = React.useMemo(
        () => (ctx && ctx.settingsScope ? ctx.settingsScope.bind({ namespace: NS }) : undefined),
        [ctx],
      )
      const snapshot = React.useSyncExternalStore(
        React.useMemo(() => (cb) => (scope ? scope.subscribe(cb) : () => {}), [scope]),
        React.useCallback(() => (scope ? scope.getSnapshot() : { status: 'loading' }), [scope]),
        React.useCallback(() => ({ status: 'loading' }), []),
      )

      const status = (snapshot && snapshot.status) || 'loading'
      const stored = (snapshot && snapshot.value) || {}

      const valueOf = React.useCallback((field) => {
        if (draft && Object.prototype.hasOwnProperty.call(draft, field)) return draft[field]
        const current = stored[field]
        return current === undefined ? '' : String(current)
      }, [draft, stored])

      const edit = React.useCallback((field, text) => {
        setSaved(false)
        setDraft((prev) => Object.assign({}, prev, { [field]: text }))
      }, [])

      const discard = React.useCallback(() => { setDraft(null); setFailed(''); setSaved(false) }, [])

      const save = React.useCallback(async () => {
        if (!scope || !draft) return
        setSaving(true); setFailed(''); setSaved(false)
        // Пишем ВСЕ поля, а не до первой ошибки: обрыв на первой неудаче
        // оставил бы остальные поля незаписанными, а снаружи это выглядит как
        // «кнопка не работает».
        const broken = []
        for (const spec of FIELDS) {
          if (!draft || !Object.prototype.hasOwnProperty.call(draft, spec.field)) continue
          let next = draft[spec.field]
          if (spec.kind === 'number') {
            const parsed = Number(String(next).trim())
            if (!Number.isFinite(parsed)) { broken.push(spec.field); continue }
            next = parsed
          } else if (spec.kind === 'bool') {
            next = String(next) === 'true'
          }
          try { await scope.set(spec.field, next) } catch { broken.push(spec.field) }
        }
        setSaving(false)
        if (broken.length) {
          setFailed(t('settings.saveFailed', { fields: broken.map((f) => t('field.' + f)).join(', ') }))
          return
        }
        setDraft(null); setSaved(true)
      }, [scope, draft, t])

      const head = React.createElement('button', {
        type: 'button', className: 'dkb-head', onClick: () => setOpen((v) => !v),
      },
        React.createElement('span', { className: 'dkb-headText' },
          React.createElement('span', { className: 'dkb-title' }, t('title')),
          React.createElement('span', { className: 'dkb-sub' }, t('subtitle')),
        ),
        React.createElement(Chevron, { open }),
      )
      const style = React.createElement('style', null, css)

      if (!open) return React.createElement('li', { className: 'dkb-card' }, style, head)

      let body
      if (status === 'loading') {
        body = React.createElement('p', { className: 'dkb-note', role: 'status' }, t('settings.loading'))
      } else if (status !== 'ready') {
        // Проверяем СТАТУС, а не значение: при `unavailable` признак writable
        // остаётся истинным, и карточка нарисовала бы пустую, но с виду
        // рабочую форму.
        body = React.createElement('p', { className: 'dkb-failed', role: 'status' }, t('settings.unavailable'))
      } else {
        const writable = !snapshot || snapshot.writable !== false
        const rows = []
        let lastGroup
        for (const spec of FIELDS) {
          if (spec.group !== lastGroup) {
            lastGroup = spec.group
            rows.push(React.createElement('div', { className: 'dkb-group', key: 'g-' + spec.group }, t('group.' + spec.group)))
          }
          if (spec.kind === 'bool') {
            // Булево поле — флажок, а не строка «true»: набирать слово руками
            // человека заставлять незачем.
            rows.push(React.createElement('div', { className: 'dkb-field', key: spec.field },
              React.createElement('label', { className: 'dkb-row' },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: String(valueOf(spec.field)) === 'true',
                  disabled: !writable || saving,
                  onChange: (e) => edit(spec.field, e.target.checked ? 'true' : 'false'),
                }),
                React.createElement('span', { className: 'dkb-label' }, t('field.' + spec.field)),
              ),
              React.createElement('p', { className: 'dkb-hint' }, t(hintKey(spec))),
            ))
            continue
          }
          const common = {
            className: spec.kind === 'area' ? 'dkb-area' : 'dkb-input',
            value: valueOf(spec.field),
            disabled: !writable || saving,
            onChange: (e) => edit(spec.field, e.target.value),
          }
          if (spec.kind === 'number') common.type = 'number'
          rows.push(React.createElement('div', { className: 'dkb-field', key: spec.field },
            React.createElement('span', { className: 'dkb-label' }, t('field.' + spec.field)),
            React.createElement(spec.kind === 'area' ? 'textarea' : 'input', common),
            React.createElement('p', { className: 'dkb-hint' }, t(hintKey(spec))),
          ))
        }
        const dirty = draft !== null && Object.keys(draft).length > 0
        let note
        if (failed) note = React.createElement('p', { className: 'dkb-failed', role: 'status' }, failed)
        else if (!writable) note = React.createElement('p', { className: 'dkb-note', role: 'status' }, t('settings.readOnly'))
        else if (saved) note = React.createElement('p', { className: 'dkb-note', role: 'status' }, t('settings.saved'))
        else note = React.createElement('p', { className: 'dkb-note' })
        rows.push(React.createElement('div', { className: 'dkb-foot', key: 'foot' },
          note,
          React.createElement('button', { type: 'button', className: 'dkb-discard', disabled: !dirty || saving, onClick: discard }, t('discard')),
          React.createElement('button', { type: 'button', className: 'dkb-save', disabled: !dirty || saving || !writable, onClick: save }, t('save')),
        ))
        body = rows
      }

      return React.createElement('li', { className: 'dkb-card dkb-cardOpen' },
        style, head, React.createElement('div', { className: 'dkb-body' }, body))
    }

    /** Стрелка влево для кнопки возврата: 14x14, обводка цветом текста. */
    const BACK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"'
      + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M10 3.5 5.5 8l4.5 4.5"/></svg>'

    // ------------------------------------------------------------ экран доски

    function TaskCard(props) {
      const { task, t, now } = props
      const ref = cardRef(task)
      const status = cardStatus(task)
      const waiting = task.waiting === true
      const plan = planLine(task, t)
      const state = task.state === 'queued'
        ? t('state.queued', { n: task.queuePos || 1 })
        : stateLabel(task, t)
      const pack = props.pack
      // Дата заведения, а не время в колонке. «Здесь 34 минуты» у задачи,
      // приехавшей подхватом полчаса назад, не значит ничего: это возраст
      // карточки на доске, а спрашивают про возраст самой задачи.
      const born = shortDate(task.createdAt)
      const touched = task.sessionId ? agoText(now, task.updatedAt, t) : ''
      const menu = props.menuOpen
      const urgent = priorityColor(task)
      const overdue = task.overdue === true
      return React.createElement('div', {
        className: 'dkb-taskCard' + (urgent ? ' dkb-urgent' : '')
          + (overdue ? ' dkb-overdue' : '')
          + (props.sameSession ? ' dkb-sameSession' : ''),
        onMouseEnter: () => { if (props.onHover) props.onHover(task.sessionId || '') },
        onMouseLeave: () => { if (props.onHover) props.onHover('') },
        style: urgent ? { borderLeftColor: urgent } : undefined,
        // Полный заголовок в подсказке: на карточке он обрезан двумя строками,
        // и прочитать его иначе можно было только открыв её.
        title: task.title,
        // Карточка становится точкой табуляции: доска была мышиной целиком, а
        // перенос теперь ещё и команда агенту — действие с последствиями.
        tabIndex: 0,
        draggable: true,
        onDragStart: (e) => {
          try { e.dataTransfer.setData('text/plain', task.id) } catch { /* не всякий носитель умеет */ }
          props.onDragStart(task)
        },
        onClick: () => props.onOpen(task),
      },
        // Шапка карточки: чей это проект и что за работа. Оба ответа нужны
        // раньше заголовка — по ним карточку и находят глазами в колонке.
        React.createElement('div', { className: 'dkb-taskHead' },
          React.createElement('input', {
            type: 'checkbox',
            className: 'dkb-pick' + (props.picked ? ' dkb-pickOn' : ''),
            checked: props.picked === true,
            title: t('card.pick'),
            onClick: (e) => e.stopPropagation(),
            onChange: () => props.onPick(task),
          }),
          waiting ? React.createElement('span', { className: 'dkb-waitDot' }) : null,
          waiting ? React.createElement('span', { className: 'dkb-waiting' }, t('board.waiting')) : null,
          taskRef(task, t),
          (task.labels || []).map((l) => React.createElement('span', {
            className: 'dkb-tag', key: l, style: tagStyle(task, l),
          }, l))),
        React.createElement('div', { className: 'dkb-taskTitle' }, task.title),
        plan ? React.createElement('div', { className: 'dkb-planLine' }, plan) : null,
        // Второй путь к переносу, не замена перетаскиванию: мышью удобнее,
        // когда мышь под рукой. Подтверждение и последствия у обоих те же —
        // разойтись им нельзя.
        React.createElement('div', { className: 'dkb-cardMenu' },
          React.createElement('button', {
            type: 'button', className: 'dkb-moveBtn',
            // Скрыто до наведения — но появляется и при фокусе с клавиатуры:
            // прятать ради красоты то, что чинили ради доступности, нельзя.
            'aria-expanded': menu === task.id,
            onClick: (e) => { e.stopPropagation(); props.onMenu(menu === task.id ? '' : task.id) },
          }, t('card.move')),
          menu === task.id
            ? React.createElement('div', { className: 'dkb-facetList' },
              (props.columns || []).filter((c) => c !== task.column).map((c) => React.createElement('button', {
                type: 'button', className: 'dkb-facetRow', key: c,
                onClick: (e) => { e.stopPropagation(); props.onMenu(''); props.onMove(task, c) },
              }, t('column.' + c))),
              // Очередь стоит рядом с переносом: и то и другое — «отдать
              // работу», разница лишь в том, кому и когда.
              // Останавливать нечего у того, кто не идёт: пункт, который
              // ничего не делает, хуже отсутствующего.
              task.state === 'stopped'
                ? React.createElement('button', {
                  type: 'button', className: 'dkb-facetRow', key: 'revive',
                  onClick: (e) => { e.stopPropagation(); props.onMenu(''); props.onRevive(task) },
                }, t('card.revive'))
                : null,
              task.state === 'running' || task.state === 'waiting'
                ? React.createElement('button', {
                  type: 'button', className: 'dkb-facetRow', key: 'stop',
                  onClick: (e) => { e.stopPropagation(); props.onMenu(''); props.onStop(task) },
                }, t('card.stop'))
                : null,
              task.state === 'queued'
                ? React.createElement('button', {
                  type: 'button', className: 'dkb-facetRow', key: 'unqueue',
                  onClick: (e) => { e.stopPropagation(); props.onMenu(''); props.onUnqueue(task) },
                }, t('card.unqueue'))
                : React.createElement('button', {
                  type: 'button', className: 'dkb-facetRow', key: 'queue',
                  onClick: (e) => { e.stopPropagation(); props.onMenu(''); props.onQueue(task) },
                }, t('card.queue')))
            : null,
        ),
        status || state || born || touched
          ? React.createElement('div', { className: 'dkb-taskRef' },
            state
              ? React.createElement('span', {
                className: 'dkb-state' + (task.state === 'running' ? ' dkb-stateLive' : ''),
              }, state)
              : null,
            // Ссылка в чат стоит рядом с отметкой работы: «идёт» без пути к
            // тому, что идёт, — сведение, которым нельзя воспользоваться.
            task.sessionId
              ? React.createElement('button', {
                type: 'button', className: 'dkb-toChat',
                onClick: (e) => { e.stopPropagation(); props.onOpenChat(task) },
              }, t('card.toChat'))
              : null,
            touched
              ? React.createElement('span', {
                className: task.stale ? 'dkb-countOver' : '',
                title: exactAt(task.updatedAt),
              }, touched)
              : null,
            born
              ? React.createElement('span', { title: exactAt(task.createdAt) }, born)
              : null,
            task.dueAt > 0
              ? React.createElement('span', {
                className: overdue ? 'dkb-dueOver' : '',
                title: exactAt(task.dueAt),
              }, t('card.due', { date: shortDate(task.dueAt) }))
              : null,
            task.assignee
              ? React.createElement('span', { className: 'dkb-who', title: t('card.assigneeHint') },
                '@' + task.assignee)
              : null,
            pack
              ? React.createElement('span', {
                className: 'dkb-pack', title: t('card.packHint'),
              }, t('card.pack', { at: pack.at, total: pack.total }))
              : null,
            status ? React.createElement('span', null, status) : null)
          : null,
      )
    }

    /**
     * Чем запускать: профиль агента и уровень доступа.
     *
     * Одни и те же поля стоят и в окне задачи, и в окне пачки — пачка идёт
     * ОДНОЙ сессией, значит и профиль с доступом у неё один. Две копии полей
     * разошлись бы при первой правке.
     *
     * Пустого списка не бывает наполовину: службы у ядра необязательны, и если
     * выбирать не из чего, поле не рисуется вовсе.
     */
    function LaunchFields(props) {
      const t = props.t
      const rows = []
      if (!props.hidePreset && (props.presets.agentPresets || []).length > 0) {
        rows.push(React.createElement('div', { className: 'dkb-field', key: 'preset' },
          React.createElement('span', { className: 'dkb-label' }, t('panel.agentPreset')),
          React.createElement('select', {
            className: 'dkb-input', value: props.agentPreset, disabled: props.disabled,
            onChange: (e) => props.onPreset(e.target.value),
          },
            React.createElement('option', { value: '' }, t('panel.presetDefault')),
            props.presets.agentPresets.map((one) => React.createElement('option', {
              value: one.id, key: one.id, title: one.description || '',
            }, one.name || one.id))),
        ))
      }
      if ((props.presets.access || []).length > 0) {
        const picked = (props.presets.access || []).find((one) => one.value === props.permission)
        rows.push(React.createElement('div', { className: 'dkb-field', key: 'access' },
          React.createElement('span', { className: 'dkb-label' }, t('panel.permission')),
          React.createElement('select', {
            className: 'dkb-input', value: props.permission, disabled: props.disabled,
            onChange: (e) => props.onPermission(e.target.value),
          }, props.presets.access.map((one) => React.createElement('option', {
            value: one.value, key: one.value,
          }, one.name || one.value))),
          // Пояснение к уровню доступа пишет ядро: свои слова разошлись бы с
          // тем, что этот уровень значит на самом деле.
          picked && picked.description
            ? React.createElement('p', { className: 'dkb-hint' }, picked.description)
            : null,
        ))
      }
      return rows.length === 0 ? null : React.createElement('div', { className: 'dkb-start' }, rows)
    }

    function BoardScreen(props) {
      const t = props.t || fallbackT
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [openTask, setOpenTask] = React.useState(null)
      const [log, setLog] = React.useState([])
      const [dialog, setDialog] = React.useState(null)
      // Черновик правки приоритета и меток в окне задачи. Живёт отдельно от
      // карточки: пока человек не нажал «Сохранить», доска не должна видеть
      // полувведённое.
      const [editPriority, setEditPriority] = React.useState('')
      const [editLabels, setEditLabels] = React.useState('')
      const [editDue, setEditDue] = React.useState('')
      const [overColumn, setOverColumn] = React.useState('')
      const [model, setModel] = React.useState('')
      const [provider, setProvider] = React.useState('')
      const [providers, setProviders] = React.useState([])
      const [models, setModels] = React.useState([])
      const [starting, setStarting] = React.useState(false)
      const [draftText, setDraftText] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [dropAt, setDropAt] = React.useState(null)
      const [board, setBoard] = React.useState('main')
      // Решения о сворачивании держим в состоянии экрана, а не в хранилище:
      // это взгляд одного человека на одну доску прямо сейчас, а не свойство
      // задач. Обновление доски их переживает, перезагрузка страницы — нет.
      const [collapsed, setCollapsed] = React.useState({})
      // Отборы живут в состоянии экрана: он смонтирован всё время работы
      // харнесса, поэтому выбор переживает и закрытие доски, и обновление.
      const [filters, setFilters] = React.useState({})
      const [openFacet, setOpenFacet] = React.useState('')
      const [cardMenu, setCardMenu] = React.useState('')
      const [body, setBody] = React.useState(null)
      const [groups, setGroups] = React.useState({})
      const [syncing, setSyncing] = React.useState(false)
      // Отмеченные для группового запуска. Живут отдельно от открытой карточки:
      // выбор переживает и открытие окна, и обновление доски.
      const [picked, setPicked] = React.useState({})
      const [archive, setArchive] = React.useState(null)
      const [metrics, setMetrics] = React.useState(null)
      // «Только ждущие» держим отдельно от отборов: это не значение измерения,
      // а взгляд «покажи, где стоит работа», и складывается он с любым отбором.
      const [onlyWaiting, setOnlyWaiting] = React.useState(false)
      const [onlyOverdue, setOnlyOverdue] = React.useState(false)
      const [hoverSession, setHoverSession] = React.useState('')
      const [order, setOrder] = React.useState('manual')
      // «По проектам» — как приходит с сервера; «по ответственному» — своя
      // раскладка поверх того же порядка.
      const [grouping, setGrouping] = React.useState('repo')
      // Кто «я»: спрашивается один раз у сервера. Пусто — Gitea не ответил, и
      // кнопку «Мои» рисовать нельзя: соврать числом хуже, чем не показать.
      const [me, setMe] = React.useState('')
      const [onlyMine, setOnlyMine] = React.useState(false)
      // Чем запускать: профиль агента и уровень доступа. Обе службы у ядра
      // необязательны, поэтому пустой список — не поломка, а «выбирать не из
      // чего»: поле тогда не рисуется вовсе.
      const [presets, setPresets] = React.useState({ agentPresets: [], access: [] })
      const [agentPreset, setAgentPreset] = React.useState('')
      const [permission, setPermission] = React.useState('')
      const dragged = React.useRef(null)

      const load = React.useCallback(async (nextBoard) => {
        try {
          // Отбор по репозиторию делает браузер вместе с остальными отборами:
          // серверный отбор спорил бы с ним и прятал бы часть значений из
          // списка, потому что их не было бы в ответе.
          const query = '?board=' + encodeURIComponent(nextBoard || 'main')
          setState(normalizeBoard(await api('/board' + query)))
          setError('')
        } catch (e) {
          setError(t(e.key || 'error.unknown'))
        }
      }, [t])

      React.useEffect(() => { load(board) }, [load, board])

      // Просьба чипа «покажи вот эту». Забираем её один раз: повтор открывал
      // бы окно снова после каждого закрытия.
      const [wanted, setWanted] = React.useState('')
      React.useEffect(() => {
        const toggle = props.toggle
        if (!toggle || typeof toggle.takeWanted !== 'function') return undefined
        const pull = () => {
          const asked = toggle.takeWanted()
          if (!asked || !asked.id) return
          setBoard(asked.board)
          setWanted(asked.id)
        }
        pull()
        return toggle.subscribe(pull)
      }, [props.toggle])

      // Открываем, когда задача приехала: доска могла переключаться, и в
      // момент просьбы её ещё не было в списке.
      React.useEffect(() => {
        if (wanted === '' || state === null) return
        const task = state.tasks.find((x) => x.id === wanted)
        if (task === undefined) return
        setWanted('')
        openPanelRef.current(task)
      }, [wanted, state])

      // Escape снимает по одному слою за нажатие: диалог, затем панель, затем
      // саму доску. Закрывать всё разом — терять контекст, которого человек не
      // просил лишаться.
      React.useEffect(() => {
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          if (dialog !== null) { setDialog(null); return }
          if (openTask !== null) { setOpenTask(null); return }
          if (props.onClose) props.onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [dialog, openTask, props])

      // Сначала провайдеры и текущий выбор, затем модели выбранного провайдера.
      React.useEffect(() => {
        let alive = true
        api('/models')
          .then((out) => {
            if (!alive || !out) return
            const list = out.providers || []
            setProviders(list)
            const saved = recallLaunch(board)
            const provider = stillOffered(saved.provider, list.map((p) => p.id), '')
            if (provider !== '') {
              setProvider(provider)
              // Модель проверяется своим списком, когда он приедет: здесь её
              // ещё не с чем сверить, а подставить чужую нельзя.
              setModel(typeof saved.model === 'string' ? saved.model : '')
            } else if (out.current) {
              setProvider(out.current.provider || '')
              setModel(out.current.model || '')
            }
          })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      React.useEffect(() => {
        let alive = true
        api('/whoami')
          .then((out) => { if (alive && out) setMe(typeof out.login === 'string' ? out.login : '') })
          .catch(() => {})
        api('/presets')
          .then((out) => {
            if (!alive || !out) return
            const rows = out.agentPresets || []
            const access = out.access || []
            setPresets({ agentPresets: rows, access })
            // Пустое значение — «как у харнесса по умолчанию»; подставляем его
            // же явно, чтобы человек видел, с чем задача пойдёт.
            const saved = recallLaunch(board)
            setAgentPreset(stillOffered(saved.agentPreset, rows.map((x) => x.id), out.agentPresetDefault || ''))
            setPermission(stillOffered(saved.permission, access.map((x) => x.value), out.accessDefault || ''))
          })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      React.useEffect(() => {
        let alive = true
        if (provider === '') { setModels([]); return () => { alive = false } }
        api('/models?provider=' + encodeURIComponent(provider))
          .then((out) => {
            if (!alive || !out) return
            const list = out.models || []
            setModels(list)
            // Модель могла исчезнуть у провайдера: подставленная из памяти, она
            // осталась бы в поле, а запуск отказал бы уже после нажатия.
            setModel((cur) => stillOffered(cur, list.map((m) => m.id), ''))
          })
          .catch(() => { if (alive) setModels([]) })
        return () => { alive = false }
      }, [provider])

      const commitMove = React.useCallback(async (task, column, where) => {
        // Карточку не перерисовываем заранее: до подтверждения она обязана
        // оставаться там, где лежала, иначе отмена выглядит откатом.
        try {
          await api('/task/' + encodeURIComponent(task.id) + '/move', {
            method: 'POST',
            body: JSON.stringify({ column, beforeId: where.beforeId, afterId: where.afterId }),
          })
          await load(board)
        } catch (e) {
          setError(t(e.key || 'error.unknown'))
          await load(board)
        }
      }, [load, t])

      /**
       * Спросить о переносе и, получив согласие, выполнить его.
       *
       * Общая для мыши и для меню на карточке: путь другой, последствия те же,
       * и разойтись им нельзя.
       */
      const askMove = React.useCallback((task, column, where) => {
        if (!task) return
        const place = where ?? neighboursFor(tasksOf((state && state.tasks) || [], column), task.id, Infinity)
        // Перенос внутри колонки — это порядок, а не команда: спрашивать не о чем.
        if (task.column === column) { commitMove(task, column, place); return }
        setDialog({ mode: 'move', task, column, where: place })
      }, [state, commitMove])

      const drop = React.useCallback((column, index) => {
        const task = dragged.current
        dragged.current = null
        setOverColumn('')
        setDropAt(null)
        if (!task || !state) return
        // Мышь слишком легко задевает карточку, чтобы перенос уходил без спроса.
        askMove(task, column, neighboursFor(tasksOf(state.tasks, column), task.id, index))
      }, [state, askMove])

      const openPanelRef = React.useRef(() => {})
      const openPanel = React.useCallback(async (task) => {
        setOpenTask(task)
        setDraftText('')
        setBody(null)
        setEditPriority(typeof task?.priority === 'string' ? task.priority : '')
        setEditLabels(Array.isArray(task?.labels) ? task.labels.join(', ') : '')
        setEditDue(typeof task?.dueAt === 'number' && task.dueAt > 0
          ? new Date(task.dueAt).toISOString().slice(0, 10)
          : '')
        api('/task/' + encodeURIComponent(task.id) + '/body')
          .then((out) => setBody((out && out.blocks) || []))
          .catch(() => setBody([]))
        api('/task/' + encodeURIComponent(task.id) + '/message')
          .then((out) => setDraftText((out && out.text) || ''))
          .catch(() => setDraftText(''))
        try {
          const out = await api('/task/' + encodeURIComponent(task.id) + '/log')
          setLog(out.transitions || [])
        } catch { setLog([]) }
      }, [])
      openPanelRef.current = openPanel

      const style = React.createElement('style', null, css)

      if (state === null) {
        return React.createElement('div', { className: 'dkb-screen' }, style,
          React.createElement('p', { className: 'dkb-note' }, error || t('board.loading')))
      }

      const boards = (state && state.boards) || []
      const bar = React.createElement('div', { className: 'dkb-bar' },
        // Первой в шапке и слева от заголовка — там она читается как «назад».
        // Своего механизма закрытия не заводит: их уже три (Escape, повторный
        // щелчок по боковой строке, переход в чужую сессию), и четвёртый
        // разошёлся бы с ними при первой же правке.
        React.createElement('button', {
          type: 'button', className: 'dkb-back', title: t('board.backHint'),
          onClick: () => { if (props.onClose) props.onClose() },
        },
          React.createElement('span', {
            className: 'dkb-backIcon',
            dangerouslySetInnerHTML: { __html: BACK_ICON },
          }),
          React.createElement('span', null, t('board.back')),
        ),
        React.createElement('span', { className: 'dkb-barTitle' }, t('section.label')),
        boards.length > 1
          ? React.createElement('select', {
            className: 'dkb-input', style: { width: 'auto' }, value: board,
            onChange: (e) => {
              // Отборы собраны из меток ЭТОЙ доски: на другой те же значения
              // могут не встречаться вовсе, и выбор превратился бы в пустоту.
              setOpenTask(null); setCollapsed({}); setFilters({}); setBoard(e.target.value)
            },
          }, boards.map((b) => React.createElement('option', { value: b.id, key: b.id }, boardTitle(b, t))))
          : null,
        (state.facets || []).map((facet) => {
          const picked = filters[facet.ns] || []
          // Имена пространств приходят из Gitea сырыми. Известные переводим,
          // незнакомое оставляем как есть: выдумывать перевод метке, которую
          // завели вчера, доска не вправе.
          const label = facetLabel(facet.ns, t)
          return React.createElement('div', { className: 'dkb-facet', key: facet.ns },
            React.createElement('button', {
              type: 'button',
              className: 'dkb-facetHead' + (picked.length ? ' dkb-facetOn' : ''),
              'aria-expanded': openFacet === facet.ns,
              onClick: () => setOpenFacet((cur) => (cur === facet.ns ? '' : facet.ns)),
            }, picked.length ? label + ' · ' + picked.length : label),
            openFacet === facet.ns
              ? React.createElement('div', { className: 'dkb-facetList' },
                facet.values.map((v) => React.createElement('label', {
                  className: 'dkb-facetRow', key: v.value,
                },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: picked.indexOf(v.value) >= 0,
                    onChange: () => setFilters((cur) => toggleValue(cur, facet.ns, v.value)),
                  }),
                  React.createElement('span', { className: 'dkb-facetName' }, v.value),
                  React.createElement('span', { className: 'dkb-count' }, String(v.count)),
                )))
              : null,
          )
        }),
        (() => {
          // Ноль в шапке — мебель, за которой перестают следить, поэтому
          // счётчик появляется только когда кого-то действительно ждут.
          const waiting = state.tasks.filter((x) => x.state === 'waiting').length
          if (waiting === 0) return null
          return React.createElement('button', {
            type: 'button',
            className: 'dkb-waitCount' + (onlyWaiting ? ' dkb-save' : ''),
            title: t('board.waitCountHint'),
            onClick: () => setOnlyWaiting((cur) => !cur),
          }, t('board.waitCount', { n: waiting }))
        })(),
        (() => {
          // Просроченные — те, чей дедлайн уже прошёл. Счётчик появляется
          // только когда такие есть: ноль в шапке — мебель.
          const overdue = state.tasks.filter((x) => x.overdue === true).length
          if (overdue === 0) return null
          return React.createElement('button', {
            type: 'button',
            className: 'dkb-waitCount' + (onlyOverdue ? ' dkb-save' : ''),
            title: t('board.overdueHint'),
            onClick: () => setOnlyOverdue((cur) => !cur),
          }, t('board.overdueCount', { n: overdue }))
        })(),
        (() => {
          // Ноль своих задач — кнопки нет: пустой счётчик в шапке перестают
          // замечать вместе с непустым.
          if (me === '') return null
          const mine = state.tasks.filter((x) => x.assignee === me).length
          if (mine === 0) return null
          return React.createElement('button', {
            type: 'button',
            className: 'dkb-waitCount' + (onlyMine ? ' dkb-save' : ''),
            title: t('board.mineHint', { who: me }),
            onClick: () => setOnlyMine((cur) => !cur),
          }, t('board.mine', { n: mine }))
        })(),
        React.createElement('select', {
          className: 'dkb-input', style: { width: 'auto' }, value: grouping,
          onChange: (e) => setGrouping(e.target.value),
        },
          React.createElement('option', { value: 'repo' }, t('group.repo')),
          React.createElement('option', { value: 'assignee' }, t('group.assignee')),
        ),
        React.createElement('select', {
          className: 'dkb-input', style: { width: 'auto' }, value: order,
          onChange: (e) => setOrder(e.target.value),
        },
          React.createElement('option', { value: 'manual' }, t('order.manual')),
          React.createElement('option', { value: 'old' }, t('order.old')),
          React.createElement('option', { value: 'new' }, t('order.new')),
        ),
        React.createElement('button', {
          type: 'button', className: metrics ? 'dkb-save' : 'dkb-discard',
          onClick: async () => {
            if (metrics) { setMetrics(null); return }
            try {
              setArchive(null)
              setMetrics(await api('/metrics?board=' + encodeURIComponent(board)))
            } catch (e) { setError(t(e.key || 'error.unknown')) }
          },
        }, t('board.metrics')),
        React.createElement('button', {
          type: 'button', className: archive ? 'dkb-save' : 'dkb-discard',
          onClick: async () => {
            if (archive) { setArchive(null); return }
            try {
              setMetrics(null)
              const out = await api('/archive')
              setArchive(Array.isArray(out.tasks) ? out.tasks : [])
            } catch (e) { setError(t(e.key || 'error.unknown')) }
          },
        }, t('board.archive')),
        // Экспорт скачивает полный снимок доски; импорт восстанавливает его.
        React.createElement('button', {
          type: 'button', className: 'dkb-discard',
          title: t('board.exportHint'),
          onClick: async () => {
            try {
              const out = await api('/snapshot')
              const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = 'kanban-' + new Date().toISOString().slice(0, 10) + '.json'
              a.click()
              URL.revokeObjectURL(url)
            } catch (e) { setError(t(e.key || 'error.unknown')) }
          },
        }, t('board.export')),
        React.createElement('label', { className: 'dkb-discard dkb-import' },
          t('board.import'),
          React.createElement('input', {
            type: 'file', accept: 'application/json,.json', style: { display: 'none' },
            onChange: async (e) => {
              const file = e.target.files && e.target.files[0]
              e.target.value = ''
              if (!file) return
              try {
                const input = JSON.parse(await file.text())
                const out = await api('/snapshot', { method: 'POST', body: JSON.stringify(input) })
                setError(out.error ? t('error.' + out.error) : t('board.imported', { n: out.imported }))
                await load(board)
              } catch { setError(t('error.badImport')) }
            },
          })),
        // «Показано 12 из 81» появляется, только когда что-то отобрано или
        // введён поиск: на нетронутой доске эта строка была бы шумом.
        anySelected(filters) || query.trim() !== ''
          ? React.createElement('span', { className: 'dkb-shown' }, t('board.shown', {
            shown: state.tasks.filter((x) => matchesFilters(x, filters) && matchesQuery(x, query)).length,
            total: state.tasks.length,
          }))
          : null,
        anySelected(filters)
          ? React.createElement('button', {
            type: 'button', className: 'dkb-discard',
            onClick: () => { setFilters({}); setOpenFacet('') },
          }, t('board.clearFilters'))
          : null,
        React.createElement('input', {
          className: 'dkb-search', value: query, placeholder: t('board.search'),
          onChange: (e) => setQuery(e.target.value),
        }),
        (() => {
          // Пока запрос в пути, состояние на доске ещё вчерашнее: оно приедет
          // только со следующим ответом. Поэтому ход показываем сами, а не
          // ждём, когда сервер расскажет о нём задним числом.
          const line = syncing
            ? { tone: 'idle', text: t('sync.running'), title: '' }
            : syncLine(state.sync, state.now, t)
          return React.createElement('span', {
            className: 'dkb-sync' + (line.tone === 'bad' ? ' dkb-syncBad' : ''),
            title: line.title,
          }, line.text)
        })(),
        React.createElement('button', {
          type: 'button', className: 'dkb-discard', disabled: syncing,
          onClick: async () => {
            // Кнопка гаснет на время прохода: нажать её второй раз значило бы
            // попросить сверку, которая и так идёт, а сервер ответил бы
            // «пропущено» — и человек решил бы, что ничего не случилось.
            setSyncing(true)
            try {
              await api('/sync', { method: 'POST', body: '{}' })
              await load(board)
            } catch (e) {
              setError(t(e.key || 'error.unknown'))
            } finally {
              setSyncing(false)
            }
          },
        }, syncing ? t('board.syncing') : t('board.sync')),
        React.createElement('button', { type: 'button', className: 'dkb-discard', onClick: () => load(board) }, t('board.refresh')),
        // Полоса выбора появляется, только когда что-то отмечено: на пустом
        // выборе она была бы мебелью.
        Object.keys(picked).length > 0
          ? React.createElement('span', { className: 'dkb-shown' },
            t('board.pickedCount', { n: Object.keys(picked).length }))
          : null,
        Object.keys(picked).length > 0
          ? React.createElement('button', {
            type: 'button', className: 'dkb-discard',
            onClick: () => setPicked({}),
          }, t('board.pickNone'))
          : null,
        Object.keys(picked).length > 0
          ? React.createElement('button', {
            type: 'button', className: 'dkb-save',
            onClick: () => setDialog({
              mode: 'batch',
              ids: Object.keys(picked),
              provider: '', model: '', text: '', error: '',
            }),
          }, t('board.pickStart'))
          : null,
        Object.keys(picked).length > 0
          ? React.createElement('button', {
            type: 'button', className: 'dkb-discard',
            onClick: async () => {
              const ids = Object.keys(picked)
              const out = await applyToEach(ids, (id) => api(
                '/task/' + encodeURIComponent(id) + '/archive', { method: 'POST', body: '{}' },
              ))
              // Часть задач архивировать нельзя (архив только из «Выполнено»),
              // и число отказов называется вслух.
              if (out.failed > 0) setError(t('board.someFailed', { done: out.done, total: ids.length }))
              else setPicked({})
              await load(board)
            },
          }, t('board.pickArchive'))
          : null,
        Object.keys(picked).length > 0
          ? React.createElement('button', {
            type: 'button', className: 'dkb-discard',
            onClick: async () => {
              const ids = Object.keys(picked)
              const out = await applyToEach(ids, (id) => api(
                '/task/' + encodeURIComponent(id) + '/unqueue', { method: 'POST', body: '{}' },
              ))
              if (out.failed > 0) setError(t('board.someFailed', { done: out.done, total: ids.length }))
              else setPicked({})
              await load(board)
            },
          }, t('board.pickUnqueue'))
          : null,
        Object.keys(picked).length > 0
          ? React.createElement('select', {
            className: 'dkb-input', style: { width: 'auto' }, value: '',
            onChange: async (e) => {
              const column = e.target.value
              if (column === '') return
              const ids = Object.keys(picked)
              // Групповой перенос — та же команда агенту, что и одиночный:
              // маршрут один, и последствия у него те же.
              const out = await applyToEach(ids, (id) => api(
                '/task/' + encodeURIComponent(id) + '/move',
                { method: 'POST', body: JSON.stringify({ column }) },
              ))
              if (out.failed > 0) setError(t('board.someFailed', { done: out.done, total: ids.length }))
              else setPicked({})
              await load(board)
            },
          },
            React.createElement('option', { value: '' }, t('board.pickMove')),
            (state.columns || []).map((c) => React.createElement('option', {
              value: c.id, key: c.id,
            }, columnTitle(c, t))),
          )
          : null,
        React.createElement('button', { type: 'button', className: 'dkb-save', onClick: () => setDialog({ mode: 'own', project: false, repo: '', newRepo: '', title: '', full: '', repos: null, issues: null, error: '' }) }, t('board.newTask')),
      )

      // Счётчик колонки считает ВСЕ карточки, а не найденные: иначе поиск
      // сделал бы вид, что предел колонки соблюдён.
      const packs = packInfo(state.tasks)
      const columns = React.createElement('div', { className: 'dkb-cols' },
        state.columns.map((col) => {
          // Счётчик колонки считает ОТОБРАННОЕ, а поиск — нет.
          //
          // Разница осмысленная, а не недосмотр: поиск временный, и предел
          // «3 из 3» при найденной одной карточке врал бы. Отбор постоянный, и
          // на отборе по одному проекту «в работе 3 из 3» должно значить «по
          // этому проекту» — иначе предел ни о чём.
          const all = tasksOf(state.tasks, col.id).filter((task) => matchesFilters(task, filters))
          const items = sortTasks(
            all.filter((task) => matchesQuery(task, query))
              .filter((task) => !onlyWaiting || task.state === 'waiting')
              .filter((task) => !onlyOverdue || task.overdue === true)
              .filter((task) => !onlyMine || task.assignee === me),
            order,
          )
          // Ключ группы решает переключатель: заголовки, сворачивание и
          // счётчики остаются те же, меняется только по чему делим.
          const groupKeyOf = (task) => (grouping === 'assignee'
            ? (task.assignee || '')
            : (task.repo || ''))
          const ordered = grouping === 'assignee'
            ? groupByAssignee(items).flatMap((one) => one.tasks)
            : items
          const limit = col.limit
          const overLimit = limit !== undefined && limit !== null && all.length > limit
          const slot = (index) => React.createElement('div', {
            className: 'dkb-slot' + (dropAt && dropAt.column === col.id && dropAt.index === index ? ' dkb-slotOn' : ''),
            key: 's' + index,
            onDragOver: (e) => {
              e.preventDefault(); e.stopPropagation()
              setOverColumn(col.id)
              setDropAt({ column: col.id, index })
            },
            onDrop: (e) => { e.preventDefault(); e.stopPropagation(); drop(col.id, index) },
          })

          const rows = []
          rows.push(slot(0))
          // Заголовок рисуем при смене проекта. Задачи приходят уже
          // разложенными, поэтому группы идут подряд и разрываться не могут.
          let group = null
          const sizes = new Map()
          for (const x of ordered) sizes.set(groupKeyOf(x), (sizes.get(groupKeyOf(x)) || 0) + 1)
          const manyGroups = sizes.size > 1

          ordered.forEach((task, i) => {
            const repo = groupKeyOf(task)
            if (manyGroups && repo !== group) {
              group = repo
              const shut = groups[col.id + '/' + repo] === true
              rows.push(React.createElement('button', {
                type: 'button', className: 'dkb-groupHead', key: 'g' + repo,
                'aria-expanded': !shut,
                onClick: () => setGroups((cur) => Object.assign({}, cur, { [col.id + '/' + repo]: !shut })),
              },
                React.createElement('span', null,
                  repo || t(grouping === 'assignee' ? 'group.nobody' : 'board.noRepo')),
                // Счётчик виден и у свёрнутой: группа с работой, выглядящая
                // пустой, — то же зло, что и свёрнутая колонка без числа.
                React.createElement('span', { className: 'dkb-groupCount' }, String(sizes.get(repo))),
              ))
            }
            if (manyGroups && groups[col.id + '/' + (task.repo || '')] === true) return
            rows.push(React.createElement(TaskCard, {
              key: task.id, task, t, now: state.now,
              columns: (state.columns || []).map((c) => c.id),
              menuOpen: cardMenu,
              onMenu: setCardMenu,
              picked: picked[task.id] === true,
              onPick: (x) => setPicked((cur) => {
                const next = Object.assign({}, cur)
                if (next[x.id]) delete next[x.id]
                else next[x.id] = true
                return next
              }),
              pack: packs[task.id],
              sameSession: hoverSession !== '' && task.sessionId === hoverSession,
              onHover: setHoverSession,
              onRevive: async (x) => {
                // Переиспользуем обычный запуск: он сам пробует возобновить
                // прежнюю сессию и только потом заводит новую. Здесь важно
                // сказать, что именно вышло.
                try {
                  const out = await api('/task/' + encodeURIComponent(x.id) + '/start', {
                    method: 'POST', body: JSON.stringify({ revive: true }),
                  })
                  setError(t(out && out.mode === 'created' ? 'revive.fresh' : 'revive.same'))
                  await load(board)
                } catch (e) { setError(t(e.key || 'error.unknown')) }
              },
              onStop: async (x) => {
                try {
                  const out = await api('/task/' + encodeURIComponent(x.id) + '/stop', { method: 'POST', body: '{}' })
                  // «Остановлено» и «он и так стоял» — разные ответы, и второй
                  // нельзя выдавать за первый.
                  if (out && out.acted !== 'stopped') setError(t('stop.' + out.acted))
                  await load(board)
                } catch (e) { setError(t(e.key || 'error.unknown')) }
              },
              onMove: (x, column) => askMove(x, column),
              onQueue: async (x) => {
                try {
                  const out = await api('/sessions')
                  const live = (out && out.sessions) || []
                  // Живых сессий нет — ставить некуда, и сказать об этом надо
                  // сразу, а не показывать пустой список.
                  if (live.length === 0) { setError(t('error.no-live-sessions')); return }
                  setDialog({ mode: 'queue', task: x, sessions: live, sessionId: live[0].sessionId, error: '' })
                } catch (e) { setError(t(e.key || 'error.unknown')) }
              },
              onUnqueue: async (x) => {
                try {
                  await api('/task/' + encodeURIComponent(x.id) + '/unqueue', { method: 'POST', body: '{}' })
                  await load(board)
                } catch (e) { setError(t(e.key || 'error.unknown')) }
              },
              onOpenChat: (x) => {
                if (!openSession(props.ctx, x.sessionId)) {
                  setError(t('error.sessionNotOpened', { id: x.sessionId }))
                  return
                }
                if (props.onClose) props.onClose()
              },
              onDragStart: (x) => { dragged.current = x },
              onOpen: openPanel,
            }))
            rows.push(slot(i + 1))
          })

          const shut = isCollapsed({ id: col.id, count: all.length }, collapsed)
          const toggle = () => setCollapsed((prev) => Object.assign({}, prev, { [col.id]: !shut }))
          const count = limit !== undefined && limit !== null
            ? all.length + ' / ' + t('board.limit', { n: limit })
            : String(all.length)

          return React.createElement('div', {
            className: 'dkb-col'
              + (overColumn === col.id ? ' dkb-colOver' : '')
              + (shut ? ' dkb-colShut' : ''),
            key: col.id,
            // Свёрнутая колонка остаётся целью переноса: иначе карточку было бы
            // некуда положить, не развернув её сперва.
            onDragOver: (e) => { e.preventDefault(); setOverColumn(col.id) },
            onDragLeave: () => { setOverColumn(''); setDropAt(null) },
            onDrop: (e) => { e.preventDefault(); drop(col.id, items.length) },
          },
            React.createElement('button', {
              type: 'button', className: 'dkb-colHead',
              'aria-expanded': !shut,
              title: t(shut ? 'board.expand' : 'board.collapse'),
              onClick: toggle,
            },
              React.createElement('span', { className: 'dkb-dot', 'data-col': col.id }),
              React.createElement('span', { className: 'dkb-colName' }, columnTitle(col, t)),
              // Число карточек видно и в свёрнутом виде: колонка с работой,
              // выглядящая пустой, — худшее, что может сделать сворачивание.
              React.createElement('span', {
                className: 'dkb-count' + (overLimit ? ' dkb-countOver' : ''),
                'data-col': col.id,
              }, count),
            ),
            shut ? null : React.createElement('div', { className: 'dkb-list' },
              all.length === 0
                ? React.createElement('div', { className: 'dkb-empty' }, t('board.empty'))
                : items.length === 0
                  ? React.createElement('div', { className: 'dkb-empty' }, t('board.noMatch'))
                  : null,
              rows,
            ),
          )
        }),
      )

      // Окно, а не панель справа: в 420 пикселей помещались описание и журнал,
      // но не план с отметками. Живёт внутри экрана доски — сама доска лежит в
      // колонке разговора, и выход за её пределы наложился бы на чужие части
      // оболочки.
      const panel = openTask
        ? React.createElement('div', {
          className: 'dkb-modal',
          onClick: () => setOpenTask(null),
        }, React.createElement('div', {
          className: 'dkb-panel',
          role: 'dialog', 'aria-modal': 'true',
          onClick: (e) => e.stopPropagation(),
        },
          // Шапка: чьё это, что за работа, и лишь потом название. Тот же
          // порядок, что на карточке, — глаз не должен переучиваться.
          React.createElement('div', { className: 'dkb-row' },
            React.createElement('div', { className: 'dkb-taskHead', style: { flex: 1 } },
              taskRef(openTask, t),
              (openTask.labels || []).map((l) => React.createElement('span', {
                className: 'dkb-tag', key: l, style: tagStyle(openTask, l),
              }, l))),
            React.createElement('button', {
              type: 'button', className: 'dkb-discard', onClick: () => setOpenTask(null),
            }, t('panel.close')),
          ),
          React.createElement('div', { className: 'dkb-title' }, openTask.title),
          React.createElement('div', { className: 'dkb-note' },
            t('panel.created', { ago: agoText(state.now, openTask.createdAt, t) })
              + (openTask.assignee ? ' · ' + t('panel.assignee', { who: openTask.assignee }) : '')
              // Автор стоит рядом с датой заведения: это одно событие — кто и
              // когда завёл, — и разносить его по разным углам незачем.
              + (openTask.author ? ' · ' + t('panel.author', { who: openTask.author }) : ''),
            ' · ',
            t('panel.updated', { ago: agoText(state.now, openTask.updatedAt, t) }),
            openTask.issueUrl
              ? React.createElement('a', {
                className: 'dkb-issueLink', href: openTask.issueUrl,
                target: '_blank', rel: 'noreferrer noopener',
              }, ' · ' + t('panel.issue') + ' ↗')
              : null),
          // Пустое тело — отсутствие раздела, а не пустой раздел с заголовком.
          body === null
            ? React.createElement('p', { className: 'dkb-note' }, t('panel.bodyLoading'))
            : body.length === 0
              ? null
              : React.createElement('div', { className: 'dkb-mdBody' }, renderBlocks(body)),
          // Приоритет и метки — локальное свойство доски: правятся здесь, а не
          // в Gitea. У задач из issue метки приезжают сверкой, но приоритет
          // всегда свой.
          React.createElement('div', { className: 'dkb-edit' },
            React.createElement('div', { className: 'dkb-field' },
              React.createElement('span', { className: 'dkb-label' }, t('panel.priority')),
              React.createElement('select', {
                className: 'dkb-input', value: editPriority,
                onChange: (e) => setEditPriority(e.target.value),
              },
                React.createElement('option', { value: '' }, t('panel.priorityNone')),
                ['high', 'medium', 'low'].map((p) => React.createElement('option', { value: p, key: p }, t('priority.' + p)))),
            ),
            React.createElement('div', { className: 'dkb-field' },
              React.createElement('span', { className: 'dkb-label' }, t('panel.labels')),
              React.createElement('input', {
                className: 'dkb-input', value: editLabels,
                placeholder: t('dialog.labelsHint'),
                onChange: (e) => setEditLabels(e.target.value),
              }),
            ),
            React.createElement('div', { className: 'dkb-field' },
              React.createElement('span', { className: 'dkb-label' }, t('panel.due')),
              React.createElement('input', {
                type: 'date', className: 'dkb-input', value: editDue,
                onChange: (e) => setEditDue(e.target.value),
              }),
            ),
            React.createElement('button', {
              type: 'button', className: 'dkb-save', style: { alignSelf: 'flex-start' },
              onClick: async () => {
                try {
                  const labels = editLabels.split(',').map((s) => s.trim()).filter(Boolean)
                  // Пустая дата снимает дедлайн (0); заполненная — полночь
                  // этого дня по местному времени.
                  const dueAt = editDue === ''
                    ? 0
                    : new Date(editDue + 'T00:00:00').getTime()
                  const out = await api('/task/' + encodeURIComponent(openTask.id) + '/update', {
                    method: 'POST',
                    body: JSON.stringify({ priority: editPriority, labels, dueAt }),
                  })
                  setOpenTask(out.task)
                  await load(board)
                } catch (e) { setError(t(e.key || 'error.unknown')) }
              },
            }, t('panel.saveEdit')),
          ),
          // Взять и отдать — одна кнопка в двух состояниях: держать рядом
          // «взять» и «отказаться» значит предлагать бессмысленное действие.
          React.createElement('button', {
            type: 'button', className: 'dkb-discard', style: { alignSelf: 'flex-start' },
            onClick: async () => {
              const mine = openTask.assignee !== '' && openTask.assignee !== undefined
              try {
                const out = await api('/task/' + encodeURIComponent(openTask.id) + '/assign', {
                  method: 'POST',
                  body: JSON.stringify({ login: mine ? '' : 'me' }),
                })
                if (out && out.task) setOpenTask(out.task)
                await load(board)
              } catch (e) { setError(t(e.key || 'error.unknown')) }
            },
          }, openTask.assignee ? t('panel.assignDrop') : t('panel.assignMe')),
          openTask.sessionId
            ? React.createElement('button', {
              type: 'button', className: 'dkb-discard', style: { alignSelf: 'flex-start' },
              onClick: () => {
                // Тот же путь, что и сразу после запуска: задача, идущая
                // вторые сутки, иначе ищется в общем списке по имени вида
                // kanban-9e84cae6-…
                if (!openSession(props.ctx, openTask.sessionId)) {
                  setError(t('error.sessionNotOpened', { id: openTask.sessionId }))
                  return
                }
                setOpenTask(null)
                if (props.onClose) props.onClose()
              },
            }, t('panel.openChat'))
            : null,
          log.length
            ? React.createElement('div', null,
              React.createElement('div', { className: 'dkb-group' }, t('panel.log')),
              React.createElement('ul', { className: 'dkb-log' }, log.map((row) => React.createElement('li', {
                className: 'dkb-logRow', key: row.id,
              }, `${t('column.' + row.toCol)} ← ${row.source}${row.detail ? ' · ' + row.detail : ''}`))))
            : null,
          openTask.plan && openTask.plan.items && openTask.plan.items.length
            ? React.createElement('div', null,
              React.createElement('div', { className: 'dkb-group' }, t('plan.title')),
              React.createElement('p', { className: 'dkb-hint' }, planLine(openTask, t)),
              React.createElement('ul', { className: 'dkb-planList' },
                openTask.plan.items.map((item, i) => React.createElement('li', {
                  key: i,
                  className: 'dkb-planItem'
                    + (item.done ? ' dkb-planDone' : '')
                    + (item.active ? ' dkb-planActive' : ''),
                },
                  React.createElement('span', { className: 'dkb-planMark' },
                    item.done ? '✓' : item.active ? '▸' : '·'),
                  React.createElement('span', null, item.text),
                ))),
            )
            : null,
          openTask.archivedAt
            ? React.createElement('button', {
              type: 'button', className: 'dkb-save', style: { alignSelf: 'flex-start' },
              // Запускать работу по архивной задаче нечего: сперва она
              // возвращается на доску, и это одно нажатие.
              onClick: async () => {
                try {
                  await api('/task/' + encodeURIComponent(openTask.id) + '/restore', { method: 'POST', body: '{}' })
                  setArchive((cur) => (cur || []).filter((x) => x.id !== openTask.id))
                  setOpenTask(null)
                  await load(board)
                } catch (e) { setError(t(e.key || 'error.unknown')) }
              },
            }, t('archive.restore'))
            : React.createElement('div', { className: 'dkb-start' },
          React.createElement('div', { className: 'dkb-group' },
            openTask.sessionId ? t('panel.continue') : t('panel.start')),
          React.createElement('p', { className: 'dkb-hint' },
            openTask.sessionId ? t('panel.continueHint') : t('panel.startHint')),
          // Корень не задан настройкой — сессия пойдёт в рабочей папке
          // харнесса. Молчать об этом нельзя: человек иначе узнает, где
          // оказался агент, только из его первых слов. Показываем фактический
          // корень, который приехал с доской.
          !openTask.sessionId && state && !state.projectRoot.set && state.projectRoot.path !== ''
            ? React.createElement('p', { className: 'dkb-hint dkb-workdir' },
                t('panel.workDir', { path: state.projectRoot.path }),
                React.createElement('br'),
                t('panel.workDirHint'))
            : null,
          React.createElement(LaunchFields, {
            t, presets, agentPreset, permission, disabled: starting,
            onPreset: setAgentPreset, onPermission: setPermission,
            // У идущей сессии профиль уже выбран: сменить его нельзя, а
            // показывать поле, которое ничего не меняет, — врать.
            hidePreset: Boolean(openTask.sessionId),
          }),
          React.createElement('div', { className: 'dkb-field' },
            React.createElement('span', { className: 'dkb-label' }, t('panel.provider')),
            React.createElement('select', {
              className: 'dkb-input', value: provider, disabled: starting || providers.length === 0,
              onChange: (e) => { setProvider(e.target.value); setModel('') },
            },
              React.createElement('option', { value: '' },
                providers.length === 0 ? t('panel.noProviders') : t('panel.pickProvider')),
              providers.map((p) => React.createElement('option', { value: p.id, key: p.id }, p.name)),
            ),
          ),
          React.createElement('div', { className: 'dkb-field' },
            React.createElement('span', { className: 'dkb-label' }, t('panel.model')),
            React.createElement('select', {
              className: 'dkb-input', value: model,
              disabled: starting || provider === '' || models.length === 0,
              onChange: (e) => setModel(e.target.value),
            },
              React.createElement('option', { value: '' },
                provider === '' ? t('panel.pickProviderFirst')
                  : models.length === 0 ? t('panel.noModels') : t('panel.pickModel')),
              models.map((m) => React.createElement('option', { value: m.id, key: m.id }, m.name)),
            ),
          ),
          React.createElement('div', { className: 'dkb-field' },
            React.createElement('span', { className: 'dkb-label' }, t('panel.message')),
            React.createElement('textarea', {
              className: 'dkb-area', value: draftText, disabled: starting,
              onChange: (e) => setDraftText(e.target.value),
            }),
            React.createElement('p', { className: 'dkb-hint' }, t('panel.messageHint')),
          ),
          // Опасное слева, обычное справа, всё в одной полосе. Отдельная строка
          // под «Удалить» съедала высоту окна ради одной кнопки, которую
          // нажимают раз в жизни.
          React.createElement('div', { className: 'dkb-foot dkb-footSplit' },
            React.createElement('div', { className: 'dkb-footLeft' },
            React.createElement('button', {
              type: 'button', className: 'dkb-danger',
              onClick: async () => {
                // Подтверждение обязательно: удаление карточки необратимо, а
                // сама кнопка стоит рядом с безобидными.
                if (!window.confirm(t('panel.deleteConfirm', { title: openTask.title }))) return
                try {
                  await api('/task/' + encodeURIComponent(openTask.id), { method: 'DELETE' })
                  setOpenTask(null)
                  await load(board)
                } catch (e) {
                  setError(t(e.key || 'error.unknown'))
                }
              },
            }, t('panel.delete')),
            openTask.column === 'done'
              ? React.createElement('button', {
                type: 'button', className: 'dkb-discard',
                onClick: async () => {
                  try {
                    await api('/task/' + encodeURIComponent(openTask.id) + '/archive', { method: 'POST', body: '{}' })
                    setOpenTask(null)
                    await load(board)
                  } catch (e) { setError(t(e.key || 'error.unknown')) }
                },
              }, t('panel.archive'))
              : null,
          
            ),
            React.createElement('button', {
              type: 'button', className: 'dkb-save', disabled: starting || model === '',
              onClick: async () => {
                // Кнопка блокируется на время запроса: двойное нажатие подняло
                // бы две сессии по одной задаче.
                setStarting(true)
                try {
                  rememberLaunch(board, { provider, model, agentPreset, permission })
                  const out = await api('/task/' + encodeURIComponent(openTask.id) + '/start', {
                    method: 'POST',
                    body: JSON.stringify({ provider, model, text: draftText, agentPreset, permission }),
                  })
                  setOpenTask(null)
                  await load(board)
                  // Сессия поднята — но пока её не открыли, для человека
                  // «ничего не произошло»: он остаётся на доске и не видит
                  // чата, ради которого нажимал.
                  if (!openSession(props.ctx, out && out.sessionId)) {
                    setError(t('error.sessionNotOpened', { id: (out && out.sessionId) || '' }))
                    return
                  }
                  if (props.onClose) props.onClose()
                } catch (e) {
                  setError(t(e.key || 'error.unknown'))
                } finally {
                  setStarting(false)
                }
              },
            }, starting ? t('panel.starting')
              : openTask.sessionId ? t('panel.continue') : t('panel.start')),
          ),
            ),
        ))
        : null

      const moveDialogEl = dialog && dialog.mode === 'move'
        ? React.createElement('div', { className: 'dkb-dialog', onClick: () => setDialog(null) },
          React.createElement('div', { className: 'dkb-dialogBox', onClick: (e) => e.stopPropagation() },
            React.createElement('span', { className: 'dkb-title' },
              t('move.title', { column: t('column.' + dialog.column) })),
            React.createElement('p', { className: 'dkb-note' },
              cardRef(dialog.task) ? cardRef(dialog.task) + ' · ' + dialog.task.title : dialog.task.title),
            React.createElement('p', { className: 'dkb-hint' }, t('move.' + dialog.column)),
            React.createElement('div', { className: 'dkb-row' },
              React.createElement('button', {
                type: 'button', className: 'dkb-discard', onClick: () => setDialog(null),
              }, t('dialog.cancel')),
              React.createElement('button', {
                type: 'button', className: 'dkb-save',
                onClick: () => {
                  const d = dialog
                  setDialog(null)
                  commitMove(d.task, d.column, d.where)
                },
              }, t('move.confirm')),
            ),
          ))
        : null

      // Групповой запуск. Провайдер и модель спрашиваем один раз на всю пачку:
      // сессия одна, значит и модель одна.
      const batchEl = dialog && dialog.mode === 'batch'
        ? React.createElement('div', { className: 'dkb-dialog', onClick: () => setDialog(null) },
          React.createElement('div', { className: 'dkb-dialogBox', onClick: (e) => e.stopPropagation() },
            React.createElement('span', { className: 'dkb-title' },
              t('batch.title', { n: dialog.ids.length })),
            React.createElement('p', { className: 'dkb-hint' }, t('batch.hint')),
            dialog.error ? React.createElement('p', { className: 'dkb-failed' }, dialog.error) : null,
            React.createElement('ul', { className: 'dkb-batchList' },
              dialog.ids.map((id, at) => {
                const task = state.tasks.find((x) => x.id === id)
                return React.createElement('li', { className: 'dkb-batchRow', key: id },
                  React.createElement('span', { className: 'dkb-refNum' }, String(at + 1)),
                  React.createElement('span', null, task ? task.title : id))
              })),
            React.createElement('div', { className: 'dkb-field' },
              React.createElement('span', { className: 'dkb-label' }, t('panel.provider')),
              React.createElement('select', {
                className: 'dkb-input', value: provider,
                onChange: (e) => { setProvider(e.target.value); setModel('') },
              },
                React.createElement('option', { value: '' }, t('panel.pickProvider')),
                providers.map((p) => React.createElement('option', { value: p.id, key: p.id }, p.name)),
              ),
            ),
            React.createElement('div', { className: 'dkb-field' },
              React.createElement('span', { className: 'dkb-label' }, t('panel.model')),
              React.createElement('select', {
                className: 'dkb-input', value: model, disabled: provider === '',
                onChange: (e) => setModel(e.target.value),
              },
                React.createElement('option', { value: '' }, t('panel.pickModel')),
                models.map((m) => React.createElement('option', { value: m.id, key: m.id }, m.name)),
              ),
            ),
            React.createElement(LaunchFields, {
              t, presets, agentPreset, permission,
              onPreset: setAgentPreset, onPermission: setPermission,
            }),
            React.createElement('div', { className: 'dkb-row' },
              React.createElement('button', {
                type: 'button', className: 'dkb-discard', onClick: () => setDialog(null),
              }, t('dialog.cancel')),
              React.createElement('button', {
                type: 'button', className: 'dkb-save', disabled: model === '',
                onClick: async () => {
                  try {
                    rememberLaunch(board, { provider, model, agentPreset, permission })
                    const out = await api('/batch', {
                      method: 'POST',
                      body: JSON.stringify({ ids: dialog.ids, provider, model, agentPreset, permission }),
                    })
                    setDialog(null)
                    setPicked({})
                    await load(board)
                    // Сессия поднята — но пока её не открыли, для человека
                    // «ничего не произошло».
                    if (!openSession(props.ctx, out && out.sessionId)) {
                      setError(t('error.sessionNotOpened', { id: (out && out.sessionId) || '' }))
                      return
                    }
                    if (props.onClose) props.onClose()
                  } catch (e) {
                    setDialog(Object.assign({}, dialog, { error: t(e.key || 'error.unknown') }))
                  }
                },
              }, t('batch.start')),
            ),
          ))
        : null

      const queueEl = dialog && dialog.mode === 'queue'
        ? React.createElement('div', { className: 'dkb-dialog', onClick: () => setDialog(null) },
          React.createElement('div', { className: 'dkb-dialogBox', onClick: (e) => e.stopPropagation() },
            React.createElement('span', { className: 'dkb-title' }, t('queue.title')),
            React.createElement('p', { className: 'dkb-hint' }, t('queue.hint')),
            dialog.error ? React.createElement('p', { className: 'dkb-failed' }, dialog.error) : null,
            React.createElement('div', { className: 'dkb-field' },
              React.createElement('span', { className: 'dkb-label' }, t('queue.session')),
              React.createElement('select', {
                className: 'dkb-input', value: dialog.sessionId,
                onChange: (e) => setDialog(Object.assign({}, dialog, { sessionId: e.target.value })),
              }, dialog.sessions.map((one) => React.createElement('option', {
                value: one.sessionId, key: one.sessionId,
              }, t('queue.option', {
                n: one.tasks.length,
                title: (one.tasks[0] && one.tasks[0].title) || one.sessionId,
              })))),
            ),
            React.createElement('div', { className: 'dkb-row' },
              React.createElement('button', {
                type: 'button', className: 'dkb-discard', onClick: () => setDialog(null),
              }, t('dialog.cancel')),
              React.createElement('button', {
                type: 'button', className: 'dkb-save',
                onClick: async () => {
                  try {
                    await api('/task/' + encodeURIComponent(dialog.task.id) + '/queue', {
                      method: 'POST',
                      body: JSON.stringify({ sessionId: dialog.sessionId }),
                    })
                    setDialog(null)
                    await load(board)
                  } catch (e) {
                    setDialog(Object.assign({}, dialog, { error: t(e.key || 'error.unknown') }))
                  }
                },
              }, t('queue.add')),
            ),
          ))
        : null

      const dialogEl = dialog && dialog.mode !== 'move' && dialog.mode !== 'batch' && dialog.mode !== 'queue'
        ? React.createElement('div', { className: 'dkb-dialog', onClick: () => setDialog(null) },
          React.createElement('div', { className: 'dkb-dialogBox', onClick: (e) => e.stopPropagation() },
            React.createElement('span', { className: 'dkb-title' }, t('dialog.title')),
            React.createElement('div', { className: 'dkb-row' },
              React.createElement('button', {
                type: 'button', className: dialog.mode === 'own' ? 'dkb-save' : 'dkb-discard',
                onClick: () => setDialog(Object.assign({}, dialog, { mode: 'own', error: '' })),
              }, t('dialog.own')),
              // Простая доска — для задач без issue, и предлагать на ней импорт
              // значит звать туда, откуда сервер вернёт отказ.
              state.kind === 'simple' ? null : React.createElement('button', {
                type: 'button', className: dialog.mode === 'gitea' ? 'dkb-save' : 'dkb-discard',
                onClick: async () => {
                  setDialog(Object.assign({}, dialog, { mode: 'gitea', error: '' }))
                  if (dialog.repos !== null) return
                  try {
                    const out = await api('/gitea/repos?q=')
                    setDialog((d) => Object.assign({}, d, { mode: 'gitea', repos: out.repos || [], error: '' }))
                  } catch (e) {
                    setDialog((d) => Object.assign({}, d, { mode: 'gitea', repos: [], error: t(e.key || 'error.unknown') }))
                  }
                },
              }, t('dialog.fromGitea')),
            ),
            dialog.error ? React.createElement('p', { className: 'dkb-failed' }, dialog.error) : null,
            dialog.mode === 'own'
              ? React.createElement('div', null,
                // Проект или нет — это выбор доски, и он же выбор судьбы
                // задачи: у проектной появляется issue, у остальной нет.
                // Правило без исключений: есть issue — проектная доска.
                React.createElement('div', { className: 'dkb-field' },
                  React.createElement('span', { className: 'dkb-label' }, t('dialog.kind')),
                  React.createElement('div', { className: 'dkb-row' },
                    React.createElement('button', {
                      type: 'button', className: dialog.project ? 'dkb-save' : 'dkb-discard',
                      onClick: () => setDialog(Object.assign({}, dialog, { project: true, error: '' })),
                    }, t('dialog.kindProject')),
                    React.createElement('button', {
                      type: 'button', className: dialog.project ? 'dkb-discard' : 'dkb-save',
                      onClick: () => setDialog(Object.assign({}, dialog, { project: false, error: '' })),
                    }, t('dialog.kindPlain')),
                  ),
                  React.createElement('p', { className: 'dkb-hint' },
                    t(dialog.project ? 'dialog.kindProjectHint' : 'dialog.kindPlainHint')),
                ),
                dialog.project
                  ? React.createElement('div', { className: 'dkb-field' },
                    React.createElement('span', { className: 'dkb-label' }, t('dialog.repo')),
                    React.createElement('select', {
                      className: 'dkb-input', value: dialog.repo || '',
                      onChange: (e) => setDialog(Object.assign({}, dialog, { repo: e.target.value })),
                    },
                      React.createElement('option', { value: '' }, t('dialog.repoNew')),
                      (state.facets || [])
                        .filter((f) => f.ns === REPO_FACET)
                        .flatMap((f) => f.values)
                        .map((v) => React.createElement('option', { value: v.value, key: v.value }, v.value)),
                    ),
                    (dialog.repo || '') === ''
                      ? React.createElement('div', null,
                        React.createElement('input', {
                          className: 'dkb-input', value: dialog.newRepo || '',
                          placeholder: t('dialog.repoNamePlaceholder'),
                          onChange: (e) => setDialog(Object.assign({}, dialog, { newRepo: e.target.value })),
                        }),
                        // Создание репозитория необратимо в один клик, и
                        // человек должен видеть это ДО нажатия, а не после.
                        React.createElement('p', { className: 'dkb-hint' }, t('dialog.repoNewHint')),
                      )
                      : null,
                  )
                  : null,
                React.createElement('div', { className: 'dkb-field' },
                  React.createElement('span', { className: 'dkb-label' }, t('dialog.taskTitle')),
                  React.createElement('input', {
                    className: 'dkb-input', value: dialog.title, autoFocus: true,
                    onChange: (e) => setDialog(Object.assign({}, dialog, { title: e.target.value })),
                  }),
                ),
                React.createElement('div', { className: 'dkb-field' },
                  React.createElement('span', { className: 'dkb-label' }, t('dialog.taskBody')),
                  React.createElement('textarea', {
                    className: 'dkb-area', value: dialog.body || '',
                    onChange: (e) => setDialog(Object.assign({}, dialog, { body: e.target.value })),
                  }),
                  React.createElement('p', { className: 'dkb-hint' }, t('dialog.bodyHint')),
                ),
                React.createElement('div', { className: 'dkb-field' },
                  React.createElement('span', { className: 'dkb-label' }, t('dialog.taskLabels')),
                  React.createElement('input', {
                    className: 'dkb-input', value: dialog.labels || '',
                    placeholder: t('dialog.labelsHint'),
                    onChange: (e) => setDialog(Object.assign({}, dialog, { labels: e.target.value })),
                  }),
                ),
                React.createElement('div', { className: 'dkb-field' },
                  React.createElement('span', { className: 'dkb-label' }, t('dialog.taskColumn')),
                  React.createElement('select', {
                    className: 'dkb-input', value: dialog.column || 'backlog',
                    onChange: (e) => setDialog(Object.assign({}, dialog, { column: e.target.value })),
                  }, (state.columns || []).map((c) => React.createElement('option', { value: c.id, key: c.id }, t('column.' + c.id)))),
                ),
                React.createElement('div', { className: 'dkb-foot' },
                  React.createElement('button', { type: 'button', className: 'dkb-discard', onClick: () => setDialog(null) }, t('dialog.cancel')),
                  React.createElement('button', {
                    type: 'button', className: 'dkb-save', disabled: String(dialog.title || '').trim() === '',
                    onClick: async () => {
                      try {
                        if (dialog.project) {
                          // Проектная задача заводит issue и привязывается к
                          // нему; метки ей ставит Gitea, а не мы.
                          await api('/project-task', {
                            method: 'POST',
                            body: JSON.stringify({
                              repo: dialog.repo || '',
                              newRepo: dialog.newRepo || '',
                              title: dialog.title,
                              body: dialog.body || '',
                              board: 'main',
                            }),
                          })
                        } else {
                          await api('/task', {
                            method: 'POST',
                            body: JSON.stringify({
                              title: dialog.title,
                              body: dialog.body || '',
                              // Метки вводятся через запятую: отдельный редактор
                              // меток ради своей задачи — лишняя мебель.
                              labels: String(dialog.labels || '').split(',').map((x) => x.trim()).filter(Boolean),
                              column: dialog.column || 'backlog',
                              // Задача без issue живёт на простой доске: правило
                              // без исключений, и помнить, где её завели, не надо.
                              board: 'simple',
                            }),
                          })
                        }
                        setDialog(null)
                        await load(board)
                      } catch (e) {
                        setDialog(Object.assign({}, dialog, { error: t(e.key || 'error.unknown') }))
                      }
                    },
                  }, t('dialog.create')),
                ),
              )
              : React.createElement('div', null,
                React.createElement('div', { className: 'dkb-row' },
                  React.createElement('select', {
                    className: 'dkb-input', value: dialog.full,
                    disabled: dialog.repos === null || dialog.repos.length === 0,
                    onChange: async (e) => {
                      const full = e.target.value
                      setDialog((d) => Object.assign({}, d, { full, issues: null, error: '' }))
                      const pair = splitFullName(full)
                      if (pair === undefined) return
                      try {
                        const out = await api('/gitea/issues?owner=' + encodeURIComponent(pair.owner) +
                          '&repo=' + encodeURIComponent(pair.repo))
                        setDialog((d) => Object.assign({}, d, { issues: out.issues || [], error: '' }))
                      } catch (err) {
                        setDialog((d) => Object.assign({}, d, { issues: [], error: t(err.key || 'error.unknown') }))
                      }
                    },
                  },
                    React.createElement('option', { value: '' },
                      dialog.repos === null ? t('dialog.loadingRepos')
                        : dialog.repos.length === 0 ? t('dialog.noRepos') : t('dialog.pickRepo')),
                    (dialog.repos || []).map((r) => {
                      const full = r.fullName || (r.owner + '/' + r.repo)
                      return React.createElement('option', { value: full, key: full }, repoOption(r, t))
                    }),
                  ),
                ),
                dialog.issues === null ? null
                  : dialog.issues.length === 0
                    ? React.createElement('p', { className: 'dkb-note' }, t('dialog.noIssues'))
                    : React.createElement('div', { className: 'dkb-list' }, dialog.issues.map((issue) =>
                      React.createElement('button', {
                        type: 'button',
                        className: 'dkb-issue' + (issue.imported ? ' dkb-issueUsed' : ''),
                        key: issue.number,
                        onClick: async () => {
                          const pair = splitFullName(dialog.full)
                          if (pair === undefined) return
                          try {
                            await api('/import', {
                              method: 'POST',
                              body: JSON.stringify({ owner: pair.owner, repo: pair.repo, issueNumber: issue.number, board }),
                            })
                            setDialog(null)
                            await load(board)
                          } catch (e) {
                            setDialog(Object.assign({}, dialog, { error: t(e.key || 'error.unknown') }))
                          }
                        },
                      }, `#${issue.number} ${issue.title}${issue.imported ? ' · ' + t('dialog.imported') : ''}`))),
              ),
          ))
        : null

      // Архив — свой экран, а не колонка: колонка это стадия работы, а архив
      // стадией не является. Возврат ставит карточку ровно туда, где она была.
      const archiveEl = archive
        ? React.createElement('div', { className: 'dkb-archive' },
          React.createElement('p', { className: 'dkb-hint' }, t('archive.hint')),
          archive.length === 0
            ? React.createElement('p', { className: 'dkb-note' }, t('archive.empty'))
            : React.createElement('ul', { className: 'dkb-archiveList' },
              archive.map((task) => React.createElement('li', { className: 'dkb-archiveRow', key: task.id },
                React.createElement('button', {
                  type: 'button', className: 'dkb-archiveTitle dkb-archiveOpen',
                  // Архив — не братская могила: задачу туда убрали, а не
                  // стёрли, и прочитать её должно быть можно, не возвращая.
                  onClick: () => setOpenTask(task),
                },
                  [cardRef(task), task.title].filter(Boolean).join(' · ')),
                React.createElement('span', { className: 'dkb-taskRef', title: exactAt(task.archivedAt) },
                  t('archive.since', { ago: agoText(state.now, task.archivedAt, t) })),
                React.createElement('button', {
                  type: 'button', className: 'dkb-discard',
                  onClick: async () => {
                    try {
                      await api('/task/' + encodeURIComponent(task.id) + '/restore', { method: 'POST', body: '{}' })
                      setArchive((cur) => (cur || []).filter((x) => x.id !== task.id))
                      await load(board)
                    } catch (e) { setError(t(e.key || 'error.unknown')) }
                  },
                }, t('archive.restore')),
              ))),
        )
        : null

      // Метрика — это взгляд на журнал, а не новые данные: экран ничего не
      // меняет, поэтому и кнопок действий на нём нет.
      const metricsEl = metrics
        ? React.createElement('div', { className: 'dkb-archive' },
          React.createElement('p', { className: 'dkb-hint' },
            t('metrics.hint', { n: metrics.tasks, week: metrics.done.week, month: metrics.done.month })),
          React.createElement('div', { className: 'dkb-group' }, t('metrics.columns')),
          metrics.columns.length === 0
            ? React.createElement('p', { className: 'dkb-note' }, t('metrics.empty'))
            : React.createElement('ul', { className: 'dkb-archiveList' },
              metrics.columns.map((row) => React.createElement('li', {
                className: 'dkb-archiveRow', key: row.column,
              },
                React.createElement('span', { className: 'dkb-archiveTitle' }, columnTitle({ id: row.column }, t)),
                React.createElement('span', { className: 'dkb-taskRef' },
                  t('metrics.median', { time: agoText(0, -row.median, t) })),
                React.createElement('span', { className: 'dkb-taskRef' },
                  t('metrics.mean', { time: agoText(0, -row.mean, t) })),
                React.createElement('span', { className: 'dkb-count' }, String(row.tasks)),
              ))),
          React.createElement('div', { className: 'dkb-group' },
            t('metrics.stale', { days: metrics.staleDays })),
          metrics.stale.length === 0
            ? React.createElement('p', { className: 'dkb-note' }, t('metrics.noStale'))
            : React.createElement('ul', { className: 'dkb-archiveList' },
              metrics.stale.map((row) => React.createElement('li', {
                className: 'dkb-archiveRow', key: row.id,
              },
                React.createElement('span', { className: 'dkb-archiveTitle' }, row.title),
                React.createElement('span', { className: 'dkb-taskRef' }, columnTitle({ id: row.column }, t)),
                React.createElement('span', { className: 'dkb-taskRef', title: exactAt(row.since) },
                  agoText(state.now, row.since, t)),
              ))),
        )
        : null

      return React.createElement('div', { className: 'dkb-screen' },
        style, bar,
        error ? React.createElement('p', { className: 'dkb-failed' }, error) : null,
        metrics ? metricsEl : archive ? archiveEl : columns,
        panel, dialogEl, moveDialogEl, batchEl, queueEl,
      )
    }

    /**
     * Чип задачи в шапке чата. Большинство сессий подняты не с доски, и это
     * штатное положение: тогда чип не рисуется вовсе. Пока ответ не пришёл,
     * тоже ничего — мигающая заглушка в шапке хуже её отсутствия.
     */
    function TaskChip(props) {
      const t = props.t || fallbackT
      const [task, setTask] = React.useState(null)
      const [columns, setColumns] = React.useState(COLUMN_ORDER)
      const [note, setNote] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const session = props.useSession ? props.useSession((s) => s) : null
      const sessionId = chipSessionId(props, session)

      React.useEffect(() => {
        let alive = true
        if (!sessionId) { setTask(null); return () => {} }
        api('/session/' + encodeURIComponent(sessionId) + '/task')
          .then((out) => {
            if (!alive) return
            setTask((out && out.task) || null)
            setColumns((out && out.columns) || COLUMN_ORDER)
          })
          .catch(() => { if (alive) setTask(null) })
        return () => { alive = false }
      }, [sessionId])

      const move = React.useCallback(async (column) => {
        if (!task) return
        try {
          const out = await api('/task/' + encodeURIComponent(task.id) + '/move', {
            method: 'POST', body: JSON.stringify({ column }),
          })
          setTask(out.task)
          setOpen(false)
        } catch { /* причину показывает доска; шапку не ломаем */ }
      }, [task])

      if (!task) return null

      const label = [cardRef(task) || task.title, t('column.' + task.column)].filter(Boolean).join(' · ')
      return React.createElement('span', { className: 'dkb-chipWrap' },
        React.createElement('style', null, css),
        React.createElement('button', {
          type: 'button', className: 'dkb-chip', title: task.title,
          onClick: () => setOpen((v) => !v),
        }, '▦ ' + label),
        open ? React.createElement('div', { className: 'dkb-chipPanel' },
          React.createElement('span', { className: 'dkb-hint' }, t('chip.moveTo')),
          columns.map((id) => React.createElement('button', {
            type: 'button', key: id,
            className: id === task.column ? 'dkb-save' : 'dkb-discard',
            onClick: () => move(id),
          }, t('column.' + id))),
          props.toggle
            ? React.createElement('button', {
              type: 'button', className: 'dkb-discard',
              onClick: () => { setOpen(false); props.toggle.show(task.id, task.board) },
            }, t('chip.openCard'))
            : null,
          React.createElement('span', { className: 'dkb-hint' }, t('chip.note')),
          React.createElement('textarea', {
            className: 'dkb-area', value: note, disabled: saving,
            onChange: (e) => setNote(e.target.value),
          }),
          // Тело уходит агенту первым сообщением при запуске: заметка до
          // запуска попадёт в работу, после — нет. Молчать об этом значит
          // сделать поведение случайным на вид.
          React.createElement('span', { className: 'dkb-hint' }, t('chip.noteHint')),
          React.createElement('button', {
            type: 'button', className: 'dkb-save',
            disabled: saving || note.trim() === '',
            onClick: async () => {
              setSaving(true)
              try {
                const out = await api('/task/' + encodeURIComponent(task.id) + '/note', {
                  method: 'POST', body: JSON.stringify({ text: note }),
                })
                setTask(out.task)
                setNote('')
                setOpen(false)
              } catch { /* причину показывает доска; шапку не ломаем */ } finally {
                setSaving(false)
              }
            },
          }, t('chip.noteSave')),
        ) : null,
      )
    }


    // ------------------------------------------------- встраивание в оболочку
    //
    // Раздела верхнего уровня в этой сборке нет: слоты `app.section` и
    // `sidebar.section` отсутствуют, а `settings.section` уводит доску в
    // настройки, где ей не место. Поэтому строка и экран вставляются прямо в
    // вёрстку оболочки — тем же приёмом, каким это делает штатный task board.
    //
    // Приём хрупкий по своей природе: он опирается на чужую вёрстку. Смягчение
    // — селекторы по подстроке класса, наблюдатели за перерисовкой React и
    // мягкий отказ: не нашли корень — просто ничего не показали, ничего не
    // сломали.

    const PANEL = 'kanban'
    const ACTIVATE_EVENT = 'dsh-panel-activate'
    const ACTIVE_ATTR = 'data-dsh-kanban-active'
    const ENTRY_ATTR = 'data-dsh-kanban-entry'
    const VIEW_ATTR = 'data-dsh-kanban-view'
    const COLUMN_SELECTOR = '[data-pane=conversation], [class*=centerCol]'
    const SESSION_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="newSession"]'

    const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"'
      + ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M6.5 6.5v7"/></svg>'

    /** Открыта ли доска. Крошечное хранилище: подписки нужны и строке, и экрану. */
    /** @see helpers.createToggle */
    function createToggle() {
      let open = false
      // Задача, которую просили показать при открытии. Состояние окна живёт
      // внутри экрана доски, и снаружи до него иначе не дотянуться.
      let wanted = undefined
      const listeners = new Set()
      return {
        isOpen: () => open,
        set(next) {
          if (open === next) return
          open = next
          for (const fn of listeners) fn()
        },
        toggle() { this.set(!open) },
        /** Открыть доску на конкретной задаче. */
        show(taskId, boardId) {
          // Доска едет вместе с задачей: карточка может лежать на простой, а
          // открытой быть проектная, и тогда искать её было бы негде.
          wanted = { id: String(taskId || ''), board: String(boardId || 'main') }
          if (open) { for (const fn of listeners) fn() } else this.set(true)
        },
        /** Забрать просьбу. Читается один раз: повтор открывал бы окно снова. */
        takeWanted() {
          const asked = wanted
          wanted = undefined
          return asked
        },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      }
    }

    /**
     * Родная кнопка «Новая сессия».
     *
     * Отсеиваем узлы, у которых в классах есть `newSessionLabel`: это подпись
     * внутри кнопки, а не сама кнопка.
     */
    function nativeButton() {
      const nodes = document.querySelectorAll('button[class*="newSession"]')
      for (const node of nodes) {
        if (String(node.className).indexOf('newSessionLabel') === -1) return node
      }
      return undefined
    }

    /**
     * Кнопка доски: КЛОН родной кнопки со своими подписью и значком.
     *
     * Классы оболочки берутся у самой оболочки, а не переписываются у себя:
     * повторять чужие стили руками — значит расходиться с ними при первом же
     * обновлении интерфейса. Соседний плагин «Мастерская» поступает так же.
     */
    function createEntry(target, toggle, label) {
      const entry = target.cloneNode(true)
      entry.className = String(target.className) + ' dkb-entry-clone'
      entry.setAttribute(ENTRY_ATTR, '')
      entry.setAttribute('data-dsh-plugin', 'kanban')
      entry.setAttribute('data-dsh-part', 'sidebar-entry')
      entry.setAttribute('aria-label', label)
      entry.removeAttribute('id')
      entry.innerHTML = ''

      const icon = document.createElement('span')
      icon.className = 'dkb-entryIcon'
      icon.innerHTML = ICON
      entry.appendChild(icon)

      const text = document.createElement('span')
      text.className = 'dkb-entryLabel'
      text.textContent = label
      entry.appendChild(text)

      entry.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        toggle.toggle()
      })
      return entry
    }

    /** Встать последней среди уже вставленных чужих кнопок, а не влезать между. */
    function placeEntry(target, entry) {
      let anchor = target
      let next = target.nextElementSibling
      while (next !== null && next.tagName === 'BUTTON'
        && String(next.className).indexOf('sidebar-entry') >= 0) {
        anchor = next
        next = next.nextElementSibling
      }
      anchor.insertAdjacentElement('afterend', entry)
      return true
    }

    /** Кнопка в боковой панели, переживающая перерисовку оболочки. */
    function mountSidebarEntry(toggle, label) {
      if (typeof document === 'undefined') return () => {}

      let entry
      const tryPlace = () => {
        if (entry !== undefined && entry.isConnected) return
        const target = nativeButton()
        if (target === undefined || target.parentElement === null) return
        if (target.parentElement.querySelector('[' + ENTRY_ATTR + ']') !== null) return
        entry = createEntry(target, toggle, label)
        placeEntry(target, entry)
        syncActive()
      }

      const syncActive = () => {
        if (entry === undefined) return
        if (toggle.isOpen()) entry.dataset.active = 'true'
        else delete entry.dataset.active
      }

      // Оболочка перерисовывается сама по себе: без наблюдателя кнопка исчезнет
      // при первом же обновлении списка сессий.
      const observer = new MutationObserver(tryPlace)
      observer.observe(document.body, { childList: true, subtree: true })
      const unsubscribe = toggle.subscribe(syncActive)
      tryPlace()

      return () => {
        observer.disconnect()
        unsubscribe()
        if (entry !== undefined) entry.remove()
        entry = undefined
      }
    }

    /** Экран доски поверх колонки разговора. */
    function mountBoard(ctx, toggle) {
      if (typeof document === 'undefined') return () => {}
      let root
      let container

      const ensure = () => {
        if (container !== undefined) return
        const column = document.querySelector(COLUMN_SELECTOR)
        if (column === null) return
        container = document.createElement('div')
        container.setAttribute(VIEW_ATTR, '')
        container.setAttribute('data-dsh-plugin', 'kanban')
        column.appendChild(container)
        root = ReactDOM.createRoot(container)
        root.render(React.createElement(BoardScreen, { ctx, toggle, onClose: () => toggle.set(false) }))
      }

      const applyActive = () => {
        if (toggle.isOpen()) {
          document.documentElement.setAttribute(ACTIVE_ATTR, '')
          document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL }))
        } else {
          document.documentElement.removeAttribute(ACTIVE_ATTR)
        }
      }

      // Соседние панели объявляют себя тем же событием: две панели поверх одной
      // колонки одновременно — это каша, поэтому уступаем.
      const onOtherActivate = (event) => {
        if (event.detail !== PANEL && toggle.isOpen()) toggle.set(false)
      }
      const onSidebarClick = (event) => {
        if (!toggle.isOpen()) return
        const target = event.target
        if (target !== null && target.closest && target.closest(SESSION_ROW_SELECTOR) !== null) toggle.set(false)
      }

      const waitObserver = new MutationObserver(ensure)
      waitObserver.observe(document.body, { childList: true, subtree: true })
      document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
      document.addEventListener('click', onSidebarClick, true)
      const unsubscribe = toggle.subscribe(applyActive)
      applyActive()
      ensure()

      return () => {
        waitObserver.disconnect()
        document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
        document.removeEventListener('click', onSidebarClick, true)
        unsubscribe()
        document.documentElement.removeAttribute(ACTIVE_ATTR)
        if (root !== undefined) root.unmount()
        root = undefined
        if (container !== undefined) container.remove()
        container = undefined
      }
    }

    // ------------------------------------------------------------ регистрация

    /**
     * Зарегистрировать компонент в первый слот, который его примет.
     *
     * Имя слота в сборке подтвердить нельзя: строки слотов в собранном
     * интерфейсе не литеральны. Регистрация в несуществующий слот проходит
     * молча и без ошибки в журнале, поэтому единственный надёжный способ —
     * перебрать кандидатов и запомнить, какой сработал. Соседний плагин
     * dsh-gitea поступает так же со своей карточкой настроек.
     *
     * @returns {string|undefined} имя сработавшего слота
     */
    function registerFirst(ctx, candidates, component) {
      for (const entry of candidates) {
        try {
          let ok = false
          ctx.slots.inject(entry.name, () => {
            ctx.slots.register(entry, component)
            ok = true
          })
          if (ok) return entry.name
        } catch { /* слота нет в этой сборке — пробуем следующий */ }
      }
      return undefined
    }

    helpers.createToggle = createToggle

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-kanban: словари')

      // Карточка настроек. Ключ обязан совпадать с пространством настроек:
      // вкладка перебирает объявленные пространства и рисует слот с entryKey,
      // равным имени пространства.
      const cardSlot = registerFirst(ctx, [
        { name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({ ctx }) },
        { name: 'settings.section', id: '@goodandready/dsh-kanban', order: 32, locale: NS, label: () => fallbackT('title'), inject: () => ({ ctx }) },
      ], KanbanSettingsCard)

      // Экран доски встраивается в оболочку, а не в слот: раздела верхнего
      // уровня в сборке нет, а настройки — не место для доски.
      const toggle = createToggle()
      ctx.effect(() => {
        const off = [mountSidebarEntry(toggle, fallbackT('section.label')), mountBoard(ctx, toggle)]
        return () => { for (const dispose of off) dispose() }
      }, 'dsh-kanban: доска в оболочке')

      // Чип задачи в шапке чата. Слот подтверждён живым плагином dsh-gitea.
      const chipSlot = registerFirst(ctx, [
        { name: 'conversation.session.header.utilities', id: '@goodandready/dsh-kanban.chip', order: 26, locale: NS, inject: () => ({ ctx, toggle }) },
      ], TaskChip)

      // Куда встали — видно снаружи: живая проверка сверяет это с интерфейсом.
      exports.slots = { card: cardSlot, chip: chipSlot }
    }

    module.exports = { apply, inject: ['slots', 'locale', 'settingsScope'], helpers }
    return module.exports
  },
})

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
  id: '@goodandready-private/dsh-kanban',
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

    function cardRef(task) {
      if (!task || !task.repo) return ''
      if (typeof task.issueNumber !== 'number') return task.repo
      return task.repo + '#' + task.issueNumber
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

    /** Стиль метки. Без цвета — прежний нейтральный вид, а не чёрный прямоугольник. */
    function tagStyle(task, name) {
      const hex = task && task.labelColors ? task.labelColors[name] : undefined
      if (!hex) return undefined
      return { background: '#' + hex, color: readableOn(hex), borderColor: 'transparent' }
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
      neighboursFor, tasksOf, cardRef, cardStatus, planLine, stateLabel, isCollapsed,
      agoText, exactAt, syncLine, readableOn, tagStyle, matchesFilters, anySelected, toggleValue, normalizeBoard, errorKey,
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
      '.dkb-bar{flex:none;align-items:center;gap:10px;display:flex;flex-wrap:wrap}' +
      '.dkb-back{appearance:none;font:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;align-items:center;gap:6px;padding:4px 10px;font-size:13px;display:flex;flex:none}' +
      '.dkb-back:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dkb-backIcon{align-items:center;display:flex}' +
      '.dkb-archive{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px}' +
      '.dkb-archiveList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}' +
      '.dkb-archiveRow{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;align-items:center;gap:12px;padding:8px 12px;display:flex}' +
      '.dkb-archiveTitle{flex:1;font-size:13px;color:var(--dsw-alias-label-primary)}' +
      '.dkb-cardMenu{position:relative;align-self:flex-start}' +
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
      '.dkb-count{min-width:0;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;flex:none;padding:1px 8px;font-size:12px}' +
      '.dkb-countOver{color:var(--dsw-alias-state-error-primary);font-weight:600}' +
      '.dkb-list{flex-direction:column;flex:1;gap:8px;min-height:0;padding:2px 8px 10px;display:flex;overflow-y:auto}' +
      '.dkb-empty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:24px 8px;font-size:12px}' +
      '.dkb-taskCard{text-align:left;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;color:var(--dsw-alias-label-primary);border-radius:10px;flex-direction:column;gap:6px;padding:10px 12px;font-family:inherit;transition:box-shadow .12s,border-color .12s,transform .12s;display:flex}' +
      '.dkb-taskCard:hover{box-shadow:var(--dsw-shadow-lv2);border-color:var(--dsw-alias-border-l3);transform:translateY(-1px)}' +
      '.dkb-taskTitle{-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:13px;font-weight:600;line-height:1.35;display:-webkit-box;overflow:hidden}' +
      '.dkb-taskHead{align-items:center;gap:6px;flex-wrap:wrap;display:flex}' +
      '.dkb-repoChip{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 6px;font-size:11px;font-weight:600}' +
      '.dkb-taskRef{color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;font-size:11px;display:flex}' +
      '.dkb-planLine{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.35;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box}' +
      '.dkb-state{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 5px;font-size:10px;line-height:16px}' +
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
      'board.noMatch': 'Nothing matches the search.',
      'board.search': 'Search',
      'board.limit': 'limit {n}',
      'board.newTask': '+ Task',
      'board.refresh': 'Refresh',
      'board.allRepos': 'all repositories',
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
      'dialog.kind': 'What kind of task',
      'dialog.kindProject': 'Project',
      'dialog.kindPlain': 'Not a project',
      'dialog.kindProjectHint': 'An issue is created in Gitea and the card is bound to it. The card lives on the project board.',
      'dialog.kindPlainHint': 'A note that touches no repository. It lives on the simple board and never reaches Gitea.',
      'dialog.repo': 'Repository',
      'dialog.repoNew': '— a new repository —',
      'dialog.repoNamePlaceholder': 'name of the new repository',
      'dialog.repoNewHint': 'It will be created in the organisation: private and empty, no README and no scaffolding. Creating a repository cannot be undone from here.',
      'error.repo-required': 'Choose a repository or name a new one.',
      'error.bad-repo-name': 'A repository name may contain only Latin letters, digits, dot, dash and underscore.',
      'error.repo-not-created': 'The repository was not created; nothing else was done.',
      'error.issue-not-created': 'The issue was not created. If the repository was new, it stayed — nothing was deleted.',
      'board.archive': 'Archive',
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
      'facet.repo': 'repository',
      'board.clearFilters': 'Clear the filters',
      'board.back': 'To the chat',
      'board.backHint': 'Close the board and return to the conversation',
      'board.inColumn': 'here {ago}',
      'panel.openChat': 'Open the chat',
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

    const ru = {
      'title': 'Канбан',
      'subtitle': 'Доска задач: issue из Gitea и отдельная сессия под задачу',
      'section.label': 'Канбан',
      'group.gitea': 'Gitea',
      'group.general': 'Общее',
      'field.giteaUrl': 'Адрес инстанса',
      'field.giteaTokenRef': 'Имя учётной записи',
      'hint.giteaUrl': 'Например https://gitea.example.com. Пусто — импорт недоступен.',
      'hint.giteaTokenRef': 'ИМЯ учётной записи DSH, в которой лежит токен. Сам токен сюда не вводить.',
      'group.limits': 'Пределы колонок',
      'group.sync': 'Автоперемещение',
      'field.syncIntervalSec': 'Сверяться с Gitea раз в, секунд',
      'field.staleAfterMin': 'Считать задачу молчащей после, минут',
      'field.giteaOwner': 'Организация Gitea',
      'hint.giteaOwner': 'Чьи репозитории смотрит доска. Пусто — определится сама, пока у токена ровно одна организация.',
      'field.watchRepos': 'Сузить подхват до репозиториев',
      'hint.watchRepos': 'Через запятую, «владелец/репо» или просто «репо». Пусто — все репозитории организации, где есть открытые задачи.',
      'field.archiveAfterDays': 'Убирать в архив из «Выполнено» через, дней',
      'hint.archiveAfterDays': 'Считается с попадания карточки в «Выполнено». Ноль — оставлять всё на доске.',
      'field.boardToolEnabled': 'Разрешить агенту двигать карточки',
      'field.pushToGitea': 'Закрывать issue в Gitea',
      'field.webhookSecretRef': 'Имя учётной записи для вебхука',
      'hint.pushToGitea': 'Карточка, дошедшая до «Выполнено», закрывает свой issue. Меток доска не ставит: стадия и так видна по ветке и pull request.',
      'hint.webhookSecretRef': 'ИМЯ учётной записи DSH с секретом вебхука Gitea. Пусто — остаётся только опрос.',
      'hint.syncIntervalSec': 'Ноль отключает сверку. Меньше пятнадцати секунд поднимается до пятнадцати.',
      'hint.staleAfterMin': 'Помечаются только задачи с сессией. Ноль отключает отметку.',
      'hint.boardToolEnabled': 'Выключено, пока скилл воркфлоу запрещает этому CLI трогать канбан.',
      'field.defaultProjectRoot': 'Корень проектов',
      'field.startPrompt': 'Шаблон первого сообщения',
      'field.replyInstruction': 'Постоянная приписка',
      'field.wipInProgress': 'Предел «В работе»',
      'field.wipReview': 'Предел «Ревью»',
      'hint.defaultProjectRoot': 'Где лежат рабочие копии проектов. Пусто — рабочая папка харнесса.',
      'hint.startPrompt': 'Шаблон первого сообщения агенту. Пусто — встроенный шаблон.',
      'hint.replyInstruction': 'Дописывается к каждому первому сообщению — например язык ответа. Пусто — ничего не добавляется.',
      'hint.label': 'Пусто — метка для этой колонки не ставится.',
      'hint.limit': 'Ноль — без предела. Превышение подсвечивается, но не запрещается.',
      'settings.loading': 'Настройки загружаются…',
      'settings.unavailable': 'Хост не знает пространство настроек dsh-kanban. Перезапустите веб-интерфейс после установки плагина.',
      'settings.readOnly': 'Настройки в этой сессии доступны только для чтения.',
      'settings.saveFailed': 'Не сохранены поля: {fields}',
      'settings.saved': 'Сохранено.',
      'save': 'Сохранить',
      'discard': 'Отменить',
      'column.backlog': 'Backlog',
      'column.in-progress': 'В работе',
      'column.review': 'Ревью',
      'column.deploy': 'Deploy',
      'column.cleanup': 'Cleanup',
      'column.done': 'Done',
      'board.loading': 'Доска загружается…',
      'board.empty': 'Задач пока нет.',
      'board.waiting': 'нужен человек',
      'board.sync': 'Сверить с Gitea',
      'board.noMatch': 'Ничего не найдено.',
      'board.search': 'Поиск',
      'board.limit': 'предел {n}',
      'board.newTask': '+ Задача',
      'board.refresh': 'Обновить',
      'board.allRepos': 'все репозитории',
      'board.repo': 'репозиторий',
      'dialog.title': 'Новая задача',
      'dialog.own': 'Своя задача',
      'dialog.fromGitea': 'Из Gitea',
      'dialog.repo': 'Репозиторий',
      'dialog.pickRepo': 'Выберите репозиторий',
      'dialog.loadingRepos': 'Репозитории загружаются…',
      'dialog.noRepos': 'Репозиториев нет',
      'dialog.taskTitle': 'Заголовок',
      'dialog.taskBody': 'Описание',
      'dialog.taskLabels': 'Метки',
      'dialog.taskColumn': 'Колонка',
      'dialog.bodyHint': 'Уйдёт агенту первым сообщением при запуске задачи.',
      'dialog.labelsHint': 'через запятую',
      'dialog.archived': 'архив',
      'dialog.create': 'Создать',
      'dialog.cancel': 'Отмена',
      'move.title': 'Перенести в «{column}»?',
      'board.expand': 'Развернуть колонку',
      'card.move': 'перенести',
      'dialog.kind': 'Какая это задача',
      'dialog.kindProject': 'Проект',
      'dialog.kindPlain': 'Не проект',
      'dialog.kindProjectHint': 'В Gitea заводится issue, карточка привязывается к нему и живёт на проектной доске.',
      'dialog.kindPlainHint': 'Заметка, не относящаяся ни к какому репозиторию. Живёт на простой доске и в Gitea не попадает.',
      'dialog.repo': 'Репозиторий',
      'dialog.repoNew': '— новый репозиторий —',
      'dialog.repoNamePlaceholder': 'имя нового репозитория, латиницей',
      'dialog.repoNewHint': 'Будет создан в организации: приватный и пустой, без README и заготовок. Создание репозитория отсюда не отменить.',
      'error.repo-required': 'Выберите репозиторий или назовите новый.',
      'error.bad-repo-name': 'В имени репозитория допустимы только латинские буквы, цифры, точка, дефис и подчёркивание.',
      'error.repo-not-created': 'Репозиторий не создан; больше ничего не сделано.',
      'error.issue-not-created': 'Issue не заведён. Если репозиторий был новым, он остался — ничего не удалено.',
      'board.archive': 'Архив',
      'panel.archive': 'В архив',
      'archive.hint': 'Карточки, отстоявшие свой срок в «Выполнено». Ничего не удалено: возвращённая карточка встаёт в ту же колонку, откуда ушла.',
      'archive.empty': 'В архиве пусто.',
      'archive.since': 'в архиве {ago}',
      'archive.restore': 'Вернуть на доску',
      'sync.running': 'сверяемся с Gitea…',
      'sync.never': 'сверки с Gitea ещё не было',
      'sync.okAgo': 'сверено {ago} назад',
      'sync.failed': 'сверка не проходит',
      'sync.lastSeen': 'последняя удачная сверка {ago} назад',
      'sync.neverSeen': 'удачной сверки с запуска харнесса не было',
      'facet.repo': 'репозиторий',
      'board.clearFilters': 'Снять отборы',
      'board.back': 'В чат',
      'board.backHint': 'Закрыть доску и вернуться в разговор',
      'board.inColumn': 'здесь {ago}',
      'panel.openChat': 'Открыть чат',
      'panel.created': 'заведена {ago} назад',
      'panel.updated': 'последнее изменение {ago} назад',
      'time.now': 'только что',
      'time.min': '{n} мин',
      'time.hour': '{n} ч',
      'time.day': '{n} дн',
      'board.collapse': 'Свернуть колонку',
      'plan.title': 'План агента',
      'plan.counter': '{done} из {total}',
      'state.running': 'в работе',
      'state.stopped': 'остановился',
      'move.confirm': 'Перенести',
      'move.backlog': 'Работа по задаче останавливается: идущий ход агента будет прерван. Если сессии нет, карточка просто переедет.',
      'move.in-progress': 'Агент получит команду начать или продолжить реализацию.',
      'move.review': 'Агент доведёт работу до ревью: снимет с pull request пометку черновика и запросит проверку.',
      'move.deploy': 'Агент вольёт pull request и выкатит. Сам перенос в эту колонку И ЕСТЬ ваше «ок» на deploy — второй раз агент спрашивать не станет.',
      'move.cleanup': 'Агент удалит ветку в Gitea, worktree и локальную ветку и запишет это в issue.',
      'move.done': 'Задача считается завершённой. Это решение человека: сам агент карточку сюда не переносит.',
      'dialog.imported': 'уже на доске',
      'dialog.noIssues': 'Открытых issue не найдено.',
      'panel.close': 'Закрыть',
      'panel.issue': 'Issue',
      'panel.log': 'Переходы',
      'panel.noLog': 'Переходов пока нет.',
      'panel.refresh': 'Обновить из Gitea',
      'panel.delete': 'Удалить',
      'panel.deleteConfirm': 'Удалить «{title}»? Отменить будет нельзя.',
      'panel.start': 'Начать',
      'panel.provider': 'Провайдер',
      'panel.model': 'Модель',
      'panel.pickProvider': 'Выберите провайдера',
      'panel.pickProviderFirst': 'Сначала выберите провайдера',
      'panel.pickModel': 'Выберите модель',
      'panel.noProviders': 'Провайдеров нет',
      'panel.noModels': 'У этого провайдера нет моделей',
      'panel.starting': 'Запускается…',
      'panel.continue': 'Продолжить',
      'panel.continueHint': 'У задачи один чат: открывается прежняя сессия, а не новая.',
      'panel.message': 'Сообщение агенту',
      'panel.messageHint': 'Правьте перед отправкой. Пустое — уйдёт встроенный текст.',
      'panel.startHint': 'Откроется отдельная сессия агента по этой задаче. Ветку и worktree заводит агент после preflight, а не отсюда.',
      'error.startFailed': 'Не удалось поднять сессию.',
      'error.sessionNotOpened': 'Сессия поднята ({id}), но эта сборка не умеет в неё переключиться. Найдите её в списке сессий.',
      'error.modelNotSelected': 'Модель не выбрана — задайте её в настройках или укажите здесь.',
      'chip.moveTo': 'Перенести в',
      'chip.openCard': 'Перейти к карточке',
      'chip.note': 'Оставить заметку',
      'chip.noteHint': 'Заметка дописывается в тело задачи. Тело уходит агенту первым сообщением, поэтому заметка до запуска попадёт в работу, а после запуска — нет.',
      'chip.noteSave': 'Дописать',
      'error.giteaAbsent': 'Плагин Gitea не установлен, импорт недоступен.',
      'error.giteaUnconfigured': 'Сначала настройте Gitea в карточке плагина Gitea.',
      'error.taskNotFound': 'Задача не найдена.',
      'error.taskHasNoIssue': 'За этой задачей нет issue в Gitea.',
      'error.issueNotFound': 'Issue не найден.',
      'error.titleRequired': 'Нужен заголовок.',
      'error.crossSite': 'Запрос отклонён как межсайтовый.',
      'error.unknown': 'Запрос не выполнен.',
    }

    function fallbackT(key, vars) {
      let text = ru[key] !== undefined ? ru[key] : (en[key] !== undefined ? en[key] : key)
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
      const state = stateLabel(task, t)
      // Сколько карточка стоит в этой колонке. «В ревью третий день» — сигнал,
      // ради которого доску и открывают.
      const inColumn = agoText(now, task.columnAt, t)
      const touched = task.sessionId ? agoText(now, task.updatedAt, t) : ''
      const menu = props.menuOpen
      return React.createElement('div', {
        className: 'dkb-taskCard',
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
        ref || waiting || (task.labels && task.labels.length)
          ? React.createElement('div', { className: 'dkb-taskHead' },
            waiting ? React.createElement('span', { className: 'dkb-waitDot' }) : null,
            waiting ? React.createElement('span', { className: 'dkb-waiting' }, t('board.waiting')) : null,
            ref ? React.createElement('span', { className: 'dkb-repoChip', title: ref }, ref) : null,
            (task.labels || []).map((l) => React.createElement('span', {
              className: 'dkb-tag', key: l, style: tagStyle(task, l),
            }, l)))
          : null,
        React.createElement('div', { className: 'dkb-taskTitle' }, task.title),
        plan ? React.createElement('div', { className: 'dkb-planLine' }, plan) : null,
        // Второй путь к переносу, не замена перетаскиванию: мышью удобнее,
        // когда мышь под рукой. Подтверждение и последствия у обоих те же —
        // разойтись им нельзя.
        React.createElement('div', { className: 'dkb-cardMenu' },
          React.createElement('button', {
            type: 'button', className: 'dkb-moveBtn',
            'aria-expanded': menu === task.id,
            onClick: (e) => { e.stopPropagation(); props.onMenu(menu === task.id ? '' : task.id) },
          }, t('card.move')),
          menu === task.id
            ? React.createElement('div', { className: 'dkb-facetList' },
              (props.columns || []).filter((c) => c !== task.column).map((c) => React.createElement('button', {
                type: 'button', className: 'dkb-facetRow', key: c,
                onClick: (e) => { e.stopPropagation(); props.onMenu(''); props.onMove(task, c) },
              }, t('column.' + c))))
            : null,
        ),
        status || state || inColumn || touched
          ? React.createElement('div', { className: 'dkb-taskRef' },
            state ? React.createElement('span', { className: 'dkb-state' }, state) : null,
            touched
              ? React.createElement('span', {
                className: task.stale ? 'dkb-countOver' : '',
                title: exactAt(task.updatedAt),
              }, touched)
              : null,
            inColumn
              ? React.createElement('span', { title: exactAt(task.columnAt) },
                t('board.inColumn', { ago: inColumn }))
              : null,
            status ? React.createElement('span', null, status) : null)
          : null,
      )
    }

    function BoardScreen(props) {
      const t = props.t || fallbackT
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [openTask, setOpenTask] = React.useState(null)
      const [log, setLog] = React.useState([])
      const [dialog, setDialog] = React.useState(null)
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
      const [archive, setArchive] = React.useState(null)
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
            setProviders(out.providers || [])
            if (out.current) {
              setProvider(out.current.provider || '')
              setModel(out.current.model || '')
            }
          })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      React.useEffect(() => {
        let alive = true
        if (provider === '') { setModels([]); return () => { alive = false } }
        api('/models?provider=' + encodeURIComponent(provider))
          .then((out) => { if (alive && out) setModels(out.models || []) })
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
          }, boards.map((b) => React.createElement('option', { value: b.id, key: b.id }, b.title)))
          : null,
        (state.facets || []).map((facet) => {
          const picked = filters[facet.ns] || []
          const label = facet.ns === REPO_FACET ? t('facet.repo') : facet.ns
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
        React.createElement('button', {
          type: 'button', className: archive ? 'dkb-save' : 'dkb-discard',
          onClick: async () => {
            if (archive) { setArchive(null); return }
            try {
              const out = await api('/archive')
              setArchive(Array.isArray(out.tasks) ? out.tasks : [])
            } catch (e) { setError(t(e.key || 'error.unknown')) }
          },
        }, t('board.archive')),
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
          const line = syncLine(state.sync, state.now, t)
          return React.createElement('span', {
            className: 'dkb-sync' + (line.tone === 'bad' ? ' dkb-syncBad' : ''),
            title: line.title,
          }, line.text)
        })(),
        React.createElement('button', {
          type: 'button', className: 'dkb-discard',
          onClick: async () => {
            try {
              await api('/sync', { method: 'POST', body: '{}' })
              await load(board)
            } catch (e) {
              setError(t(e.key || 'error.unknown'))
            }
          },
        }, t('board.sync')),
        React.createElement('button', { type: 'button', className: 'dkb-discard', onClick: () => load(board) }, t('board.refresh')),
        React.createElement('button', { type: 'button', className: 'dkb-save', onClick: () => setDialog({ mode: 'own', project: false, repo: '', newRepo: '', title: '', full: '', repos: null, issues: null, error: '' }) }, t('board.newTask')),
      )

      // Счётчик колонки считает ВСЕ карточки, а не найденные: иначе поиск
      // сделал бы вид, что предел колонки соблюдён.
      const columns = React.createElement('div', { className: 'dkb-cols' },
        state.columns.map((col) => {
          // Счётчик колонки считает ОТОБРАННОЕ, а поиск — нет.
          //
          // Разница осмысленная, а не недосмотр: поиск временный, и предел
          // «3 из 3» при найденной одной карточке врал бы. Отбор постоянный, и
          // на отборе по одному проекту «в работе 3 из 3» должно значить «по
          // этому проекту» — иначе предел ни о чём.
          const all = tasksOf(state.tasks, col.id).filter((task) => matchesFilters(task, filters))
          const items = all.filter((task) => matchesQuery(task, query))
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
          items.forEach((task, i) => {
            rows.push(React.createElement(TaskCard, {
              key: task.id, task, t, now: state.now,
              columns: (state.columns || []).map((c) => c.id),
              menuOpen: cardMenu,
              onMenu: setCardMenu,
              onMove: (x, column) => askMove(x, column),
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
              React.createElement('span', { className: 'dkb-colName' }, t('column.' + col.id)),
              // Число карточек видно и в свёрнутом виде: колонка с работой,
              // выглядящая пустой, — худшее, что может сделать сворачивание.
              React.createElement('span', {
                className: 'dkb-count' + (overLimit ? ' dkb-countOver' : ''),
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
          React.createElement('div', { className: 'dkb-row' },
            React.createElement('span', { className: 'dkb-title', style: { flex: 1 } }, openTask.title),
            React.createElement('button', { type: 'button', className: 'dkb-discard', onClick: () => setOpenTask(null) }, t('panel.close')),
          ),
          cardRef(openTask) || (openTask.labels || []).length
            ? React.createElement('div', { className: 'dkb-taskHead' },
              cardRef(openTask)
                ? React.createElement('span', { className: 'dkb-repoChip' }, cardRef(openTask))
                : null,
              (openTask.labels || []).map((l) => React.createElement('span', {
                className: 'dkb-tag', key: l, style: tagStyle(openTask, l),
              }, l)))
            : null,
          openTask.issueUrl
            ? React.createElement('a', { className: 'dkb-taskRef', href: openTask.issueUrl, target: '_blank', rel: 'noreferrer' }, t('panel.issue'))
            : null,
          React.createElement('p', { className: 'dkb-panelBody' }, openTask.body || ''),
          React.createElement('p', { className: 'dkb-note' },
            [
              t('panel.created', { ago: agoText(state.now, openTask.createdAt, t) }),
              t('panel.updated', { ago: agoText(state.now, openTask.updatedAt, t) }),
            ].join(' · ')),
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
          React.createElement('div', { className: 'dkb-group' }, t('panel.log')),
          log.length
            ? React.createElement('ul', { className: 'dkb-log' }, log.map((row) => React.createElement('li', {
              className: 'dkb-logRow', key: row.id,
            }, `${t('column.' + row.toCol)} ← ${row.source}${row.detail ? ' · ' + row.detail : ''}`)))
            : React.createElement('p', { className: 'dkb-note' }, t('panel.noLog')),
          React.createElement('div', { className: 'dkb-foot' },
            React.createElement('p', { className: 'dkb-note' }),
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
          React.createElement('div', { className: 'dkb-group' },
            openTask.sessionId ? t('panel.continue') : t('panel.start')),
          React.createElement('p', { className: 'dkb-hint' },
            openTask.sessionId ? t('panel.continueHint') : t('panel.startHint')),
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
          React.createElement('div', { className: 'dkb-foot' },
            React.createElement('p', { className: 'dkb-note' }),
            React.createElement('button', {
              type: 'button', className: 'dkb-save', disabled: starting || model === '',
              onClick: async () => {
                // Кнопка блокируется на время запроса: двойное нажатие подняло
                // бы две сессии по одной задаче.
                setStarting(true)
                try {
                  const out = await api('/task/' + encodeURIComponent(openTask.id) + '/start', {
                    method: 'POST',
                    body: JSON.stringify({ provider, model, text: draftText }),
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

      const dialogEl = dialog && dialog.mode !== 'move'
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
                React.createElement('span', { className: 'dkb-archiveTitle' },
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

      return React.createElement('div', { className: 'dkb-screen' },
        style, bar,
        error ? React.createElement('p', { className: 'dkb-failed' }, error) : null,
        archive ? archiveEl : columns,
        panel, dialogEl, moveDialogEl,
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
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dsh-kanban: словари')

      // Карточка настроек. Ключ обязан совпадать с пространством настроек:
      // вкладка перебирает объявленные пространства и рисует слот с entryKey,
      // равным имени пространства.
      const cardSlot = registerFirst(ctx, [
        { name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({ ctx }) },
        { name: 'settings.section', id: '@goodandready-private/dsh-kanban', order: 32, locale: NS, label: () => fallbackT('title'), inject: () => ({ ctx }) },
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
        { name: 'conversation.session.header.utilities', id: '@goodandready-private/dsh-kanban.chip', order: 26, locale: NS, inject: () => ({ ctx, toggle }) },
      ], TaskChip)

      // Куда встали — видно снаружи: живая проверка сверяет это с интерфейсом.
      exports.slots = { card: cardSlot, chip: chipSlot }
    }

    module.exports = { apply, inject: ['slots', 'locale', 'settingsScope'], helpers }
    return module.exports
  },
})

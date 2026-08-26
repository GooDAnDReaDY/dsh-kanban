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

    function normalizeBoard(payload) {
      const columns = payload && Array.isArray(payload.columns) && payload.columns.length > 0
        ? payload.columns
        : COLUMN_ORDER.map((id) => ({ id, count: 0, limit: undefined, overLimit: false }))
      return {
        board: (payload && payload.board) || 'main',
        boards: payload && Array.isArray(payload.boards) ? payload.boards : [],
        columns,
        tasks: payload && Array.isArray(payload.tasks) ? payload.tasks : [],
      }
    }

    function reposOf(tasks) {
      const seen = []
      for (const t of tasks || []) {
        if (typeof t.repo === 'string' && t.repo !== '' && seen.indexOf(t.repo) < 0) seen.push(t.repo)
      }
      return seen.sort()
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
     * Идентификатор сессии для чипа. Ядро отдаёт его либо свойством, либо
     * через useSession — берём первое, что есть.
     */
    function chipSessionId(props, session) {
      return String((props && props.sessionId) || (session && (session.sessionId || session.id)) || '').trim()
    }

    const helpers = {
      neighboursFor, tasksOf, cardRef, cardStatus, normalizeBoard, reposOf, errorKey,
      chipSessionId, COLUMN_ORDER,
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
      // доска
      '.dkb-screen{display:flex;flex-direction:column;height:100%;min-height:0;gap:12px;padding:16px;box-sizing:border-box}' +
      '.dkb-bar{display:flex;align-items:center;gap:10px;flex:none;flex-wrap:wrap}' +
      '.dkb-barTitle{color:var(--dsw-alias-label-primary);font-size:17px;font-weight:600;margin-right:auto}' +
      '.dkb-cols{display:flex;gap:12px;flex:1;min-height:0;overflow-x:auto;align-items:flex-start}' +
      '.dkb-col{flex:0 0 260px;display:flex;flex-direction:column;min-height:120px;max-height:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:10px;box-sizing:border-box;gap:8px}' +
      '.dkb-colOver{border-color:var(--dsw-alias-label-dimmed)}' +
      '.dkb-colHead{display:flex;align-items:baseline;gap:8px}' +
      '.dkb-colName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;flex:1;min-width:0}' +
      '.dkb-count{color:var(--dsw-alias-label-secondary);font-size:12px}' +
      '.dkb-countOver{color:var(--dsw-alias-label-error);font-weight:600}' +
      '.dkb-list{display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:32px;flex:1}' +
      '.dkb-taskCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:10px;cursor:grab;display:flex;flex-direction:column;gap:6px}' +
      '.dkb-taskCard:hover{border-color:var(--dsw-alias-label-dimmed)}' +
      '.dkb-taskRef{color:var(--dsw-alias-label-secondary);font-size:11px}' +
      '.dkb-taskTitle{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.35}' +
      '.dkb-tags{display:flex;flex-wrap:wrap;gap:4px}' +
      '.dkb-tag{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px}' +
      '.dkb-panel{position:fixed;top:0;right:0;bottom:0;width:min(420px,92vw);background:var(--dsw-alias-bg-layer-2);border-left:1px solid var(--dsw-alias-border-l2);padding:16px;box-sizing:border-box;overflow-y:auto;display:flex;flex-direction:column;gap:12px;z-index:40}' +
      '.dkb-panelBody{white-space:pre-wrap;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;margin:0}' +
      '.dkb-log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}' +
      '.dkb-logRow{color:var(--dsw-alias-label-secondary);font-size:12px}' +
      '.dkb-dialog{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:50}' +
      '.dkb-dialogBox{width:min(560px,94vw);max-height:86vh;overflow-y:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}' +
      '.dkb-issue{appearance:none;font:inherit;text-align:left;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;color:var(--dsw-alias-label-primary);font-size:13px}' +
      '.dkb-issueUsed{opacity:.5}' +
      '.dkb-row{display:flex;gap:8px;align-items:center}' +
      '.dkb-chip{appearance:none;font:inherit;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}' +
      '.dkb-chipWrap{position:relative;display:inline-flex}' +
      '.dkb-chipPanel{position:absolute;top:calc(100% + 6px);right:0;z-index:30;min-width:220px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px}'

    // ---------------------------------------------------------------- строки

    const en = {
      'title': 'Kanban',
      'subtitle': 'Task board: Gitea issues and a session per task',
      'section.label': 'Tasks',
      'group.gitea': 'Gitea',
      'group.general': 'General',
      'field.giteaUrl': 'Instance URL',
      'field.giteaTokenRef': 'Credential name',
      'hint.giteaUrl': 'For example https://gitea.example.com. Empty means importing is unavailable.',
      'hint.giteaTokenRef': 'The NAME of a DSH credential holding the token. Never type the token itself here.',
      'group.labels': 'Gitea labels per column',
      'group.limits': 'Column limits',
      'field.defaultProjectRoot': 'Project root',
      'field.startPrompt': 'First message template',
      'field.labelInProgress': 'In progress',
      'field.labelReview': 'Review',
      'field.labelDeploy': 'Deploy',
      'field.labelCleanup': 'Cleanup',
      'field.wipInProgress': 'In progress limit',
      'field.wipReview': 'Review limit',
      'hint.defaultProjectRoot': 'Where project working copies live. Empty means the harness working directory.',
      'hint.startPrompt': 'Template for the first message to the agent. Empty means the built-in template.',
      'hint.label': 'Empty means no label is set for this column.',
      'hint.limit': 'Zero means no limit. Going over is highlighted, never blocked.',
      'hint.noLabelColumns': 'Backlog and Done carry no label by design.',
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
      'board.limit': 'limit {n}',
      'board.newTask': '+ Task',
      'board.refresh': 'Refresh',
      'board.allRepos': 'all repositories',
      'board.repo': 'repository',
      'dialog.title': 'New task',
      'dialog.own': 'Own task',
      'dialog.fromGitea': 'From Gitea',
      'dialog.owner': 'Owner',
      'dialog.repo': 'Repository',
      'dialog.search': 'Search',
      'dialog.taskTitle': 'Title',
      'dialog.create': 'Create',
      'dialog.cancel': 'Cancel',
      'dialog.imported': 'already on the board',
      'dialog.noIssues': 'No open issues found.',
      'panel.close': 'Close',
      'panel.issue': 'Issue',
      'panel.log': 'Transitions',
      'panel.noLog': 'No transitions yet.',
      'panel.refresh': 'Refresh from Gitea',
      'panel.delete': 'Delete',
      'panel.start': 'Start',
      'panel.model': 'Model',
      'panel.starting': 'Starting…',
      'panel.startHint': 'A dedicated agent session opens for this task. Branch and worktree are created by the agent after its preflight, not here.',
      'error.startFailed': 'Could not start the session.',
      'error.modelNotSelected': 'No model selected — pick one in Settings, or type it here.',
      'chip.moveTo': 'Move to',
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
      'section.label': 'Задачи',
      'group.gitea': 'Gitea',
      'group.general': 'Общее',
      'field.giteaUrl': 'Адрес инстанса',
      'field.giteaTokenRef': 'Имя учётной записи',
      'hint.giteaUrl': 'Например https://gitea.example.com. Пусто — импорт недоступен.',
      'hint.giteaTokenRef': 'ИМЯ учётной записи DSH, в которой лежит токен. Сам токен сюда не вводить.',
      'group.labels': 'Метки Gitea по колонкам',
      'group.limits': 'Пределы колонок',
      'field.defaultProjectRoot': 'Корень проектов',
      'field.startPrompt': 'Шаблон первого сообщения',
      'field.labelInProgress': 'В работе',
      'field.labelReview': 'Ревью',
      'field.labelDeploy': 'Deploy',
      'field.labelCleanup': 'Cleanup',
      'field.wipInProgress': 'Предел «В работе»',
      'field.wipReview': 'Предел «Ревью»',
      'hint.defaultProjectRoot': 'Где лежат рабочие копии проектов. Пусто — рабочая папка харнесса.',
      'hint.startPrompt': 'Шаблон первого сообщения агенту. Пусто — встроенный шаблон.',
      'hint.label': 'Пусто — метка для этой колонки не ставится.',
      'hint.limit': 'Ноль — без предела. Превышение подсвечивается, но не запрещается.',
      'hint.noLabelColumns': 'У Backlog и Done метки нет по замыслу.',
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
      'board.limit': 'предел {n}',
      'board.newTask': '+ Задача',
      'board.refresh': 'Обновить',
      'board.allRepos': 'все репозитории',
      'board.repo': 'репозиторий',
      'dialog.title': 'Новая задача',
      'dialog.own': 'Своя задача',
      'dialog.fromGitea': 'Из Gitea',
      'dialog.owner': 'Владелец',
      'dialog.repo': 'Репозиторий',
      'dialog.search': 'Найти',
      'dialog.taskTitle': 'Заголовок',
      'dialog.create': 'Создать',
      'dialog.cancel': 'Отмена',
      'dialog.imported': 'уже на доске',
      'dialog.noIssues': 'Открытых issue не найдено.',
      'panel.close': 'Закрыть',
      'panel.issue': 'Issue',
      'panel.log': 'Переходы',
      'panel.noLog': 'Переходов пока нет.',
      'panel.refresh': 'Обновить из Gitea',
      'panel.delete': 'Удалить',
      'panel.start': 'Начать',
      'panel.model': 'Модель',
      'panel.starting': 'Запускается…',
      'panel.startHint': 'Откроется отдельная сессия агента по этой задаче. Ветку и worktree заводит агент после preflight, а не отсюда.',
      'error.startFailed': 'Не удалось поднять сессию.',
      'error.modelNotSelected': 'Модель не выбрана — задайте её в настройках или укажите здесь.',
      'chip.moveTo': 'Перенести в',
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
      { field: 'labelInProgress', kind: 'text', group: 'labels' },
      { field: 'labelReview', kind: 'text', group: 'labels' },
      { field: 'labelDeploy', kind: 'text', group: 'labels' },
      { field: 'labelCleanup', kind: 'text', group: 'labels' },
      { field: 'wipInProgress', kind: 'number', group: 'limits' },
      { field: 'wipReview', kind: 'number', group: 'limits' },
    ]

    function hintKey(spec) {
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
            if (spec.group === 'labels') {
              rows.push(React.createElement('p', { className: 'dkb-hint', key: 'g-note' }, t('hint.noLabelColumns')))
            }
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

    // ------------------------------------------------------------ экран доски

    function TaskCard(props) {
      const { task, t } = props
      const ref = cardRef(task)
      const status = cardStatus(task)
      return React.createElement('div', {
        className: 'dkb-taskCard',
        draggable: true,
        onDragStart: (e) => {
          try { e.dataTransfer.setData('text/plain', task.id) } catch { /* не всякий носитель умеет */ }
          props.onDragStart(task)
        },
        onClick: () => props.onOpen(task),
      },
        ref ? React.createElement('div', { className: 'dkb-taskRef' }, ref) : null,
        React.createElement('div', { className: 'dkb-taskTitle' }, task.title),
        task.labels && task.labels.length
          ? React.createElement('div', { className: 'dkb-tags' },
            task.labels.map((l) => React.createElement('span', { className: 'dkb-tag', key: l }, l)))
          : null,
        status ? React.createElement('div', { className: 'dkb-taskRef' }, status) : null,
      )
    }

    function BoardScreen(props) {
      const t = props.t || fallbackT
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [repo, setRepo] = React.useState('')
      const [openTask, setOpenTask] = React.useState(null)
      const [log, setLog] = React.useState([])
      const [dialog, setDialog] = React.useState(null)
      const [overColumn, setOverColumn] = React.useState('')
      const [model, setModel] = React.useState('')
      const [starting, setStarting] = React.useState(false)
      const dragged = React.useRef(null)

      const load = React.useCallback(async (nextRepo) => {
        try {
          const query = nextRepo ? '?board=main&repo=' + encodeURIComponent(nextRepo) : '?board=main'
          setState(normalizeBoard(await api('/board' + query)))
          setError('')
        } catch (e) {
          setError(t(e.key || 'error.unknown'))
        }
      }, [t])

      React.useEffect(() => { load(repo) }, [load, repo])

      React.useEffect(() => {
        let alive = true
        api('/models')
          .then((out) => { if (alive && out && out.current) setModel(out.current.model || '') })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      const drop = React.useCallback(async (column, index) => {
        const task = dragged.current
        dragged.current = null
        setOverColumn('')
        if (!task || !state) return
        const columnTasks = tasksOf(state.tasks, column)
        const where = neighboursFor(columnTasks, task.id, index)
        // Рисуем на новом месте сразу, но при отказе возвращаем обратно:
        // иначе карточка «прилипнет» к месту, куда её не переставили.
        const optimistic = state.tasks.map((x) => (x.id === task.id ? Object.assign({}, x, { column }) : x))
        setState(Object.assign({}, state, { tasks: optimistic }))
        try {
          await api('/task/' + encodeURIComponent(task.id) + '/move', {
            method: 'POST',
            body: JSON.stringify({ column, beforeId: where.beforeId, afterId: where.afterId }),
          })
          await load(repo)
        } catch (e) {
          setError(t(e.key || 'error.unknown'))
          await load(repo)
        }
      }, [state, load, repo, t])

      const openPanel = React.useCallback(async (task) => {
        setOpenTask(task)
        try {
          const out = await api('/task/' + encodeURIComponent(task.id) + '/log')
          setLog(out.transitions || [])
        } catch { setLog([]) }
      }, [])

      const style = React.createElement('style', null, css)

      if (state === null) {
        return React.createElement('div', { className: 'dkb-screen' }, style,
          React.createElement('p', { className: 'dkb-note' }, error || t('board.loading')))
      }

      const repos = reposOf(state.tasks)

      const bar = React.createElement('div', { className: 'dkb-bar' },
        React.createElement('span', { className: 'dkb-barTitle' }, t('section.label')),
        React.createElement('select', {
          className: 'dkb-input', style: { width: 'auto' }, value: repo,
          onChange: (e) => setRepo(e.target.value),
        },
          React.createElement('option', { value: '' }, t('board.allRepos')),
          repos.map((r) => React.createElement('option', { value: r, key: r }, r)),
        ),
        React.createElement('button', { type: 'button', className: 'dkb-discard', onClick: () => load(repo) }, t('board.refresh')),
        React.createElement('button', { type: 'button', className: 'dkb-save', onClick: () => setDialog({ mode: 'own', title: '', owner: '', repo: '', issues: null, error: '' }) }, t('board.newTask')),
      )

      const columns = React.createElement('div', { className: 'dkb-cols' },
        state.columns.map((col) => {
          const items = tasksOf(state.tasks, col.id)
          return React.createElement('div', {
            className: 'dkb-col' + (overColumn === col.id ? ' dkb-colOver' : ''),
            key: col.id,
            onDragOver: (e) => { e.preventDefault(); setOverColumn(col.id) },
            onDragLeave: () => setOverColumn(''),
            onDrop: (e) => { e.preventDefault(); drop(col.id, items.length) },
          },
            React.createElement('div', { className: 'dkb-colHead' },
              React.createElement('span', { className: 'dkb-colName' }, t('column.' + col.id)),
              React.createElement('span', {
                className: 'dkb-count' + (col.overLimit ? ' dkb-countOver' : ''),
              }, col.limit !== undefined && col.limit !== null
                ? items.length + ' / ' + t('board.limit', { n: col.limit })
                : String(items.length)),
            ),
            React.createElement('div', { className: 'dkb-list' },
              items.map((task, i) => React.createElement('div', {
                key: task.id,
                onDragOver: (e) => { e.preventDefault(); e.stopPropagation() },
                onDrop: (e) => { e.preventDefault(); e.stopPropagation(); drop(col.id, i) },
              }, React.createElement(TaskCard, {
                task, t,
                onDragStart: (x) => { dragged.current = x },
                onOpen: openPanel,
              }))),
            ),
          )
        }),
      )

      const panel = openTask
        ? React.createElement('div', { className: 'dkb-panel' },
          React.createElement('div', { className: 'dkb-row' },
            React.createElement('span', { className: 'dkb-title', style: { flex: 1 } }, openTask.title),
            React.createElement('button', { type: 'button', className: 'dkb-discard', onClick: () => setOpenTask(null) }, t('panel.close')),
          ),
          cardRef(openTask) ? React.createElement('div', { className: 'dkb-taskRef' }, cardRef(openTask)) : null,
          openTask.issueUrl
            ? React.createElement('a', { className: 'dkb-taskRef', href: openTask.issueUrl, target: '_blank', rel: 'noreferrer' }, t('panel.issue'))
            : null,
          React.createElement('p', { className: 'dkb-panelBody' }, openTask.body || ''),
          React.createElement('div', { className: 'dkb-group' }, t('panel.log')),
          log.length
            ? React.createElement('ul', { className: 'dkb-log' }, log.map((row) => React.createElement('li', {
              className: 'dkb-logRow', key: row.id,
            }, `${t('column.' + row.toCol)} ← ${row.source}${row.detail ? ' · ' + row.detail : ''}`)))
            : React.createElement('p', { className: 'dkb-note' }, t('panel.noLog')),
          React.createElement('div', { className: 'dkb-group' }, t('panel.start')),
          React.createElement('p', { className: 'dkb-hint' }, t('panel.startHint')),
          React.createElement('div', { className: 'dkb-field' },
            React.createElement('span', { className: 'dkb-label' }, t('panel.model')),
            React.createElement('input', {
              className: 'dkb-input', value: model, disabled: starting,
              onChange: (e) => setModel(e.target.value),
            }),
          ),
          React.createElement('div', { className: 'dkb-foot' },
            React.createElement('p', { className: 'dkb-note' }),
            React.createElement('button', {
              type: 'button', className: 'dkb-save', disabled: starting,
              onClick: async () => {
                // Кнопка блокируется на время запроса: двойное нажатие подняло
                // бы две сессии по одной задаче.
                setStarting(true)
                try {
                  await api('/task/' + encodeURIComponent(openTask.id) + '/start', {
                    method: 'POST',
                    body: JSON.stringify(model ? { model } : {}),
                  })
                  setOpenTask(null)
                  await load(repo)
                } catch (e) {
                  setError(t(e.key || 'error.unknown'))
                } finally {
                  setStarting(false)
                }
              },
            }, starting ? t('panel.starting') : t('panel.start')),
          ),
        )
        : null

      const dialogEl = dialog
        ? React.createElement('div', { className: 'dkb-dialog', onClick: () => setDialog(null) },
          React.createElement('div', { className: 'dkb-dialogBox', onClick: (e) => e.stopPropagation() },
            React.createElement('span', { className: 'dkb-title' }, t('dialog.title')),
            React.createElement('div', { className: 'dkb-row' },
              React.createElement('button', {
                type: 'button', className: dialog.mode === 'own' ? 'dkb-save' : 'dkb-discard',
                onClick: () => setDialog(Object.assign({}, dialog, { mode: 'own', error: '' })),
              }, t('dialog.own')),
              React.createElement('button', {
                type: 'button', className: dialog.mode === 'gitea' ? 'dkb-save' : 'dkb-discard',
                onClick: () => setDialog(Object.assign({}, dialog, { mode: 'gitea', error: '' })),
              }, t('dialog.fromGitea')),
            ),
            dialog.error ? React.createElement('p', { className: 'dkb-failed' }, dialog.error) : null,
            dialog.mode === 'own'
              ? React.createElement('div', { className: 'dkb-field' },
                React.createElement('span', { className: 'dkb-label' }, t('dialog.taskTitle')),
                React.createElement('input', {
                  className: 'dkb-input', value: dialog.title,
                  onChange: (e) => setDialog(Object.assign({}, dialog, { title: e.target.value })),
                }),
                React.createElement('div', { className: 'dkb-foot' },
                  React.createElement('button', { type: 'button', className: 'dkb-discard', onClick: () => setDialog(null) }, t('dialog.cancel')),
                  React.createElement('button', {
                    type: 'button', className: 'dkb-save',
                    onClick: async () => {
                      try {
                        await api('/task', { method: 'POST', body: JSON.stringify({ title: dialog.title }) })
                        setDialog(null)
                        await load(repo)
                      } catch (e) {
                        setDialog(Object.assign({}, dialog, { error: t(e.key || 'error.unknown') }))
                      }
                    },
                  }, t('dialog.create')),
                ),
              )
              : React.createElement('div', null,
                React.createElement('div', { className: 'dkb-row' },
                  React.createElement('input', {
                    className: 'dkb-input', placeholder: t('dialog.owner'), value: dialog.owner,
                    onChange: (e) => setDialog(Object.assign({}, dialog, { owner: e.target.value })),
                  }),
                  React.createElement('input', {
                    className: 'dkb-input', placeholder: t('dialog.repo'), value: dialog.repo,
                    onChange: (e) => setDialog(Object.assign({}, dialog, { repo: e.target.value })),
                  }),
                  React.createElement('button', {
                    type: 'button', className: 'dkb-discard',
                    onClick: async () => {
                      try {
                        const out = await api('/gitea/issues?owner=' + encodeURIComponent(dialog.owner) +
                          '&repo=' + encodeURIComponent(dialog.repo))
                        setDialog(Object.assign({}, dialog, { issues: out.issues || [], error: '' }))
                      } catch (e) {
                        setDialog(Object.assign({}, dialog, { issues: [], error: t(e.key || 'error.unknown') }))
                      }
                    },
                  }, t('dialog.search')),
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
                          try {
                            await api('/import', {
                              method: 'POST',
                              body: JSON.stringify({ owner: dialog.owner, repo: dialog.repo, issueNumber: issue.number }),
                            })
                            setDialog(null)
                            await load(repo)
                          } catch (e) {
                            setDialog(Object.assign({}, dialog, { error: t(e.key || 'error.unknown') }))
                          }
                        },
                      }, `#${issue.number} ${issue.title}${issue.imported ? ' · ' + t('dialog.imported') : ''}`))),
              ),
          ))
        : null

      return React.createElement('div', { className: 'dkb-screen' },
        style, bar,
        error ? React.createElement('p', { className: 'dkb-failed' }, error) : null,
        columns, panel, dialogEl,
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
      const [open, setOpen] = React.useState(false)
      const session = props.useSession ? props.useSession((s) => s) : null
      const sessionId = chipSessionId(props, session)

      React.useEffect(() => {
        let alive = true
        if (!sessionId) { setTask(null); return () => {} }
        api('/session/' + encodeURIComponent(sessionId) + '/task')
          .then((out) => { if (alive) setTask((out && out.task) || null) })
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
          COLUMN_ORDER.map((id) => React.createElement('button', {
            type: 'button', key: id,
            className: id === task.column ? 'dkb-save' : 'dkb-discard',
            onClick: () => move(id),
          }, t('column.' + id))),
        ) : null,
      )
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

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dsh-kanban: словари')

      // Карточка настроек. Ключ обязан совпадать с пространством настроек:
      // вкладка перебирает объявленные пространства и рисует слот с entryKey,
      // равным имени пространства.
      const cardSlot = registerFirst(ctx, [
        { name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({ ctx }) },
        { name: 'settings.section', id: '@goodandready/dsh-kanban', order: 32, locale: NS, label: () => fallbackT('title'), inject: () => ({ ctx }) },
      ], KanbanSettingsCard)

      // Экран доски. Свой раздел верхнего уровня оправдан только здесь —
      // доска это подсистема со своей навигацией, а не набор полей.
      const boardSlot = registerFirst(ctx, [
        { name: 'app.section', id: '@goodandready/dsh-kanban.board', order: 40, locale: NS, label: () => fallbackT('section.label'), inject: () => ({ ctx }) },
        { name: 'sidebar.section', id: '@goodandready/dsh-kanban.board', order: 40, locale: NS, label: () => fallbackT('section.label'), inject: () => ({ ctx }) },
        { name: 'settings.section', id: '@goodandready/dsh-kanban.board', order: 33, locale: NS, label: () => fallbackT('section.label'), inject: () => ({ ctx }) },
      ], BoardScreen)

      // Чип задачи в шапке чата. Слот подтверждён живым плагином dsh-gitea.
      const chipSlot = registerFirst(ctx, [
        { name: 'conversation.session.header.utilities', id: '@goodandready/dsh-kanban.chip', order: 26, locale: NS, inject: () => ({ ctx }) },
      ], TaskChip)

      // Куда встали — видно снаружи: живая проверка сверяет это с интерфейсом.
      exports.slots = { card: cardSlot, board: boardSlot, chip: chipSlot }
    }

    module.exports = { apply, inject: ['slots', 'locale', 'settingsScope'], helpers }
    return module.exports
  },
})

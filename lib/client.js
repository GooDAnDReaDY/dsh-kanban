// Браузерная половина dsh-kanban.
//
// Идентификатор ниже обязан совпадать с `name` в package.json и с `name:` в
// cordis.patch.yml. Расхождение НЕ даёт ошибки в журнале: загрузчик молча не
// разрешает пакет, серверная половина работает, интерфейса нет.
window.__ModuleLoader__.load({
  id: '@goodandready/dsh-kanban',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const NS = 'dsh-kanban'

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
      '.dkb-discard:disabled,.dkb-save:disabled{opacity:.4;cursor:default}'

    // Поля карточки. Порядок здесь задаёт порядок на экране.
    const FIELDS = [
      { field: 'defaultProjectRoot', kind: 'text', group: 'general' },
      { field: 'startPrompt', kind: 'area', group: 'general' },
      { field: 'labelInProgress', kind: 'text', group: 'labels' },
      { field: 'labelReview', kind: 'text', group: 'labels' },
      { field: 'labelDeploy', kind: 'text', group: 'labels' },
      { field: 'labelCleanup', kind: 'text', group: 'labels' },
      { field: 'wipInProgress', kind: 'number', group: 'limits' },
      { field: 'wipReview', kind: 'number', group: 'limits' },
    ]

    const en = {
      'title': 'Kanban',
      'subtitle': 'Task board: Gitea issues and a session per task',
      'group.general': 'General',
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
      'hint.limit': 'Zero means no limit. Going over the limit is highlighted, never blocked.',
      'hint.noLabelColumns': 'Backlog and Done carry no label by design.',
      'settings.loading': 'Loading settings…',
      'settings.unavailable': 'The host does not know the dsh-kanban settings namespace. Restart the Web UI after installing the plugin.',
      'settings.readOnly': 'Settings are read-only in this session.',
      'settings.saveFailed': 'Failed to save: {fields}',
      'settings.saved': 'Saved.',
      'save': 'Save',
      'discard': 'Discard',
    }

    const ru = {
      'title': 'Канбан',
      'subtitle': 'Доска задач: issue из Gitea и отдельная сессия под задачу',
      'group.general': 'Общее',
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
    }

    /** Переводчик с откатом на английский, а затем на сам ключ. */
    function fallbackT(key, vars) {
      let text = ru[key] ?? en[key] ?? key
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.split('{' + name + '}').join(String(value))
        }
      }
      return text
    }

    function hintKey(spec) {
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

    /**
     * Карточка настроек во вкладке «Настройки → Плагины».
     *
     * Своего раздела верхнего уровня плагин здесь НЕ заводит: боковой список
     * ядро строит плоским, и каждая строка в нём — общий ресурс. Раздел
     * появится отдельно и только под экран доски.
     */
    function KanbanSettingsCard(props) {
      // Все хуки объявлены выше любого возврата. Ранний возврат над хуком даёт
      // React error 310 при первом же изменении состояния — карточка работает,
      // пока на неё не нажмёшь.
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

      const status = snapshot?.status ?? 'loading'
      const stored = snapshot?.value ?? {}

      const valueOf = React.useCallback((field) => {
        if (draft && Object.hasOwn(draft, field)) return draft[field]
        const current = stored[field]
        return current === undefined ? '' : String(current)
      }, [draft, stored])

      const edit = React.useCallback((field, text) => {
        setSaved(false)
        setDraft((prev) => Object.assign({}, prev, { [field]: text }))
      }, [])

      const discard = React.useCallback(() => {
        setDraft(null)
        setFailed('')
        setSaved(false)
      }, [])

      const save = React.useCallback(async () => {
        if (!scope || !draft) return
        setSaving(true)
        setFailed('')
        setSaved(false)
        // Пишем ВСЕ поля, а не до первой ошибки: цикл, обрывающийся на первой
        // неудаче, оставляет остальные поля незаписанными и сигналы
        // неразосланными, а снаружи это выглядит как «кнопка не работает».
        const broken = []
        for (const spec of FIELDS) {
          if (!Object.hasOwn(draft, spec.field)) continue
          const raw = draft[spec.field]
          let next = raw
          if (spec.kind === 'number') {
            const parsed = Number(String(raw).trim())
            if (!Number.isFinite(parsed)) { broken.push(spec.field); continue }
            next = parsed
          }
          try {
            await scope.set(spec.field, next)
          } catch {
            broken.push(spec.field)
          }
        }
        setSaving(false)
        if (broken.length) {
          const names = broken.map((f) => t('field.' + f)).join(', ')
          setFailed(t('settings.saveFailed', { fields: names }))
          return
        }
        setDraft(null)
        setSaved(true)
      }, [scope, draft, t])

      // Ниже — только возвраты. Проверяем СТАТУС снимка, а не значение: при
      // `unavailable` поле writable берётся из документа и остаётся истинным,
      // поэтому карточка нарисовала бы пустую, но с виду рабочую форму.
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

      if (!open) {
        return React.createElement('li', { className: 'dkb-card' }, style, head)
      }

      let body
      if (status === 'loading') {
        body = React.createElement('p', { className: 'dkb-note', role: 'status' }, t('settings.loading'))
      } else if (status !== 'ready') {
        body = React.createElement('p', { className: 'dkb-failed', role: 'status' }, t('settings.unavailable'))
      } else {
        const writable = snapshot?.writable !== false
        const rows = []
        let lastGroup
        for (const spec of FIELDS) {
          if (spec.group !== lastGroup) {
            lastGroup = spec.group
            rows.push(React.createElement('div', { className: 'dkb-group', key: 'g-' + spec.group },
              t('group.' + spec.group)))
            if (spec.group === 'labels') {
              rows.push(React.createElement('p', { className: 'dkb-hint', key: 'g-labels-note' },
                t('hint.noLabelColumns')))
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
        let note = null
        if (failed) note = React.createElement('p', { className: 'dkb-failed', role: 'status' }, failed)
        else if (!writable) note = React.createElement('p', { className: 'dkb-note', role: 'status' }, t('settings.readOnly'))
        else if (saved) note = React.createElement('p', { className: 'dkb-note', role: 'status' }, t('settings.saved'))
        else note = React.createElement('p', { className: 'dkb-note' })

        rows.push(React.createElement('div', { className: 'dkb-foot', key: 'foot' },
          note,
          React.createElement('button', {
            type: 'button', className: 'dkb-discard', disabled: !dirty || saving, onClick: discard,
          }, t('discard')),
          React.createElement('button', {
            type: 'button', className: 'dkb-save', disabled: !dirty || saving || !writable, onClick: save,
          }, t('save')),
        ))
        body = rows
      }

      return React.createElement('li', { className: 'dkb-card dkb-cardOpen' },
        style, head,
        React.createElement('div', { className: 'dkb-body' }, body),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dsh-kanban: словари')
      // Ключ слота обязан совпадать с пространством настроек: вкладка
      // перебирает объявленные пространства и рисует слот с entryKey, равным
      // имени пространства. Не совпал — карточки не будет, молча.
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
        {
          name: 'settings.plugin.item',
          key: NS,
          locale: NS,
          inject: () => ({ ctx }),
        },
        KanbanSettingsCard,
      ))
    }

    module.exports = { apply, inject: ['slots', 'locale', 'settingsScope'] }
    return module.exports
  },
})

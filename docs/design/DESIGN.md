# DESIGN.md — dsh-kanban

## Product / Purpose
- Назначение: Интегрированная доска задач для DeepSeek Harness с двусторонней сверкой с Gitea и GitHub, автоматическим подхватом сессий агентов и управлением жизненным циклом.
- Аудитория: Разработчики и операторы DeepSeek Harness, ведущие проектные задачи и сессии агентов.
- Статус: Production, версия 0.2.22.

## User Surfaces
- Web/UI: Экран доски в центральной колонке интерфейса DSH (mountBoard), выдвигающаяся панель задач, фильтры, группировки (по проектам, по исполнителю), метрики переходов.
- DSH UI / settings / slots:
  - Карточка настроек в слоте settings.plugin.item (пространство dsh-kanban).
  - Чип активной задачи в conversation.session.header.utilities.
  - Пункт бокового меню для вызова экрана доски.
- API: HTTP эндпоинты /dsh-kanban/* (board, snapshot, task, sync, webhook, metrics, whoami, checklist, report, comments, accept, reject).
- CLI: node tools/compat.mjs (проверка совместимости экспортов ядра).
- Документация: [README.md](../../README.md), [README.ru.md](../../README.ru.md), [README.zh.md](../../README.zh.md), [docs/index.md](../index.md).

## Visual Direction
- Атмосфера: Строгий утилитарный инструментальный интерфейс в едином стиле темы DeepSeek Harness.
- Утверждённые референсы и что из них берём: Системные карточки DSH (стили заголовков, отступы, шрифты, цветовые токены --dsw-alias-*).
- Не копировать: Внешние неинтегрированные темы, разнородные цвета рамок и теней.

## Foundations
- Цвета и роли: Использование CSS-переменных DSH темы (--dsw-alias-bg-layer-3, --dsw-alias-border-l2, --dsw-alias-label-primary, --dsw-alias-label-secondary).
- Типографика: Системный стек шрифтов DSH (inherit, 13-14px базовый размер, 11-12px для бейджей и служебных меток).
- Сетка, отступы, responsive: 6 канонических колонок (backlog, in-progress, review, deploy, cleanup, done) с горизонтальным скроллом и адаптивными карточками. Колонка done является строгим человеческим шлюзом приёмки (Human-only DoD acceptance gate); автоматические процессы и агенты переводят задачи только в review.
- Accessibility: Нативные кнопки button, role="status" для сообщений, семантичные поля ввода с aria-label/label.

## Components And States
- Компоненты: BoardScreen, Column, Card, TaskDrawer (включая секции DoD Checklist, Execution Report, Comments Thread, Review Acceptance Gate), KanbanSettingsCard, TaskChip, MetricsModal.
- Loading / empty / error / success:
  - Загрузка: состояние скелетона/лоадера без блокировки скролла.
  - Пустые колонки: пунктирная область перетаскивания.
  - Ошибки: всплывающий баннер с ключом локализации t('error.' + err).
- Формы, валидация и действия: Валидация обязательных полей при создании задачи, блокировка повторных кликов при сохранении.

## User Flows
- Критические сценарии:
  1. Создание задачи / подхват из Gitea Issue.
  2. Перемещение карточки между колонками человеком или через инструмент агента board_move.
  3. Запуск сессии агента по карточке с автоматическим назначением ответственного.
  4. Автоматическое обновление статуса (waiting) по событиям ядра (session/event).
  5. Экспорт и импорт снимка доски в JSON.

## Do / Don't
- Do: Использовать только токены темы --dsw-alias-*, очищать все слушатели событий при размонтировании, соблюдать порядок хуков React.
- Don't: Не переводить карточку в done агентом (колонка done фиксируется только по факту закрытия issue и ветки).

## Locked Design Decisions
- 2026-08-20 — Карточка настроек монтируется в settings.plugin.item (резерв в settings.section исключён по #238).
- 2026-08-25 — Использование дробной индексации ($O(1)$) для позиционирования карточек.
- 2026-09-02 — Снимок доски объединён на маршруте /dsh-kanban/snapshot (GET: выгрузка, POST: загрузка).
- 2026-09-03 — Изоляция сессий задач в git worktree ($DSH_HOME/worktrees/<repo-key>/<task-id>/ на ветке task/<id>-<slug>), регистрация воркдерева в workspaceRegistry, проверка dirtyFiles и безопасная очистка в фазе cleanup (#193).
- 2026-09-03 — Серверная инфраструктура автономности и безопасности (#195): Host-Side 5-field Cron, PowerInhibitor (кроссплатформенная блокировка сна системы во время работы задач), PROGRESSDUMP (фиксация срезов контекста, маскирование секретов и передача эстафеты), Permission Confirmation Gate (ручное одобрение прав выше базовых), инъекция секции доски в systemPrompt и хранение истории запусков прямо в карточке задачи (tasks.runs).

- 2026-09-07 — Контур качества и приёмка человеком (#205–#209):
  - Протокольный шлюз: колонка done является исключительной границей приёмки человеком; инструменту board_move запрещён прямой перевод задачи в done.
  - DoD Acceptance Checklist: перевод в review блокируется до закрытия обязательных пунктов чеклиста с фиксацией доказательств (evidence).
  - Structured Report: фиксация отчёта выполнения (summary, changedFiles, checksRun, artifacts, risks) в карточке задачи.
  - Двусторонний цикл приёмки: явные действия человека Accept (в done) и Reject (возврат в in-progress с обязательной причиной rejectReason, инжектируемой в следующую сессию агента).
  - Ветка комментариев к задаче с поддержкой ролей user и agent для сквозного диалога прямо в Task Drawer.

- 2026-09-08 — Стабильность сессий и воркдеревьев (#227, #226, #213, #215):
  - Привязка проекта сессии: при создании агента с воркдеревом поле meta.cwd сохраняет канонический projectRoot (repoDir), предотвращая выпадение сессий в категорию «Ungrouped» в сайдбаре DSH; путь воркдерева передается в meta.worktreePath и инструкциях агента (#227).
  - Режим «↻ Продолжить» (Resume Execution): эндпоинт POST /dsh-kanban/tasks/:id/resume и кнопка в TaskDrawer; сохраняет существующее воркдерево, ветку и незакоммиченные файлы, передавая агенту преамбулу продолжения и актуальный PROGRESSDUMP (#226).
  - Фильтрация structural noise в проверках dirtyFiles: в checkWorktreeDirty добавлен флаг --ignore-submodules=all, исключающий ложные блокировки удаления воркдеревьев из-за субмодулей и дрейфа gitlinks (#213).
  - Фильтрация сессий субагентов: сессии с маркером subagent (origin === 'subagent' или parentId !== undefined) исключаются из liveSessions и не перезаписывают состояние корневых задач (#215).
## Locked Decisions
- **0.2.8 (Issue #254)**: Комплексное приведение к стандартам DSH-скиллов (`dsh-plugin-authoring`, `dsh-documentation-standard`, `quality-gate`):
  - **Multi-Language Standard**: Устранен русский хардкод в ядре плагина (`DEFAULT_BOARDS`, `CONFIG_DEFAULTS`, `CONFIG_HINTS` в `lib/config.js` и сценарные инструкции агенту в `lib/commands.js` переведены на канонический English; перевод на русский осуществляется централизованно через `dsh-russian-lang`).
  - **Изоляция стилей**: Зафиксирован атрибут `style.dataset.dshPlugin = 'dsh-kanban'` в `lib/client.js` для гарантированной защиты стилей доски от сброса при HMR/перезапуске соседних плагинов.
  - **Автоматический AST Quality Gate**: Добавлен тест `test/ast-scope.test.mjs`, выполняющий синтаксическую валидацию всех 24 модулей в `lib/` и валидацию отсутствия необъявленных глобальных идентификаторов (`ReferenceError` immunity).
  - **Устойчивость тестов на Windows**: Внедрено явное закрытие дескрипторов базы данных SQLite `store.close()` во всех тестовых cleanup-хуках перед вызовом `rmSync`, предотвращающее ошибки `EPERM`.
- **0.2.6 (Issue #246)**: Исправлен критический сбой загрузки плагина в Cordis loader (`ReferenceError`): добавлен явный импорт `import z from '@deepseek-ai/schemastery'`, `openStore`, `CONFIG_DEFAULTS`, `CONFIG_HINTS`, `rootOf`, `join`, `homedir` в `lib/index.js`, а также добавлен автоматический тест валидации импорта и жизненного цикла `test/index-load.test.mjs`.
- **0.2.5 (Issue #244)**: Комплексная оптимизация производительности и размера бандла:
  - Облегчение `lib/client.js` до ~214 КБ (безопасный запас относительно лимита DSH Store 256 КБ) через сжатие служебных комментариев и алиасинг вызовов React.
  - Композитные индексы SQLite (`tasks_board_active`, `tasks_gitea_issue`, `tasks_cron_next`, `tasks_queued`) и прагмы WAL/NORMAL/OPTIMIZE для быстрого поиска и снижения блокировок ввода-вывода.
  - Оптимизация рендеринга доски: мемоизация `TaskCard` (`React.memo`), дебаунс поискового ввода и коалесценция частых SSE-событий `task:change`/`board:change` (60 мс).
  - Повышение отказоустойчивости фоновой синхронизации `lib/sync.js`: функция `withBackoff` с экспоненциальной задержкой при транзиентных сбоях сети/Gitea API.
- **0.2.2 (Issue #238)**: Удалён устаревший фоллбэк на `settings.section` в пользу строгого размещения карточки в `settings.plugin.item`; все обращения к службам Cordis (в частности к `llm`) приведены к каноническому `ctx.get('...')`.
- **0.2.1**: Карточка настроек плагина перенесена строго в слот `settings.plugin.item` (раздел «Настройки → Плагины → Настройки плагинов») без одновременной дублирующей регистрации в `settings.section` (Issue #236).

### 2026-09-08: Релиз v0.2.0 — Milestone (SSE, Chat Sync, Templates, Two-Column Drawer, Multi-Repo) (#210, #219, #220, #222, #225)
- **Live SSE Channel (`/dsh-kanban/events`)**: Постоянное SSE-соединение с автоматическим переподключением для мгновенного пуша обновлений доски (`task:change`, `board:change`) без избыточного поллинга (#222).
- **Auto-sync Sessions (`autoSyncSessions`)**: Опциональная автоматическая синхронизация стандартных диалогов чата DSH в карточки доски канбана с надежной фильтрацией внутренних сессий и субагентов (#225).
- **Task Templates Library (`/dsh-kanban/templates`)**: Библиотека из 5 встроенных типовых шаблонов (Feature, Bugfix, Refactor, Security, Release) с предзаполненными чеклистами DoD и шаблонами промптов (#220).
- **Two-Column Drawer Layout**: Адаптивный двухколоночный макет для TaskDrawer на экранах шириной от 960px с разделением метаданных и контентной области (#219).
- **Multi-Repo Workspace Mirroring**: Сканирование нескольких вложенных git-репозиториев (`findWorkspaceGitRepos`) и подготовка зеркальных воркдеревьев на единой ветке задачи (`prepareMultiRepoMirror`) (#210).

### 2026-09-13: Релиз Vector 5 (Epic Triage, Live Observability & Advanced Workflow Suite) (#248)
- **Triage & Epic Decomposition**: Превращение задачи в Эпик (`isEpic = 1`) с созданием дочерних подзадач (`parentId = <epicId>`) и связкой с Gitea issues. Отображение бейджа «👑 Epic», индикатора прогресса `{done}/{total}` и прогресс-бара на карточке, управление подзадачами в карточке задачи и инструмент агента `board_decompose`.
- **Atomic DoD Checklist Tool (`board_checklist_item`)**: Атомарное переключение пунктов чеклиста агентом по подстроке текста или индексу без перезаписи списка, эндпоинт `POST /dsh-kanban/task/:id/checklist-toggle`.
- **Live Agent Console**: Терминальный блок для сессий задач с моноширинным ANSI-стилизованным выводом и отображением прогресса.
- **Quick Filter Bar**: Быстрые фильтры над колонками (`All`, `Active`, `Review`, `Epics`, `Silent`) для мгновенного отбора задач.
- **One-Click Gitea PR**: Создание Pull Request прямо из Review Acceptance Gate (`POST /dsh-kanban/task/:id/pr`) через `gitea.createPullRequest({ head, base })` с отображением прямой ссылки на PR в Gitea.
- **Строгая чистота пакета и локализация**: Исключение `docs/plans` и `docs/design` из tarball релиза; канонический английский (`en`) + китайский (`zh`) в коде; вся русская локализация управляется через регистрацию issue в `goodandready/dsh-russian-lang`.

### 2026-09-08: Релиз Vector 4 (UX оператора, управление моделями и аналитика) (#217, #218, #221, #223, #228)
- **reasoningEffort**: Добавлен селектор глубины рассуждения (low, medium, high) в карточке `TaskDrawer`, сохраняется в SQLite и передается в метаданные сессии DSH для моделей с рассуждением (DeepSeek-R1, OpenAI o1/o3).
- **Экспорт в CSV с UTF-8 BOM**: Добавлен эндпоинт `GET /dsh-kanban/export.csv` и кнопка в тулбаре для выгрузки аналитики задач в Microsoft Excel без искажения кодировки.
- **Адаптивный 36x36 Rail Icon**: Кнопка канбана в сайдбаре автоматически принимает компактный размер 36×36 px с центрированием иконки при сворачивании панели в rail.
- **Lightbox для изображений**: Превью Markdown-изображений в карточке открываются в модальном полноэкранном лайтбоксе.


### 2026-09-13: Релиз v0.2.7 (Vector 5 Suite: Epic Triage, Atomic DoD, Quick Filters, Live Console & One-Click PR) (#248, #250, #252)
- **Epic Triage & Decomposition**: Декомпозиция задач на подзадачи с конвертацией родителя в Epic, эндпоинты `POST /task/:id/triage`, `GET /task/:id/subtasks`, `POST /task/:id/subtask`, прогресс-индикаторы на карточках и агентский инструмент `board_decompose`.
- **Atomic DoD Checklist**: Роут `POST /task/:id/checklist-toggle` и агентский инструмент `board_checklist_item` для атомарного переключения чек-листа без перезаписи всего списка.
- **Quick Filter Bar**: Панель быстрых сегментированных фильтров (`All`, `Active`, `Review`, `Epics`, `Silent`) на тулбаре доски.
- **Live Agent Console**: Моноширинный терминальный блок в выдвижной панели задачи для сессий in-progress.
- **One-Click Gitea PR**: Создание Pull Request в Gitea одной кнопкой из панели ревью задачи (`POST /task/:id/pr`).

### 2026-09-08: Релиз Vector 3 (Просмотр Git Diff / Коммитов и Однокликовый Merge) (#211, #212)
- **Git Diff & Commits Viewer**: В `TaskDrawer` интегрирован блок просмотра истории коммитов сессии и unified diff измененных файлов воркдерева (`GET /tasks/:id/diff` и `GET /tasks/:id/commits`). Diff безопасно ограничен 250 КБ.
- **One-Click Merge (--no-ff)**: В секции Review Acceptance Gate добавлена кнопка «✓ Принять и смержить» (`POST /tasks/:id/merge`). Выполняется проверка на отсутствие незакоммиченных изменений (`checkWorktreeDirty`), слияние `git merge --no-ff` в целевую ветку (`main`), автоматическая дерегистрация и удаление воркдерева с переводом задачи в `done`.


### 2026-09-08: Релиз Vector 2 (Управление параллелизмом и безопасность) (#214, #216, #224)
- **maxConcurrentSessions**: Лимит параллельных сессий агентов (по умолчанию 3) предотвращает исчерпание памяти/CPU на хосте. Задачи сверх лимита переводятся в очередь (`queuedAt > 0`) и автоматически запускаются диспетчером при завершении активных сессий.
- **workspaceClaimBoundaries**: Инструмент `board_move` проверяет принадлежность задачи к воркспейсу текущей сессии агента, предотвращая случайный межпроектный захват карточек.
- **Страховочный бэкап при импорте снимка**: `importBoard` в `/dsh-kanban/snapshot` автоматически делает снимок базы SQLite в `backups/kanban-backup-<timestamp>.db` с ротацией последних 10 копий перед перезаписью данных.


### Security & Request Trust Policy (#261, #369, #384)
- **isTrustedRequest & getRejectionStatus**: Все HTTP-маршруты плагина (`/project-task`, `/batch`, `/sessions`, `/sync`, `/snapshot`, `/task/*`, `/presets`, `/archive`, `/board`, `/whoami`, `/export.csv`, `/templates`, `/metrics`, `/models`, `/session/*`, `/gitea/*`) защищены многоуровневым периметром безопасности:
  1. **Сессионная аутентификация DSH (`connection.requestRejection`)**: Для любых не-loopback (LAN и удалённых) вызовов обязательна проверка через `ctx.connection.requestRejection(req)`. При отсутствии активной сессии DSH запросы отклоняются с HTTP 401 (`unauthorized`). Неизвестный remoteAddress обрабатывается fail-closed со статусом 403.
  2. **Защита от DNS-rebinding (`isTrustedHost`)**: Заголовок `Host` обязателен и должен указывать на доверенный хост (loopback, LAN, `.local`).
  3. **Защита от CSRF и подделки Origin/Referer**:
     - `sec-fetch-site`: значения `cross-site` и `other` немедленно отклоняются с кодом 403. Разрешены только `same-origin` и `none` (а также `same-site` для безопасных переходов).
     - `Origin` и `Referer` (при наличии) обязаны соответствовать доверенному хосту и заголовку `Host`. Значение `null` отклоняется с 403.
  4. **Автономный / тестовый режим**: При отсутствии службы `connection` (юнит-тесты без харнесса, локальные CLI-вызовы) разрешены исключительно локальные loopback-адреса (`127.0.0.1`, `::1`). Любые LAN/внешние клиенты без `connection` отклоняются с кодом 401 (fail-closed).
  5. **Периметр за обратным прокси (Reverse Proxy & X-Forwarded-For Fencing, #384)**:
     - При работе за локальным реверс-прокси (например, `dsh-lanmode` на порту 3080, пересылающем на `127.0.0.1:3000`), сетевой сокет бэкенда видит loopback-адрес `127.0.0.1`, а прокси может автоматически подмешивать сгенерированную loopback-cookie.
     - `getClientIp(req)` при loopback-сокете извлекает реальный IP клиента из первого элемента `x-forwarded-for`. Если адрес принадлежит LAN/WAN, запрос переходит под контроль удалённого периметра.
     - Для предотвращения обхода авторизации проверяется `hasClientCredentials(req)`: наличие Bearer-токена в `Authorization`, PIN-заголовка `x-dsh-lan-pin`, PIN-куки `dsh_lan_pin`/`dsh_token` или клиентской authority-сессии `dsh-auth-*` (исключая loopback-куки). Проксированные запросы без собственных клиентских реквизитов отклоняются с HTTP 401 (`unauthorized`).
     - Аналогичный барьер встроен в валидатор запросов обновления `isTrustedUpdateRequest` (`lib/updater.js`).
- **Входящий вебхук (`/dsh-kanban/webhook`)**: Защищен криптографической HMAC-подписью `x-gitea-signature` / `x-hub-signature-256` с общим секретом (`secret`), а не происхождением Origin/sec-fetch-site, поскольку запросы вебхука инициируются сервером Git Forge снаружи по отношению к браузерной сессии пользователя.


### Client Injection Policy (#265)
- **dsh.client.inject**: Клиентская часть плагина использует словарь локализации `ctx.locale` и слоты настроек интерфейса (`settings.plugin.item`), поэтому явно декларирует зависимости в манифесте `package.json`:
  ```json
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-settings"
    ]
  }
  ```
  Это гарантирует правильный порядок загрузки и доступность сервисов `locale` и `ui-settings` при инициализации бандла в web-профиле.


### Release 0.2.8 Design Updates
- **Public Task Provisioning Service (#255, #257)**:
  Экспорт сервиса `dshKanban` с контрактом `dsh-drives.task-provision.v1`. Позволяет внешним потребителям (включая `dsh-drives`) создавать и связывать задачи доски по `externalRef`.
- **UI Canonical Standards & Design System Tokens (#262, #263)**:
  Использование канонического `IconChevronDownOutline14` из `@deepseek-ai/dsh-client-ui-primitives` с адаптивным 14x14 SVG-фоллбэком и 160ms CSS-анимацией раскрытия. Полный переход на `--dsw-alias-*` переменные темы вместо захардкоженных цветов.
- **One-Click Updater & Remote Trust (#259)**:
  Эндпоинт `/api/dsh-kanban/update` с валидацией заголовка `x-dsh-plugin-update`, проверкой loopback/LAN remote address и защитой от cross-origin/sec-fetch-site. В карточке настроек отображается актуальный статус и кнопка мгновенного обновления.
- **Preflight & Code Hygiene Compliance (#268, #264)**:
  Экспорт имени модуля приведен к каноническому `@goodandready/dsh-kanban`. Устранены избыточные внутренние экспорты и пустые catch-блоки.

### Release 0.2.9 Design Updates
- **Canonical Language Compliance (#258)**:
  Все строки времени выполнения в `lib/commands.js` (`logger.warn`, `STOP_DETAIL`, `MOVE_DETAIL`) приведены к каноническому английскому языку в соответствии со стандартом локализации DSH-плагинов. Русскоязычные переводы пользовательского интерфейса обслуживаются клиентскими словарями и пакетом `dsh-russian-lang`.
- **DSH Store Package Size & Leak Protection CI (#264)**:
  Добавлен автоматический CI-тест `test/pack-size.test.mjs`, контролирующий размер всех упаковываемых файлов при `npm pack`. Тест блокирует файлы размером более 256 KiB (жёсткий лимит DSH Store) и 250 KiB (практический порог безопасности), отслеживает `lib/client.js` (~235 KiB) и гарантирует отсутствие утечки служебных файлов (`AGENTS.md`, `index.md`, `.env`, `pnpm-lock.yaml`).

### Release 0.2.14 Design Updates (#274, #279, #280, #281, #282, #283, #284)
- **Plugin Manager Row Seat Integration (#274)**:
  В соответствии с каноном `ROW-SEAT-RECIPE.md` слот `plugins.row.config` регистрируется первой выделенной веткой с ключом `@goodandready/dsh-kanban#dsh-kanban` (`rowConfigKey(bundle, rowId)`). Карточка настроек `KanbanSettingsCard` оптимизирована под контексты отображения: однострочный режим `view: 'summary'` под заголовком строки плагина и чистый bare-рендер `view: 'page'` без дублирующих рамок и шапок карточки. Слот `plugins.item` и устаревший `settings.plugin.item` сохранены в качестве обратной совместимости.
- **Runtime Integrity & Safe Lifecycle (#279, #280, #281, #282)**:
  Устранены критические `ReferenceError` при возобновлении сессий, диспетчеризации фоновой очереди и открытии панели diff/commits для задач с воркдеревьями. При выгрузке плагина `eventHub.closeAll()` гарантированно останавливает таймер heartbeat и закрывает клиентские SSE-соединения.
- **Atomic Storage Batching & Database Query Performance (#283)**:
  В `lib/store.js` внедрен механизм транзакций `store.withTransaction()` (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`), кэширование подготовленного запроса `insertTask` и композитные индексы `tasks_updated` (`updatedAt`) и `tasks_archivable` (`archivedAt, col, columnAt`), ускоряющие фильтрацию и архивацию задач.
- **Dead Code Elimination & Export Hygiene (#284)**:
  Все ранее не задействованные экспорты подключены в рабочие маршруты плагина, снижая накладные расходы и гарантируя отсутствие мертвых веток.

### Message Format v4 Compatibility (#287)
- **Producer-Owned Source Kinds**:
  В соответствии со спецификацией DSH session format v4, сообщения, отправляемые плагином в сессию через `agent.followup`, используют producer-owned source kind `source.kind: 'dsh-kanban'` вместо устаревшего родового `source.kind: 'plugin'`. Поле `source.plugin: 'dsh-kanban'` сохраняется для обратной совместимости, а назначение сообщения фиксируется в `source.form` (`task-start`, `task-resume`, `task-queued`, `batch-queued`, `board-command`). Валидация защищена набором тестов в `test/message-source-v4.test.mjs` и прямой проверкой через `assertV4RowAdmission`.

### Release 0.2.15 Design Updates (#296)
- **Full GitHub Integration & ETag Cache**:
  Полноценный клиент GitHub REST API v3 (`lib/github.js`) с поддержкой ETag-кэширования (`If-None-Match` / HTTP 304) для сохранения часового лимита запросов.
- **Composite Git Provider Routing**:
  Единый абстрактный интерфейс (`lib/git-provider.js`), прозрачно распределяющий вызовы к Gitea или GitHub на основании атрибутов задачи (`task.provider`), URL issue или настройки `gitProvider` (`auto`, `gitea`, `github`).
- **Unified Webhook Verification**:
  Универсальная обработка входящих вебхуков (`lib/webhook.js`) с поддержкой HMAC-SHA256 для GitHub (`x-hub-signature-256`, `sha256=`) и Gitea, определение источника по заголовкам событий.
- **Multi-Forge Settings & UI Badges**:
  Секции настроек Git Forge и GitHub в `KanbanSettingsCard` со статусами готовности (`GitHub Configured`), поддержка учетных данных через `credential-ref` DSH.


### SQLite Storage & Backup Security Policy (#298)
- **Filesystem Permissions**:
  Каталог хранилища (`storeDir`) и подкаталог резервных копий (`backups`) создаются и поддерживаются с правами `0700` (`rwx------`). Все файлы базы данных (`kanban.db`, `kanban.db-wal`, `kanban.db-shm`) и файлы бэкапов создаются и поддерживаются с правами `0600` (`rw-------`).
- **Automatic Legacy Repair**:
  При инициализации хранилища (`openStore`) до начала обслуживания запросов и маршрутов утилита `secureStorePermissions(dir)` автоматически проверяет и исправляет права существующих файлов и каталогов, исключая утечку данных задач, сессий и промптов другим локальным пользователям ОС.
- **Backup Isolation**:
  При создании резервных копий в `backupDatabase()` каталог `backups` защищается правами `0700`, а созданный файл бэкапа — правами `0600`.

### Workflow Engine Bridge (#300)
- **Direct Core WorkflowEngine Integration**:
  Плагин взаимодействует со встроенным сервисом ядра `ctx.workflowEngine` без промежуточных оркестраторов. Запуск сценария из карточки задачи формирует мультиагентный скрипт (`buildWorkflowScript`) с фазами `spec`, `backend`, `qa_tests`, `docs` в зависимости от колонки карточки и её меток.
- **Graceful Preset Degradation**:
  Роль сценария проверяется через `ctx.agentPresets.list()`. При отсутствии установленного пакета ролевых пресетов мост плавно деградирует на пресет по умолчанию.
- **Card Lifecycle & Workflow Events Synchronization**:
  События ядра `workflow/agent-start`, `workflow/agent-end` и `workflow/end` синхронизируются с состоянием карточки в SQLite (`workflowRunId`, `workflowStatus`: `running`, `completed`, `failed`, `cancelled`). При завершении воркфлоу карточка автоматически перемещается в следующую колонку (`review` / `done`), а итоговое резюме публикуется в комментарии связанного issue в Gitea/GitHub.
- **Run Cancellation & UI Controls**:
  Поддержана отмена выполняющегося воркфлоу (`POST /task/:id/workflow-cancel`) и статус-эндпоинт (`GET /task/:id/workflow-status`). В интерфейсе карточки (`lib/client.js`) выведены кнопки запуска `⚡ Workflow` и отмены `Cancel Workflow`, а также статус `⚡ Workflow` на доске.



### Automated Verification Gate on Review (#372)
- **Automatic Quality Gate on Transition to Review**:
  При перемещении задачи в колонку `review` (через UI карточки или инструмент агента `board_move`) плагин автоматически запускает настроенную команду верификации (`verificationCommand`, по умолчанию `npm test`) в рабочей директории воркдерева (`task.worktree`).
- **Failure Blocking & Prompt Feedback**:
  В случае ненулевого кода возврата переход блокируется (HTTP 422 в API, отказ в `board_move`), в карточке и логе задачи фиксируется статус `failed`, а активной сессии агента через `agent.followup` отправляется структурированное сообщение (`source.kind: 'dsh-kanban'`, `source.form: 'verification-failure'`) со сниппетом ошибки для исправления.
- **Card Badges & Diagnostics**:
  На карточке канбан-доски и в модальном окне отображается индикатор `PASS` / `FAIL`, а при сбое — блок диагностики с командой и логом вывода.

### Worktree Diff Inspector & Safe File Discard (#371)
- **Structured Diff API**:
  Эндпоинт `GET /task/:id/diff` возвращает структурированный список измененных файлов с детальным статусом (`modified`, `added`, `deleted`, `untracked`) и статистикой строк (`+insertions / -deletions` через `git diff --numstat`), а также унифицированный diff (с ограничением объема 500 КБ).
- **Safe Granular Discard**:
  Эндпоинт `POST /task/:id/discard` позволяет безопасно откатывать изменения отдельных файлов: для отслеживаемых файлов выполняется восстановление через `git restore` / `git checkout`, для неотслеживаемых — удаление с диска с жесткой проверкой от выхода за пределы воркдерева (path traversal protection).
- **Interactive Diff UI**:
  В модальном окне задачи отображается список измененных файлов с бейджами статусов, счетчиками строк и кнопкой «Discard» с подтверждением действия, а также сворачиваемая панель diff.


### Interactive Live Steering (Nudge) from Kanban Card (#373)
- **Direct Agent Steering from Active Card**:
  Для задач в колонке `in-progress` с живой сессией агента (`task.state === 'running' || task.state === 'idle'`) карточка канбан-доски предоставляет интерактивную кнопку «💬 Nudge». Нажатие открывает диалоговое окно для отправки подсказки, корректировки или уточнения требований непосредственно работающему агенту.
- **Producer-Owned Message Injection & Session Followup**:
  Бэкенд-обработчик (`handleTaskNudge`, `POST /dsh-kanban/task/:id` с `action: 'nudge'`) валидирует состояние сессии и вызывает `agent.followup` с сообщением спецификации DSH v4 (`source.kind: 'dsh-kanban'`, `source.form: 'task-nudge'`). Отправленный промпт автоматически добавляется в журнал комментариев задачи с меткой `[Steering Nudge]`, сохраняя полный аудиторский след взаимодействия оператора с агентом.
- **Real-Time Execution Step Telemetry**:
  Карточка на доске в реальном времени отображает текущий шаг/активность агента (`task.liveStep`, извлекаемый из проекции сессии `live.step || live.activity || live.stateDetail`) с анимированным индикатором выполнения.

### Token & Cost Telemetry via @goodandready/dsh-cost-meter (#374)
- **Zero-Coupling Dynamic Discovery**:
  Интеграция с плагином `@goodandready/dsh-cost-meter` построена на динамическом обнаружении сервиса (`isCostMeterAvailable(ctx)`), исключая статическое объявление `inject` в `lib/index.js`. Плагин `dsh-kanban` безупречно загружается и функционирует даже при отсутствии установленного `dsh-cost-meter`.
- **Session Token Aggregation & Cost Calculation**:
  Модуль `lib/cost-telemetry.js` извлекает статистику использования токенов из проекции сессий (`extractSessionUsage`), агрегируя кэшированный ввод, исходящие токены и кэш-хиты по всем задействованным моделям. Стоимость рассчитывается (`calculateTokenCost`) на базе тарифной сетки (включая стандартную шкалу DeepSeek и кастомные тарифы) с конвертацией валют и форматированием (`$0.42`, `₽38.50`).
- **Budget Limits & UI Highlights**:
  В настройках плагина предусмотрены параметры `costMeterEnabled` и `taskCostLimit` (USD). При превышении лимита на карточке появляется предупреждающий бейдж `⚠️ Budget Exceeded`, а в модальном окне задачи отображается подробная разбивка по типам токенов (Tokens, Input, Output, Cache) и итоговой стоимости.

### Remote Mode for PC (Windows -> Server 111) (#390)
- **Unified Remote Experience**:
  Allows DSH Kanban running on a local Windows PC desktop client to operate seamlessly against server 111 projects, worktrees, and sessions identically to running directly on the Linux server.
- **Shared Board State Relay**:
  - `shouldRelay(config)` automatically intercepts `/dsh-kanban/board` on the local instance and relays requests to `config.remoteServerUrl` (default: `http://192.168.1.111:3080`).
  - Request headers carry Bearer token and `dsh_token` cookie when `config.remoteServerToken` is configured.
  - Fail-soft fallback returns standard HTTP 503 (`remote-server-unavailable`) on network disconnect without crashes.
- **Remote Git & Worktree Execution over SSH**:
  - `createRemoteGitRunner(config)` wraps Git operations via SSH using `remoteHost`, `remotePort`, `remoteUser`, `remoteKeyPath`, and POSIX-quoted `sudo -u <remoteSudoUser> -H bash -c '...'`.
  - Remote path resolution (`resolveTaskWorktreePath`) enforces POSIX forward slashes `/` under `config.remoteRoot` (e.g. `/mnt/external/Project/DEV/.worktrees`), preventing Windows backslash corruption.
  - `safeWorktreeExists` utilizes remote `git rev-parse --is-inside-work-tree` checks instead of local filesystem `fs.existsSync`.
- **UI Surfaces**:
  - **Remote Connection Test**: `RemoteConnectionSection` in Settings Card with "Test Connection" button testing both SSH connectivity and DSH Server API responsiveness via `/api/dsh-kanban/remote/test`.
  - **Board Header Badge**: Visual `🌐 Remote: 111` tag in board header when `remoteMode: true`.
  - **Remote Session Opening**: `onOpenChat` automatically redirects or opens remote chat sessions (`http://192.168.1.111:3080/#/chat?sessionId=...`) in browser when in remote mode.
- **Backward Compatibility**:
  - Default `remoteMode: false` maintains 100% existing local execution paths and performance.


### Domain Decomposition of lib/index.js and lib/routes.js (#389)
- **Granular Domain Modularity**:
  - `lib/routes.js` decomposed into domain modules under `lib/routes/`:
    - `lib/routes/security.js`: authentication, request trust validation (`isTrustedRequest`, `rejectUntrustedRequest`), IP, cookie, and loopback guards.
    - `lib/routes/board.js`: board state construction, board metrics, snapshot import/export, CSV export.
    - `lib/routes/task.js`: task CRUD, move transition dispatch, permission gate, note appending, assignment, revival checks.
    - `lib/routes/task-worktree.js`: worktree status, diff, commits, discard, merge, and cleanup handlers.
    - `lib/routes/task-actions.js`: task checklist, subtasks, DoD items, PR creation, triage, nudging, comments, reports.
    - `lib/routes.js` serves as a clean 72-line facade preserving 100% backward-compatible symbol exports.
  - `lib/index.js` decomposed into server modules under `lib/server/`:
    - `lib/server/route-handlers.js`: route handlers for exact/prefix endpoints (`/project-task`, `/presets`, `/sessions`, `/batch`, `/archive`, `/sync`, `/webhook`, `/board`, `/remote/test`, `/metrics`, `/whoami`, `/export.csv`, `/events`, `/templates`, `/snapshot`, `/gitea/*`, `/models`, `/session/*`).
    - `lib/server/task-handler.js`: dedicated handler for the `/dsh-kanban/task` prefix route tree.
    - `lib/server/timers.js`: periodic cron scheduling, Gitea/GitHub background sync, and outbound event queue.
    - `lib/server/services.js`: system sleep inhibitor (`PowerInhibitor`), dynamic system prompt section injection, session event listener, and board tool registration.
  - Every hand-written file in `lib/` strictly conforms to the size limit of <= 600 lines.

### Watchdog Timer & Circuit Breaker for Stalled Agent Tasks (#378)
- **Background Active Task Monitoring**:
  - `WatchdogService` (`lib/watchdog.js`) actively tracks tasks in the `in-progress` column.
  - Periodically checks for inactive tasks exceeding `watchdogStallTimeoutMin` (default: 15 minutes) without new turns, messages, or tool invocations.
  - Detects repeated failure loops when consecutive execution errors reach `watchdogMaxConsecutiveErrors` (default: 5).
- **Circuit Breaker Action**:
  - When tripped, immediately aborts/pauses the active agent session to halt runaway token consumption and preserve quotas.
  - Updates the task card state to `stalled: true` with a detailed diagnostic explanation (`stalledReason`, `stalledAt`).
  - Records a diagnostic audit transition in the task journal (`source: 'watchdog'`).
  - Broadcasts `task:change` (`action: 'stalled'`) to all connected clients via SSE.
- **Manual Intervention & Task Resume**:
  - Cards in the stalled state display a prominent visual warning indicator (`⚠️ Stalled` tag and amber accent border).
  - The task details panel displays an alert box with the diagnostic reason and a dedicated `↻ Resume` action.
  - Resuming a task clears the stalled flag and error count, restarts or attaches the agent session, and logs the resumption.


### Task Dependency Graph (DAG) with Auto-Unblocking (#375)
- **Dependency Model & Cycle Prevention**:
  - Tasks support a `blockedBy` list containing IDs of prerequisite tasks.
  - Reverse mapping (`blocks`) is computed dynamically in `computeBlocksMap(tasks)`.
  - Adding dependencies is strictly validated against direct self-loops ($A \to A$) and cyclic dependency paths ($A \to B \to A$) using DFS reachability checks (`validateDependencies(taskId, blockedBy, getTask)`). Cycles are rejected with an explicit validation error.
- **Strict Transition Gate**:
  - Tasks with unfinished blockers (any task in `blockedBy` whose column is not `done`) cannot transition to `in-progress`.
  - Both UI (`applyMove`), HTTP endpoints (`/task/:id/move`), and agent tools (`board_move`) enforce this gate, returning HTTP 400 (`task-blocked`).
- **Auto-Unblocking**:
  - When a task transitions to `done`, `findUnblockedDependents(store, completedTaskId)` automatically identifies tasks whose last remaining blocker has been resolved.
  - Unblocked tasks are marked with `isBlocked: false` and broadcast to connected clients via SSE (`task:unblocked` / `task:change`).
- **UI Surfaces**:
  - Cards with unresolved blockers display a prominent `🔒 Blocked` badge and receive visual shading (`.dkb-blocked`).
  - Cards that block other tasks display a `⛔ Blocks (N)` indicator.
  - The Task modal features a dedicated Dependencies section with blocker tags, removal buttons, and a selector to add prerequisite tasks.
  - An alert banner warns users when attempting to start a blocked task.

### Time Machine Snapshots & Instant Rollback Integration (#377)
- **Zero-Coupling Dynamic Cordis Discovery**:
  - Integrates dynamically with `@goodandready/dsh-time-machine` via Cordis service detection (`getTimeMachineEngine(ctx)`).
  - Works without hard runtime dependencies: gracefully degrades with clear UI notices if the plugin is not installed in the DSH profile.
- **Lifecycle Inception Checkpoints**:
  - When a task transitions into `in-progress`, an inception snapshot is automatically captured (`createTaskInceptionSnapshot`) if `timeMachineAutoSnapshot` is enabled (default).
  - The snapshot ID is persisted in the task record (`task.inceptionSnapshotId`).
- **Manual Checkpoints & Rollback**:
  - Developers can trigger manual checkpoints anytime via `/task/:id/snapshot`.
  - Instant rollback (`/task/:id/rollback-snapshot`) restores the task's worktree to the inception state or any specified checkpoint, safely discarding drifted uncommitted changes.
- **Audit Logging**:
  - All snapshot creations and rollbacks are recorded in the task's transition journal (`source: 'time-machine'`).
- **UI Surfaces**:
  - Settings Card includes `timeMachineEnabled` and `timeMachineAutoSnapshot` configuration toggles, with an informative callout about `@goodandready/dsh-time-machine`.
  - Task Modal features a "Time Machine Snapshots" section displaying the inception snapshot ID, a "Create Checkpoint" action, and a "Rollback to Inception" action with confirmation dialog.

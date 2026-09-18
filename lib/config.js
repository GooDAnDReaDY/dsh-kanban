// Чистая часть настроек: значения по умолчанию, порядок колонок и доступ к
// полям. Ни одной зависимости — поэтому проверяется без харнесса, без сети и
// без установленных пакетов ядра. Обвязка cordis живёт в `lib/index.js`.
//
// Клиентский API настроек пишет ТОЛЬКО скалярные поля, поэтому здесь нет ни
// массивов, ни словарей: метки колонок и пределы разложены по отдельным
// скалярным полям. Доски живут в хранилище задач, а не в настройках.

/**
 * Порядок колонок повторяет реальный воркфлоу, а не абстрактное
 * «в работе → готово». Колонка `cleanup` существует потому, что задача не
 * завершена, пока ветка, worktree и локальная ветка не удалены и это не
 * записано в итоговом комментарии issue. Доска, отправляющая карточку в
 * `done` по merge, врёт ровно там, где копятся забытые ветки.
 */
export const COLUMN_ORDER = ['backlog', 'in-progress', 'review', 'deploy', 'cleanup', 'done']

/**
 * Наборы колонок по виду доски.
 *
 * `review`, `deploy` и `cleanup` осмысленны только там, где за задачей стоит
 * issue: у свободной заметки нет ни ветки, ни PR, и Gitea о ней ничего не
 * скажет. Три колонки, которые никогда не заполнятся, не «на будущее», а
 * помеха.
 *
 * Вид — свойство доски, заданное явно. Выводить его из содержимого нельзя:
 * доска, меняющая число колонок от того, что на неё положили, ведёт себя
 * непредсказуемо.
 */
export const BOARD_KINDS = ['project', 'simple']

/** Вид доски по умолчанию: неизвестный вид откатывается сюда, а не в пустоту. */
const DEFAULT_KIND = 'project'

const COLUMNS_BY_KIND = {
  project: COLUMN_ORDER,
  simple: ['backlog', 'in-progress', 'review', 'done'],
}

/** Колонки доски. Неизвестный вид — проектная доска, а не пустой набор. */
export function columnsOf(kind) {
  return COLUMNS_BY_KIND[kind] ?? COLUMNS_BY_KIND[DEFAULT_KIND]
}

/** Приведение вида к известному значению. */
export function normalizeKind(kind) {
  return BOARD_KINDS.includes(kind) ? kind : DEFAULT_KIND
}

/** Заводимые при первом запуске доски. Их ровно две, и обе нужны сразу. */
export const DEFAULT_BOARDS = [
  { id: 'main', title: 'Project Board', kind: 'project' },
  { id: 'simple', title: 'Simple Board', kind: 'simple' },
]

/** Значения по умолчанию. Из них же собирается схема в `lib/index.js`. */
export const CONFIG_DEFAULTS = {
  giteaUrl: '',
  giteaTokenRef: 'GITEA_TOKEN',
  defaultProjectRoot: '',
  startPrompt: '',
  replyInstruction: '',
  wipInProgress: 3,
  wipReview: 0,
  syncIntervalSec: 120,
  staleAfterMin: 60,
  giteaOwner: '',
  columnNames: '',
  watchRepos: '',
  archiveAfterDays: 7,
  boardToolEnabled: false,
  webhookSecretRef: '',
  pushToGitea: true,
  worktreeIsolation: true,
  worktreeRoot: '',
  cronEnabled: false,
  preventIdleSleep: false,
  progressDumpEnabled: false,
  permissionGateEnabled: false,
  sessionDefaultPermission: 'read-only',
  announceToAgent: true,
  maxConcurrentSessions: 3,
  workspaceClaimBoundaries: true,
  autoSyncSessions: false,
}

/** Пояснения к полям; повторно используются схемой и карточкой настроек. */
export const CONFIG_HINTS = {
  giteaUrl: 'Gitea or Forgejo instance URL, e.g. https://gitea.example.com. Empty disables import.',
  giteaTokenRef: 'Name of DSH credential holding the access token. Do not enter raw token.',
  defaultProjectRoot: 'Directory containing project repositories. Empty uses harness working directory.',
  startPrompt: 'Template for initial message to agent session. Empty uses built-in default.',
  replyInstruction: 'Instruction appended to initial message (e.g. language/format constraints). Empty adds nothing.',
  wipInProgress: 'Maximum task cards allowed in "In Progress" column. 0 means unlimited.',
  wipReview: 'Maximum task cards allowed in "Review" column. 0 means unlimited.',
  syncIntervalSec: 'Interval in seconds for polling Gitea synchronization. 0 disables polling.',
  staleAfterMin: 'Minutes of inactivity before active task session is flagged stale. 0 disables.',
  giteaOwner: 'Default Gitea organization/user to track. Auto-detected if single organization.',
  columnNames: 'Custom column title mappings as "id=Name" pairs comma-separated.',
  watchRepos: 'Filter sync to specific repository names comma-separated. Empty watches all repos.',
  archiveAfterDays: 'Days completed tasks remain before automatic archiving. 0 disables.',
  boardToolEnabled: 'Allow autonomous agent to advance cards via board_move tool.',
  webhookSecretRef: 'Name of DSH credential holding Gitea webhook secret.',
  pushToGitea: 'Automatically close corresponding Gitea issue when card moves to Done.',
  worktreeIsolation: 'Isolate task sessions in dedicated git worktrees to prevent workspace collisions.',
  worktreeRoot: 'Custom root directory for task worktrees. Empty defaults to $DSH_HOME/worktrees.',
  cronEnabled: 'Enable background scheduled task execution via cron expressions.',
  preventIdleSleep: 'Prevent host sleep while task agent sessions are running.',
  progressDumpEnabled: 'Enable PROGRESSDUMP state checkpoints between agent sessions.',
  permissionGateEnabled: 'Require human confirmation before launching elevated permission tasks.',
  sessionDefaultPermission: 'Default permission tier for task sessions (read-only, workspace-write, full).',
  announceToAgent: 'Post stage change announcement messages directly into task agent session.',
  maxConcurrentSessions: 'Maximum number of simultaneous active agent sessions on the board.',
  workspaceClaimBoundaries: 'Enforce workspace ownership boundaries to prevent cross-workspace task execution.',
  autoSyncSessions: 'Automatically sync and attach live background agent sessions to cards.',
}

/** Поле настроек с пределом числа карточек; задан не у всех колонок. */
const WIP_FIELD = {
  'in-progress': 'wipInProgress',
  'review': 'wipReview',
}

/**
 * Фактический корень проектов: настройка либо рабочая папка харнесса.
 *
 * Единственное место, где считается «что будет, если корень не задан».
 * Браузер показывает это значение в окне запуска, чтобы сессия не
 * поднималась молча в неожиданном каталоге.
 *
 * @param {object} config эффективные настройки
 * @param {() => string} [cwdOf] рабочая папка (в тестах подменяется)
 * @returns {{path: string, set: boolean}} путь и признак «задан настройкой»
 */
export function rootOf(config, cwdOf = () => process.cwd()) {
  const named = String(config?.defaultProjectRoot ?? '').trim()
  return named !== '' ? { path: named, set: true } : { path: cwdOf(), set: false }
}

/**
 * Наложить значения по умолчанию на сырые настройки. Поля неверного типа
 * отбрасываются в пользу умолчания: настройки приходят из файла и из
 * браузера, и одно испорченное поле не должно ронять плагин целиком.
 * @param {object} [raw] сырые значения
 * @returns {object} полный набор скалярных полей
 */
export function withDefaults(raw) {
  const out = {}
  for (const [key, fallback] of Object.entries(CONFIG_DEFAULTS)) {
    const value = raw?.[key]
    out[key] = typeof value === typeof fallback && value !== null ? value : fallback
  }
  return out
}

/**
 * Предел числа карточек в колонке. Ноль и отсутствие поля означают «без
 * предела» и одинаково дают `undefined`, чтобы вызывающему не приходилось
 * различать два способа сказать одно и то же.
 * @param {object} config эффективные настройки
 * @param {string} column идентификатор колонки
 * @returns {number|undefined} предел либо undefined
 */
export function wipLimitField(config, column) {
  const field = WIP_FIELD[column]
  if (field === undefined) return undefined
  const value = config?.[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

/**
 * Свои названия колонок из настройки.
 *
 * Пары `идентификатор=Название` через запятую. Одно поле на все колонки, а не
 * шесть отдельных: переименовывают их раз в жизни, а карточку настроек шесть
 * полей засорили бы навсегда.
 *
 * Название неизвестной колонки не отбрасываем молча — она может появиться
 * позже, и тогда настройка сработает сама.
 */
export function columnNamesOf(config) {
  const out = {}
  for (const pair of String(config?.columnNames ?? '').split(',')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const id = pair.slice(0, at).trim()
    const name = pair.slice(at + 1).trim()
    if (id !== '' && name !== '') out[id] = name
  }
  return out
}

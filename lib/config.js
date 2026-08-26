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

/** Значения по умолчанию. Из них же собирается схема в `lib/index.js`. */
export const CONFIG_DEFAULTS = {
  giteaUrl: '',
  giteaTokenRef: 'GITEA_TOKEN',
  defaultProjectRoot: '',
  startPrompt: '',
  replyInstruction: 'Отвечай по-русски.',
  labelInProgress: 'kanban/in-progress',
  labelReview: 'kanban/review',
  labelDeploy: 'kanban/deploy',
  labelCleanup: 'kanban/cleanup',
  wipInProgress: 3,
  wipReview: 0,
  syncIntervalSec: 120,
  boardToolEnabled: false,
  webhookSecretRef: '',
  pushToGitea: true,
}

/** Пояснения к полям; повторно используются схемой и карточкой настроек. */
export const CONFIG_HINTS = {
  giteaUrl: 'Адрес инстанса Gitea или Forgejo, например https://gitea.example.com. Пусто — импорт недоступен.',
  giteaTokenRef: 'ИМЯ учётной записи DSH, в которой лежит токен. Сам токен сюда не вводить.',
  defaultProjectRoot: 'Корень, в котором лежат рабочие копии проектов. Пусто — рабочая папка харнесса.',
  startPrompt: 'Шаблон первого сообщения агенту. Пусто — встроенный шаблон.',
  replyInstruction: 'Постоянная приписка к первому сообщению — например язык ответа. Пусто — ничего не добавляется.',
  labelInProgress: 'Метка Gitea для колонки «В работе». Пусто — метка не ставится.',
  labelReview: 'Метка Gitea для колонки «Ревью». Пусто — метка не ставится.',
  labelDeploy: 'Метка Gitea для колонки «Deploy». Пусто — метка не ставится.',
  labelCleanup: 'Метка Gitea для колонки «Cleanup». Пусто — метка не ставится.',
  wipInProgress: 'Предел числа карточек в колонке «В работе». Ноль — без предела.',
  wipReview: 'Предел числа карточек в колонке «Ревью». Ноль — без предела.',
  syncIntervalSec: 'Как часто сверяться с Gitea, в секундах. Ноль — не сверяться.',
  boardToolEnabled: 'Разрешить агенту двигать карточки инструментом board_move. Выключено, пока скилл воркфлоу запрещает CLI трогать канбан.',
  webhookSecretRef: 'ИМЯ учётной записи DSH с секретом вебхука Gitea. Пусто — вебхук не принимается, остаётся только опрос.',
  pushToGitea: 'Переносить метки колонок обратно в Gitea и закрывать issue в колонке Done.',
}

/** Поле настроек с меткой Gitea для колонки; у `backlog` и `done` метки нет. */
const LABEL_FIELD = {
  'in-progress': 'labelInProgress',
  'review': 'labelReview',
  'deploy': 'labelDeploy',
  'cleanup': 'labelCleanup',
}

/** Поле настроек с пределом числа карточек; задан не у всех колонок. */
const WIP_FIELD = {
  'in-progress': 'wipInProgress',
  'review': 'wipReview',
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
 * Метка Gitea для колонки. Пустая строка означает «метку не ставить» — это
 * штатное состояние для `backlog` и `done`, а не пропущенная настройка.
 * @param {object} config эффективные настройки
 * @param {string} column идентификатор колонки
 * @returns {string} имя метки либо пустая строка
 */
export function columnLabelField(config, column) {
  const field = LABEL_FIELD[column]
  if (field === undefined) return ''
  const value = config?.[field]
  return typeof value === 'string' ? value : ''
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

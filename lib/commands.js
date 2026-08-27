// Перенос карточки — это КОМАНДА агенту, а не запись о состоянии.
//
// Владелец не двигает карточки вручную ради учёта: если он двинул, значит
// просит запустить тот этап, куда двинул. Поэтому таблица ниже описывает не
// «что стало», а «что сделать», и текст уходит в чат задачи.
//
// Тексты последствий для окна подтверждения живут в клиентской половине:
// они переводятся, а инструкция агенту — нет.

/** Виды досок. Простая доска появляется в #63; таблица под неё уже здесь. */
export const BOARD_KINDS = ['project', 'simple']

/**
 * Колонка `done` для инструмента агента закрыта.
 *
 * Путь агента к завершению — получить согласие, закрыть issue и удалить ветку;
 * сверка с Gitea сама увидит закрытый issue без ветки и передвинет карточку.
 * Карточка двигается фактом, а не заявлением, и подделать это нечем.
 */
export const TOOL_FORBIDDEN_COLUMNS = ['done']

const TABLE = {
  project: {
    'backlog': { stops: true },
    'in-progress': {
      instruction: 'Начни или продолжи реализацию этой задачи по стандартному воркфлоу.',
    },
    'review': {
      instruction: 'Доведи работу до ревью: сними с pull request пометку черновика '
        + 'и запроси проверку.',
    },
    'deploy': {
      // Воркфлоу требует явного «ок» человека перед deploy. Сказать это надо
      // прямо, иначе агент будет спрашивать разрешение, которое уже получил.
      instruction: 'Влей pull request и выкати. Перенос карточки в Deploy — это и есть '
        + 'явное «ок» человека на deploy, отдельно спрашивать не нужно.',
    },
    'cleanup': {
      instruction: 'Прибери за задачей: удали ветку в Gitea, worktree и локальную ветку, '
        + 'запиши сделанное в issue.',
    },
    'done': { humanOnly: true },
  },
  simple: {
    'backlog': { stops: true },
    'in-progress': { instruction: 'Начни или продолжи работу по этой задаче.' },
    'review': { instruction: 'Покажи результат и жди ответа человека.' },
    'done': { humanOnly: true },
  },
}

/**
 * Что означает перенос в колонку.
 *
 * @returns {{stops: boolean, humanOnly: boolean, instruction: string}|undefined}
 *   `undefined` — такой колонки на этой доске нет.
 */
export function commandFor(column, kind = 'project') {
  const board = TABLE[kind]
  if (board === undefined) return undefined
  const found = board[column]
  if (found === undefined) return undefined
  return {
    stops: found.stops === true,
    humanOnly: found.humanOnly === true,
    instruction: found.instruction ?? '',
  }
}

/** Колонки доски в том виде, в каком их понимает таблица команд. */
export function columnsOfKind(kind = 'project') {
  return Object.keys(TABLE[kind] ?? {})
}

/**
 * Исполнить команду, стоящую за переносом карточки.
 *
 * Ничего не двигает: карточку уже передвинул `applyMove`. Здесь только
 * последствие переноса — остановка идущего хода либо сообщение в чат задачи.
 *
 * Отсутствие сессии не ошибка: карточку без чата двигают как обычную пометку.
 *
 * @returns {{acted: 'stopped'|'sent'|'idle'|'no-session'|'human'|'unknown'}}
 */
export function dispatchMove({ agents, task, column, kind = 'project', createMessage, logger }) {
  const command = commandFor(column, kind)
  if (command === undefined) return { acted: 'unknown' }
  if (command.humanOnly) return { acted: 'human' }

  const sessionId = typeof task?.sessionId === 'string' ? task.sessionId : ''
  if (sessionId === '') return { acted: 'no-session' }

  let agent
  try { agent = agents.get(sessionId) } catch { agent = undefined }
  if (agent === undefined) return { acted: 'no-session' }

  if (command.stops) {
    // Карточка в бэклоге при работающем агенте — это ложь: работа идёт, а
    // доска говорит, что нет. Останавливаем по-настоящему.
    if (agent.status !== 'running') return { acted: 'idle' }
    try {
      agent.cancel({ kind: 'user' })
    } catch (error) {
      logger?.warn?.(`dsh-kanban: ход по задаче ${task.id} не прервался: ${error?.message}`)
      return { acted: 'idle' }
    }
    return { acted: 'stopped' }
  }

  agent.followup(createMessage({
    // Содержимое — МАССИВ блоков, а не строка: ядро перебирает его как список.
    content: [{ type: 'text', text: command.instruction }],
    source: { kind: 'plugin', plugin: 'dsh-kanban', form: 'board-command' },
  }))
  return { acted: 'sent' }
}

/**
 * Пояснение к переходу в журнале задачи.
 *
 * Одна строка на один перенос: писать вторым рядом «а ещё мы остановили ход»
 * значило бы задваивать событие, которое было одним.
 */
export const MOVE_DETAIL = {
  stopped: 'перенос прервал идущий ход агента',
  sent: 'команда отправлена в чат задачи',
  idle: 'агент не работал, останавливать было нечего',
  'no-session': 'у задачи нет сессии, карточка просто передвинута',
  human: 'решение человека',
  unknown: '',
}

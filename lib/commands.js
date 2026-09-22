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
      instruction: 'Start or continue implementing this task following standard workflow.',
    },
    'review': {
      instruction: 'Prepare work for review: mark pull request ready for review and request code review.',
    },
    'deploy': {
      instruction: 'Merge pull request and deploy. Moving card to Deploy serves as explicit OK for deploy; do not ask separately.',
    },
    'cleanup': {
      instruction: 'Clean up after task: delete branch in Gitea, worktree, and local branch; record summary in issue.',
    },
    'done': { humanOnly: true },
  },
  simple: {
    'backlog': { stops: true },
    'in-progress': { instruction: 'Start or continue work on this task.' },
    'review': { instruction: 'Present result and wait for human response.' },
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
  if (!columnsOfKind(kind).includes(column)) return undefined
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
      logger?.warn?.(`dsh-kanban: agent turn for task ${task.id} was not interrupted: ${error?.message}`)
      return { acted: 'idle' }
    }
    return { acted: 'stopped' }
  }

  agent.followup(createMessage({
    // Содержимое — МАССИВ блоков, а не строка: ядро перебирает его как список.
    content: [{ type: 'text', text: command.instruction }],
    source: { kind: 'dsh-kanban', plugin: 'dsh-kanban', form: 'board-command' },
  }))
  return { acted: 'sent' }
}

/**
 * Остановить ход агента, не двигая карточку.
 *
 * Прежде остановка была возможна только переносом в бэклог, то есть вместе с
 * отменой этапа. Здесь останавливается только ход: колонка — отдельное
 * решение человека, и доска не вправе принимать его за него.
 *
 * @returns {{acted: 'stopped'|'idle'|'no-session'}}
 */
export function stopWork({ agents, task, logger }) {
  const sessionId = typeof task?.sessionId === 'string' ? task.sessionId : ''
  if (sessionId === '') return { acted: 'no-session' }

  let agent
  try { agent = agents.get(sessionId) } catch { agent = undefined }
  if (agent === undefined) return { acted: 'no-session' }
  // Остановить не идущего нечем, и говорить об этом надо прямо: молчаливое
  // «готово» на месте «он и так стоял» — ложь о том, что случилось.
  if (agent.status !== 'running') return { acted: 'idle' }

  try {
    agent.cancel({ kind: 'user' })
  } catch (error) {
    logger?.warn?.(`dsh-kanban: agent turn for task ${task.id} was not interrupted: ${error?.message}`)
    return { acted: 'idle' }
  }
  return { acted: 'stopped' }
}

/** Пояснения к остановке в журнале задачи. */
export const STOP_DETAIL = {
  stopped: 'user stopped agent turn',
  idle: 'agent was idle, nothing to stop',
  'no-session': 'task has no session',
}

/**
 * Пояснение к переходу в журнале задачи.
 *
 * Одна строка на один перенос: писать вторым рядом «а ещё мы остановили ход»
 * значило бы задваивать событие, которое было одним.
 */
export const MOVE_DETAIL = {
  stopped: 'move interrupted running agent turn',
  sent: 'command sent to task chat',
  idle: 'agent was idle, nothing to stop',
  'no-session': 'task has no session, card moved',
  human: 'human decision',
  unknown: '',
}

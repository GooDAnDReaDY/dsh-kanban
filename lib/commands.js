// Moving a card is a COMMAND to the agent, not merely a state update.
// If user moved a card, it instructs the agent to run that lifecycle phase.
// Confirmation dialog texts reside in client bundles where they are localized.

/** Board kinds. Simple board introduced in #63; table supports it here. */
export const BOARD_KINDS = ['project', 'simple']

/**
 * `done` column is inaccessible to agent tool.
 * Agent finishes task by obtaining acceptance, closing issue and deleting branch.
 * Sync detects closed issue without branch and advances the card.
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
 * Semantics of moving card to column.
 *
 * @returns {{stops: boolean, humanOnly: boolean, instruction: string}|undefined}
 *   `undefined` - column absent on this board.
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

/** Board columns as understood by commands table. */
export function columnsOfKind(kind = 'project') {
  return Object.keys(TABLE[kind] ?? {})
}

/**
 * Execute command triggered by moving a card.
 * Does not move card: move already applied. Handles side effects:
 * interrupting active turn or posting instruction to task chat.
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
    // Card in backlog with running agent is inconsistent: interrupt active turn.
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
    // Content is array of blocks: core processes as list.
    content: [{ type: 'text', text: command.instruction }],
    source: { kind: 'dsh-kanban', plugin: 'dsh-kanban', form: 'board-command' },
  }))
  return { acted: 'sent' }
}

/**
 * Stop agent turn without moving card.
 * Interrupts execution while preserving column position.
 *
 * @returns {{acted: 'stopped'|'idle'|'no-session'}}
 */
export function stopWork({ agents, task, logger }) {
  const sessionId = typeof task?.sessionId === 'string' ? task.sessionId : ''
  if (sessionId === '') return { acted: 'no-session' }

  let agent
  try { agent = agents.get(sessionId) } catch { agent = undefined }
  if (agent === undefined) return { acted: 'no-session' }
  // Agent was already idle, report explicitly.
  if (agent.status !== 'running') return { acted: 'idle' }

  try {
    agent.cancel({ kind: 'user' })
  } catch (error) {
    logger?.warn?.(`dsh-kanban: agent turn for task ${task.id} was not interrupted: ${error?.message}`)
    return { acted: 'idle' }
  }
  return { acted: 'stopped' }
}

/** Stop details recorded in task transitions. */
export const STOP_DETAIL = {
  stopped: 'user stopped agent turn',
  idle: 'agent was idle, nothing to stop',
  'no-session': 'task has no session',
}

/**
 * Transition detail recorded in task history.
 * Single event entry per transition.
 */
export const MOVE_DETAIL = {
  stopped: 'move interrupted running agent turn',
  sent: 'command sent to task chat',
  idle: 'agent was idle, nothing to stop',
  'no-session': 'task has no session, card moved',
  human: 'human decision',
  unknown: '',
}

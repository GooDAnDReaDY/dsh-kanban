// Определение инструмента board_move — отдельно от обвязки cordis, чтобы
// проверяться без харнесса и без `@deepseek-ai/dsh-tools`.
//
// Форма объекта задана контрактом `defineTool` из dsh-tools, и она НЕ является
// JSON Schema:
//
//   parameters — карта «имя -> схема значения», без корня `type: 'object'`;
//                необязательность выражается ОТСУТСТВИЕМ `required: true`
//                (`required: false`, `optional` и `nullable` отвергаются);
//   output     — обязателен: `defineTool` читает `options.output.render`
//                безусловно, и без него падает не инструмент, а загрузка
//                всего профиля.
//
// Схема объекта требует явного `additionalProperties`; здесь результат —
// строка, поэтому схема строковая.

import { COLUMN_ORDER as COLUMNS } from './config.js'
import { resolveTransition } from './transitions.js'
import { TOOL_FORBIDDEN_COLUMNS } from './commands.js'
import { parsePlan, applyPlan, serializePlan, planProgress, MAX_ITEMS } from './plan.js'

/**
 * Колонки, доступные инструменту.
 *
 * `done` вырезан из ПЕРЕЧИСЛЕНИЯ, а не только из проверки: подсказывать модели
 * значение, которое она получит отказом, — приглашение его попробовать.
 */
const TOOL_COLUMNS = COLUMNS.filter((c) => !TOOL_FORBIDDEN_COLUMNS.includes(c))

/**
 * Идентификатор сессии из контекста выполнения инструмента.
 *
 * dsh-tools переехал с `ctx.session` на `ctx.agent.session`. Читаем оба:
 * промах здесь не роняет ничего, он молча превращает инструмент в отказ
 * «за этой сессией нет карточки» — а такое ищут долго.
 */
export function sessionIdFromExec(exec) {
  return String(exec?.agent?.session?.id ?? exec?.session?.id ?? '')
}

/**
 * Задача сессии, с которой работает инструмент.
 *
 * Одна сессия может вести пачку. Пока задача одна — называть нечего. Как
 * только их несколько, инструмент ОБЯЗАН сказать, какую двигает: догадка тут
 * означает подвинутую не ту карточку, и заметят это нескоро.
 *
 * Ссылку принимаем в том виде, в каком агент её видит: `repo#номер` либо
 * идентификатор карточки.
 *
 * @returns {{task: object}|{error: string}}
 */
export function pickTask(store, exec, ref) {
  const tasks = store.listTasksBySession(sessionIdFromExec(exec))
  if (tasks.length === 0) return { error: 'This session has no kanban task behind it.' }

  const wanted = String(ref ?? '').trim()
  if (wanted === '') {
    if (tasks.length === 1) return { task: tasks[0] }
    return {
      error: 'This session carries several tasks. Name the one you mean in `task`: '
        + tasks.map(nameOf).join(', ') + '.',
    }
  }

  const found = tasks.find((t) => t.id === wanted || nameOf(t) === wanted)
  if (found === undefined) {
    return {
      error: `No task \`${wanted}\` in this session. Available: ` + tasks.map(nameOf).join(', ') + '.',
    }
  }
  return { task: found }
}

/** Как задача называется для агента: так же, как он видит её в сообщении. */
function nameOf(task) {
  return task.repo && typeof task.issueNumber === 'number'
    ? `${task.repo}#${task.issueNumber}`
    : task.id
}

/** Определение board_move, готовое к передаче в `defineTool`. */
export function boardMoveDefinition({ store, config }) {
  return {
    name: 'board_move',
    description: 'Move the kanban card of the current task to another column. '
      + `Columns: ${TOOL_COLUMNS.join(', ')}. Use it when the work reaches a new stage. `
      + 'Finishing a task is not a move: close the issue and delete the branch, and the '
      + 'card reaches done by itself once the board sees that.',
    parameters: {
      column: {
        type: 'string',
        enum: [...TOOL_COLUMNS],
        description: 'Target column.',
        required: true,
      },
      detail: { type: 'string', description: 'Short reason, shown in the task log.' },
      task: {
        type: 'string',
        description: 'Which task to move, as `repo#number`. Required when this session '
          + 'carries several tasks; omit it when there is only one.',
      },
    },
    output: {
      schema: { type: 'string', description: 'Outcome of the move, in one sentence.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute({ column, detail, task: ref }, exec) {
      const picked = pickTask(store, exec, ref)
      if (picked.error !== undefined) return picked.error
      const task = picked.task

      // Проверка границ владения воркспейсом (#216)
      const claimBoundaries = typeof config === 'function' ? config()?.workspaceClaimBoundaries : config?.workspaceClaimBoundaries
      if (claimBoundaries !== false && typeof task.workspaceId === 'string' && task.workspaceId.trim() !== '') {
        const sessionWs = String(exec?.agent?.session?.meta?.workspaceId ?? exec?.session?.meta?.workspaceId ?? '').trim()
        if (sessionWs !== '' && sessionWs !== task.workspaceId.trim()) {
          return `Cannot move card: task belongs to workspace "${task.workspaceId}", but current session belongs to workspace "${sessionWs}". Cross-workspace moves are restricted by workspaceClaimBoundaries.`
        }
      }
      // Перечисление уже не предлагает `done`, но модель может прислать его
      // мимо схемы, а завершение задачи не должно опираться на заявление.
      if (column === 'done' || TOOL_FORBIDDEN_COLUMNS.includes(column)) {
        return 'The done column is a human-only acceptance boundary. A task is not finished by moving its card: move it to review for human acceptance; only a human can accept and move it to done.'
      }
      if (column === 'review') {
        const checklist = Array.isArray(task.checklist) ? task.checklist : []
        const pendingRequired = checklist.filter((item) => item.required !== false && !item.completed)
        if (pendingRequired.length > 0) {
          const totalReq = checklist.filter((i) => i.required !== false).length
          const doneReq = totalReq - pendingRequired.length
          return `Cannot move card to review: uncompleted required DoD checklist items (${doneReq}/${totalReq} completed). `
            + `Pending: ${pendingRequired.map((i) => i.text).join('; ')}. `
            + 'Use `board_checklist` with verification evidence to complete required items.'
        }
      }
      const move = resolveTransition(task.column, [{ column, source: 'tool', detail: detail ?? '' }])
      if (move === undefined) return `The card is already in ${task.column}.`
      store.moveTask(task.id, { column: move.column })
      store.addTransition({
        taskId: task.id, fromCol: task.column, toCol: move.column,
        source: 'tool', detail: move.detail,
      })
      return `Card moved to ${move.column}.`
    },
  }
}

/**
 * Определение board_plan, готовое к передаче в `defineTool`.
 *
 * План получаем прямо от агента, а не разбором его сообщений: разбор — это
 * гадание, а чужой `todo_list` завёл бы зависимость от соседнего плагина.
 *
 * Список пунктов необязателен. Агент публикует план один раз, а дальше двигает
 * только указатель: гонять весь список ради одного числа незачем.
 */
export function boardPlanDefinition({ store }) {
  return {
    name: 'board_plan',
    description: 'Publish or update the plan shown on the kanban card of the current task. '
      + 'Send `items` once to publish the plan, then send only `current` as you move from '
      + 'step to step. Everything before `current` counts as done. '
      + `At most ${MAX_ITEMS} steps.`,
    parameters: {
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'The whole plan, one short entry per step. Omit to keep the current plan.',
      },
      current: {
        type: 'number',
        description: 'Number of the step in work, counting from 1. '
          + 'One past the last step means the plan is finished.',
      },
    },
    output: {
      schema: { type: 'string', description: 'Outcome of the update, in one sentence.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute({ items, current }, exec) {
      // План ОДИН на сессию: это план работы над пачкой, а не над каждой
      // задачей порознь. Поэтому пишем его всем задачам сессии — иначе на
      // карточках второй и третьей плана не будет вовсе.
      const tasks = store.listTasksBySession(sessionIdFromExec(exec))
      if (tasks.length === 0) return 'This session has no kanban task behind it.'
      const task = tasks[0]
      const plan = applyPlan(parsePlan(task.plan), { items, current })
      if (plan.items.length === 0) return 'A plan needs at least one step.'
      for (const one of tasks) store.updateTask(one.id, { plan: serializePlan(plan) })
      const progress = planProgress(plan)
      return progress.text === ''
        ? `Plan of ${progress.total} steps recorded; no step is marked as current.`
        : `Step ${progress.current} of ${progress.total}: ${progress.text}.`
    },
  }
}


/** Определение board_checklist (#205) */
export function boardChecklistDefinition({ store }) {
  return {
    name: 'board_checklist',
    description: 'Mark a Definition of Done (DoD) checklist item as completed with verification evidence.',
    parameters: {
      item: {
        type: 'number',
        description: '1-based index of the checklist item (e.g. 1, 2, 3).',
        required: true,
      },
      evidence: {
        type: 'string',
        description: 'Proof of completion (test command output, verified commit hash, file path, etc.).',
        required: true,
      },
      task: {
        type: 'string',
        description: 'Task reference (`repo#number` or card id). Required if this session carries multiple tasks.',
      },
    },
    output: {
      schema: { type: 'string', description: 'Checklist update status.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute({ item, evidence, task: ref }, exec) {
      const picked = pickTask(store, exec, ref)
      if (picked.error !== undefined) return picked.error
      const task = picked.task
      const checklist = Array.isArray(task.checklist) ? [...task.checklist] : []
      if (checklist.length === 0) return 'This task has no DoD checklist configured.'
      const num = Number(item)
      const idx = num - 1
      if (!Number.isInteger(num) || idx < 0 || idx >= checklist.length) {
        return `Invalid item ${item}. Task has ${checklist.length} checklist items (1..${checklist.length}).`
      }
      const ev = String(evidence ?? '').trim()
      if (ev === '') return 'Evidence is required when completing a DoD item.'
      checklist[idx] = {
        ...checklist[idx],
        completed: true,
        evidence: ev,
        completedAt: Date.now(),
      }
      store.updateTask(task.id, { checklist })
      const doneCount = checklist.filter((i) => i.completed).length
      return `DoD item ${num} ("${checklist[idx].text}") marked as completed. Progress: ${doneCount}/${checklist.length}.`
    },
  }
}

/** Определение board_report (#206) */
export function boardReportDefinition({ store }) {
  return {
    name: 'board_report',
    description: 'Publish a structured execution report before moving the card to review.',
    parameters: {
      summary: {
        type: 'string',
        description: 'Executive summary of the completed work.',
        required: true,
      },
      changed_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of created, modified, or deleted files.',
      },
      checks_run: {
        type: 'array',
        items: { type: 'string' },
        description: 'Commands executed and verification results.',
      },
      artifacts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Artifact links, tarballs, PR URLs, or commit hashes.',
      },
      risks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Remaining risks, constraints, or caveats.',
      },
      task: {
        type: 'string',
        description: 'Task reference (`repo#number` or card id). Required if this session carries multiple tasks.',
      },
    },
    output: {
      schema: { type: 'string', description: 'Report status confirmation.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute({ summary, changed_files, checks_run, artifacts, risks, task: ref }, exec) {
      const picked = pickTask(store, exec, ref)
      if (picked.error !== undefined) return picked.error
      const task = picked.task
      const s = String(summary ?? '').trim()
      if (s === '') return 'A summary is required in board_report.'
      const report = {
        summary: s,
        changedFiles: Array.isArray(changed_files) ? changed_files : [],
        checksRun: Array.isArray(checks_run) ? checks_run : [],
        artifacts: Array.isArray(artifacts) ? artifacts : [],
        risks: Array.isArray(risks) ? risks : [],
        createdAt: Date.now(),
      }
      store.setReport(task.id, report)
      return `Execution report for task "${task.title}" saved successfully.`
    },
  }
}

/** Определение board_comments (#208) */
export function boardCommentsDefinition({ store }) {
  return {
    name: 'board_comments',
    description: 'Read the comments and discussion thread for the current task.',
    parameters: {
      task: {
        type: 'string',
        description: 'Task reference (`repo#number` or card id). Required if this session carries multiple tasks.',
      },
    },
    output: {
      schema: { type: 'string', description: 'Discussion thread text.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute({ task: ref }, exec) {
      const picked = pickTask(store, exec, ref)
      if (picked.error !== undefined) return picked.error
      const task = picked.task
      const comments = Array.isArray(task.comments) ? task.comments : []
      if (comments.length === 0) return 'No comments on this task yet.'
      return comments
        .map((c, i) => `#${i + 1} [${c.role === 'agent' ? 'Agent' : 'User'}] (${new Date(c.createdAt).toLocaleTimeString()}): ${c.text}`)
        .join('\n\n')
    },
  }
}

/** Определение board_comment_add (#208) */
export function boardCommentAddDefinition({ store }) {
  return {
    name: 'board_comment_add',
    description: 'Post a comment to the task discussion thread.',
    parameters: {
      text: {
        type: 'string',
        description: 'Comment message text.',
        required: true,
      },
      task: {
        type: 'string',
        description: 'Task reference (`repo#number` or card id). Required if this session carries multiple tasks.',
      },
    },
    output: {
      schema: { type: 'string', description: 'Status of posting comment.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute({ text, task: ref }, exec) {
      const picked = pickTask(store, exec, ref)
      if (picked.error !== undefined) return picked.error
      const task = picked.task
      const t = String(text ?? '').trim()
      if (t === '') return 'Comment text cannot be empty.'
      store.addComment(task.id, { author: 'agent', role: 'agent', text: t })
      return `Comment posted to task "${task.title}".`
    },
  }
}

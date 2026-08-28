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
export function boardMoveDefinition({ store }) {
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
      // Перечисление уже не предлагает `done`, но модель может прислать его
      // мимо схемы, а завершение задачи не должно опираться на заявление.
      if (TOOL_FORBIDDEN_COLUMNS.includes(column)) {
        return 'A task is not finished by moving its card. Close the issue and delete the '
          + 'branch; the card reaches done once the board sees that.'
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

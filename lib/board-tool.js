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
    },
    output: {
      schema: { type: 'string', description: 'Outcome of the move, in one sentence.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute({ column, detail }, exec) {
      const task = store.findTaskBySession(sessionIdFromExec(exec))
      if (task === undefined) return 'This session has no kanban task behind it.'
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

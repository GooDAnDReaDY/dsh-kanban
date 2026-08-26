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
      + `Columns: ${COLUMNS.join(', ')}. Use it when the work reaches a new stage.`,
    parameters: {
      column: {
        type: 'string',
        enum: [...COLUMNS],
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

// Признак ожидания по событиям сессии.
//
// Колонки «Блокировано» в согласованном наборе нет, поэтому запрос разрешения
// или вопрос агента НЕ двигают карточку, а поднимают на ней признак «нужен
// человек». Двигать в несуществующую колонку нельзя, а прятать «агент стоит и
// ждёт» — значит терять главное, ради чего смотрят на доску.
//
// Подписка на события ядра живёт в `lib/index.js`; здесь только решение, что
// делать с очередным событием.

import { waitingFromEvent } from './transitions.js'

/**
 * Обработать событие сессии.
 *
 * Задача ищется по идентификатору сессии. Сессий, поднятых не с доски,
 * большинство — для них здесь ничего не происходит, и это штатный ход, а не
 * пропуск.
 *
 * @returns {{taskId: string, waiting: boolean}|undefined} что изменилось
 */
export function handleSessionEvent({ store, sessionId, type }) {
  const next = waitingFromEvent(type)
  if (next === undefined) return undefined

  const task = store.findTaskBySession(sessionId)
  if (task === undefined) return undefined
  if (task.waiting === next) return undefined

  store.updateTask(task.id, { waiting: next })
  return { taskId: task.id, waiting: next }
}

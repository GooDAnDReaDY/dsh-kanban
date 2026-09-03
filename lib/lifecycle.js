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
import { parseProgressDump, formatProgressDump } from './progress-dump.js'

/**
 * Обработать событие сессии.
 *
 * Задача ищется по идентификатору сессии. Сессий, поднятых не с доски,
 * большинство — для них здесь ничего не происходит, и это штатный ход, а не
 * пропуск.
 *
 * @returns {{taskId: string, waiting?: boolean}|undefined} что изменилось
 */
export function handleSessionEvent({ store, sessionId, type, text, error }) {
  const task = store.findTaskBySession(sessionId)
  if (task === undefined) return undefined

  // Если в ответе пришёл PROGRESSDUMP — обновляем срез в задаче
  if (typeof text === 'string' && text.includes('<<<PROGRESSDUMP')) {
    const parsed = parseProgressDump(text)
    if (parsed.ok) {
      store.updateTask(task.id, { progressDump: formatProgressDump(parsed.dump) })
    }
  }

  // Обновляем исход запуска в истории runs
  if (type === 'turn/end' || type === 'turn/completed') {
    const latestRun = Array.isArray(task.runs) ? task.runs[0] : undefined
    if (latestRun && latestRun.sessionId === sessionId && !latestRun.endedAt && typeof store.updateTaskRun === 'function') {
      store.updateTaskRun(task.id, latestRun.id, {
        endedAt: Date.now(),
        result: 'succeeded',
      })
    }
  } else if (type === 'turn/error' || type === 'session/error') {
    const latestRun = Array.isArray(task.runs) ? task.runs[0] : undefined
    if (latestRun && latestRun.sessionId === sessionId && !latestRun.endedAt && typeof store.updateTaskRun === 'function') {
      store.updateTaskRun(task.id, latestRun.id, {
        endedAt: Date.now(),
        result: 'failed',
        error: typeof error === 'string' ? error : error?.message || 'error',
      })
    }
  }

  const next = waitingFromEvent(type)
  if (next === undefined) return undefined
  if (task.waiting === next) return undefined

  store.updateTask(task.id, { waiting: next })
  return { taskId: task.id, waiting: next }
}

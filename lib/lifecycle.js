// Session waiting indicators.
// Permission requests or agent prompts raise a 'waiting for user' flag on card
// without moving it to a non-existent blocked column.

import { waitingFromEvent } from './transitions.js'
import { parseProgressDump, formatProgressDump } from './progress-dump.js'

/**
 * Process session event.
 *
 * Looks up task by sessionId. Non-kanban sessions are cleanly
 * ignored without side effects.

 *
 * @returns {{taskId: string, waiting?: boolean}|undefined} mutation report
 */
export function handleSessionEvent({ store, sessionId, session, type, text, error }) {
  // Filter out subagent child session events (#215)
  if (session && (session.origin === 'subagent' || session.parentId !== undefined || session.meta?.origin === 'subagent' || session.isSubagent)) {
    return undefined
  }
  const task = store.findTaskBySession(sessionId)
  if (task === undefined) return undefined

  // If turn returned PROGRESSDUMP, update task snapshot
  if (typeof text === 'string' && text.includes('<<<PROGRESSDUMP')) {
    const parsed = parseProgressDump(text)
    if (parsed.ok) {
      store.updateTask(task.id, { progressDump: formatProgressDump(parsed.dump) })
    }
  }

  // Update run outcome in run history
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

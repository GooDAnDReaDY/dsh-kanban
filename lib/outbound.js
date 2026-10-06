// Kanban -> Gitea: closing issue.
//
// Sending runs via queue rather than synchronously in move handler.
// Gitea may be unreachable, but the board must still move cards.
// A network-blocking move would make the board hostage to external latency.
//
// Failed dispatch is not dropped silently: it retries, and after
// several attempts is logged as a problem in task history.
// Silently swallowed divergence is the worst sync failure mode.
//
// The board does NOT set column labels. It never reads them:
// column is derived from issue/branch/PR state, while labels only duplicate it.
// In exchange, the board leaves external labels untouched.

/**
 * What to send to Gitea on assignee change.
 *
 * Does not apply to local tasks (without issue): no remote assignee exists.
 */
export function planAssign(task, login) {
  if (typeof task?.issueNumber !== 'number') return []
  return [{
    kind: 'assign',
    owner: task.owner,
    repo: task.repo,
    index: task.issueNumber,
    login: typeof login === 'string' ? login : '',
  }]
}

export function planOutbound(task, column, config) {
  if (typeof task?.issueNumber !== 'number') return []
  // Closing issue is the only mutation sent to Gitea: it is a concrete action,
  // not redundant mirroring.
  return column === 'done'
    ? [{ kind: 'close', owner: task.owner, repo: task.repo, index: task.issueNumber }]
    : []
}

/**
 * Dispatch queue with retries.
 *
 * @param {object} options
 * @param {object} options.gitea client
 * @param {object} options.store store where failures are reported
 * @param {number} [options.maxAttempts] max failed attempts before giving up
 */
export function createOutbox({ gitea, store, logger, maxAttempts = 4 }) {
  const queue = []

  return {
    size: () => queue.length,

    push(taskId, ops) {
      for (const op of ops) queue.push({ taskId, op, attempts: 0 })
    },

    /**
     * Try delivering all queued operations.
     *
     * Success clears operation, failure reenqueues until attempt limit.
     * Once attempts are exhausted, operation is NOT dropped silently:
     * recorded in task history so divergence is visible to user.
     */
    async flush() {
      const pending = queue.splice(0)
      let sent = 0
      let retried = 0
      let dropped = 0

      for (const item of pending) {
        try {
          if (item.op.kind === 'close') {
            await gitea.closeIssue({ owner: item.op.owner, repo: item.op.repo, index: item.op.index })
          }
          if (item.op.kind === 'assign') {
            await gitea.setAssignees({
              owner: item.op.owner, repo: item.op.repo, index: item.op.index,
              logins: item.op.login === '' ? [] : [item.op.login],
            })
          }
          sent += 1
        } catch (error) {
          item.attempts += 1
          if (item.attempts < maxAttempts) {
            queue.push(item)
            retried += 1
            continue
          }
          dropped += 1
          logger?.warn?.(`dsh-kanban: Gitea delivery failed permanently: ${error?.message}`)
          try {
            const currentStore = typeof store === 'function' ? store() : store
            const task = currentStore?.getTask?.(item.taskId)
            if (task !== undefined) {
              currentStore?.addTransition?.({
                taskId: item.taskId,
                fromCol: task.column,
                toCol: task.column,
                source: 'gitea',
                detail: `failed delivery to Gitea after ${item.attempts} attempts: ${item.op.kind}`,
              })
            }
          } catch { /* log must not fail delivery */ }
        }
      }
      return { sent, retried, dropped }
    },
  }
}

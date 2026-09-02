// Канбан → Gitea: закрытие issue.
//
// Отправка идёт очередью, а не прямо из обработчика переноса. Причина простая:
// Gitea может быть недоступен, а доска обязана двигать карточки и при
// недоступном Gitea. Перенос, ждущий сети, превратил бы доску в заложника
// чужого времени ответа.
//
// Неудачная отправка не теряется и не молчит: она повторяется, а после
// нескольких неудач попадает в журнал задачи как проблема. Молча съеденное
// расхождение — худшее, что может сделать синхронизация.
//
// Меток колонок доска НЕ ставит. Она их никогда и не читала: колонка выводится
// из состояния issue, ветки и pull request, а метка лишь пересказывала в Gitea
// то, что там уже написано. Взамен доска не трогает чужую разметку вовсе.

/**
 * Что отправить в Gitea при смене ответственного.
 *
 * Своей задачи (без issue) это не касается: назначать там некого и негде.
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
  // Закрытие issue — единственное, что доска сообщает Gitea: это факт, а не
  // пересказ фактов, которые в issue и так видны.
  return column === 'done'
    ? [{ kind: 'close', owner: task.owner, repo: task.repo, index: task.issueNumber }]
    : []
}

/**
 * Очередь отправки с повторами.
 *
 * @param {object} options
 * @param {object} options.gitea клиент
 * @param {object} options.store хранилище — туда пишется отчёт о неудаче
 * @param {number} [options.maxAttempts] после скольких неудач сдаться и записать
 */
export function createOutbox({ gitea, store, logger, maxAttempts = 4 }) {
  const queue = []

  return {
    size: () => queue.length,

    push(taskId, ops) {
      for (const op of ops) queue.push({ taskId, op, attempts: 0 })
    },

    /**
     * Попробовать отправить всё накопленное.
     *
     * Успех убирает операцию, неудача возвращает её в очередь до предела
     * попыток. Исчерпав попытки, операция НЕ исчезает молча: о ней пишется в
     * журнал задачи, чтобы расхождение с Gitea было видно человеку.
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
          logger?.warn?.(`dsh-kanban: отправка в Gitea не удалась окончательно: ${error?.message}`)
          try {
            const task = store.getTask(item.taskId)
            if (task !== undefined) {
              store.addTransition({
                taskId: item.taskId,
                fromCol: task.column,
                toCol: task.column,
                source: 'gitea',
                detail: `не отправлено в Gitea после ${item.attempts} попыток: ${item.op.kind}`,
              })
            }
          } catch { /* журнал не должен ронять отправку */ }
        }
      }
      return { sent, retried, dropped }
    },
  }
}

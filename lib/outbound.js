// Канбан → Gitea: метки колонок и закрытие issue.
//
// Отправка идёт очередью, а не прямо из обработчика переноса. Причина простая:
// Gitea может быть недоступен, а доска обязана двигать карточки и при
// недоступном Gitea. Перенос, ждущий сети, превратил бы доску в заложника
// чужого времени ответа.
//
// Неудачная отправка не теряется и не молчит: она повторяется, а после
// нескольких неудач попадает в журнал задачи как проблема. Молча съеденное
// расхождение — худшее, что может сделать синхронизация.

import { columnLabelField, COLUMN_ORDER } from './config.js'

/**
 * Что отправить в Gitea при переносе карточки.
 *
 * Метки других колонок снимаются: карточка не может быть одновременно «в
 * работе» и «в ревью», а Gitea сам старую метку не уберёт.
 *
 * @returns {Array<object>} список операций; пустой, если отправлять нечего
 */
export function planOutbound(task, column, config) {
  if (typeof task?.issueNumber !== 'number') return []

  const ours = new Set(
    COLUMN_ORDER.map((id) => columnLabelField(config, id)).filter((name) => name !== ''),
  )
  const wanted = columnLabelField(config, column)

  // Чужие метки не трогаем: на issue живут метки процесса — bug, feat, hotfix,
  // и стереть их доска права не имеет.
  const keep = (task.labels ?? []).filter((name) => !ours.has(name))
  const next = wanted === '' ? keep : [...keep, wanted]

  const ops = []
  const same = next.length === (task.labels ?? []).length
    && next.every((name) => (task.labels ?? []).includes(name))
  if (!same) {
    ops.push({
      kind: 'labels', owner: task.owner, repo: task.repo, index: task.issueNumber, labels: next,
      // Заводить в чужом репозитории доска имеет право только СВОИ метки
      // колонок. Чужие метки процесса она назначает, лишь если они уже есть.
      creatable: [...ours],
    })
  }
  if (column === 'done') {
    ops.push({ kind: 'close', owner: task.owner, repo: task.repo, index: task.issueNumber })
  }
  return ops
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
          if (item.op.kind === 'labels') {
            await gitea.setLabels({
              owner: item.op.owner, repo: item.op.repo, index: item.op.index,
              labels: item.op.labels, creatable: item.op.creatable ?? [],
            })
          } else if (item.op.kind === 'close') {
            await gitea.closeIssue({ owner: item.op.owner, repo: item.op.repo, index: item.op.index })
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

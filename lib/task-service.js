import { columnsOf } from './config.js'

export const TASK_PROVISION_CONTRACT = 'dsh-drives.task-provision.v1'

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function createKanbanTaskService({ getStore, store } = {}) {
  const currentStore = () => getStore?.() || store
  return {
    contract: TASK_PROVISION_CONTRACT,
    async createTask(input = {}) {
      const activeStore = currentStore()
      if (!activeStore || typeof activeStore.createTask !== 'function') {
        return { ok: false, code: 'store-not-ready' }
      }
      const title = text(input.title)
      if (!title) return { ok: false, code: 'title-required' }
      if (title.length > 512) return { ok: false, code: 'title-too-long' }
      const board = text(input.board) || 'main'
      const column = text(input.column) || 'backlog'
      const boards = typeof activeStore.listBoards === 'function' ? activeStore.listBoards() : []
      if (!boards.some((item) => item.id === board)) {
        return { ok: false, code: 'board-not-found', board }
      }
      const allowed = columnsOf(activeStore.boardKind(board))
      if (!allowed.includes(column)) {
        return { ok: false, code: 'column-not-found', board, column, allowed }
      }
      const externalRef = text(input.externalRef)
      if (externalRef.length > 256) return { ok: false, code: 'external-ref-too-long' }
      if (externalRef && typeof activeStore.findTaskByExternalRef === 'function') {
        const existing = activeStore.findTaskByExternalRef(externalRef)
        if (existing) {
          return { ok: true, task: existing, taskId: existing.id, alreadyExists: true }
        }
      }
      const task = activeStore.createTask({
        board,
        column,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        owner: text(input.owner) || null,
        repo: text(input.repo) || null,
        issueNumber: Number.isInteger(input.issueNumber) ? input.issueNumber : null,
        issueUrl: typeof input.issueUrl === 'string' ? input.issueUrl : null,
        labels: Array.isArray(input.labels)
          ? [...new Set(input.labels.filter((label) => typeof label === 'string').map((label) => label.trim()).filter(Boolean))]
          : [],
        externalRef: externalRef || null,
      })
      return { ok: true, task, taskId: task.id, alreadyExists: false }
    },
  }
}

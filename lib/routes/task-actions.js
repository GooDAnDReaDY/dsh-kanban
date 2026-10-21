import { isTimeMachineAvailable, listTaskSnapshots, createCheckpointSnapshot, rollbackToSnapshot } from '../time-machine.js'

/**
 * Extended actions for task route handlers (comments, reports, checklist, triage, subtasks, PR, nudge).
 * Zero Cyrillic in lib/ according to Issue #366.
 */

export function handleTaskChecklist({ store, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const list = Array.isArray(input?.checklist) ? input.checklist : Array.isArray(input) ? input : []
  const updated = store.updateChecklist(task.id, list)
  return { status: 200, body: { task: updated } }
}

/**
 * Set completion report for task.
 */
export function handleTaskReport({ store, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const updated = store.setReport(task.id, input)
  return { status: 200, body: { task: updated } }
}

/**
 * Get comments for task.
 */
export function handleGetTaskComments({ task }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  return { status: 200, body: { comments: task.comments || [] } }
}

/**
 * Add comment to task.
 */
export function handleAddTaskComment({ store, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const author = input?.author || 'user'
  const role = input?.role || 'user'
  const text = input?.text || ''
  const updated = store.addComment(task.id, { author, role, text })
  return { status: 200, body: { task: updated } }
}

/**
 * Accept task review (transition to done).
 */
export function handleAcceptTask({ store, task }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const updated = store.acceptTask(task.id)
  return { status: 200, body: { task: updated } }
}

/**
 * Reject task review (return to in_progress).
 */
export function handleRejectTask({ store, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const reason = String(input?.reason || '').trim()
  if (!reason) return { status: 400, body: { error: 'reason-required' } }
  const updated = store.rejectTask(task.id, reason)
  return { status: 200, body: { task: updated } }
}

/**
 * Save task progress dump snapshot.
 */
export function handleProgressDump({ store, task, input, formatProgressDump }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const formatted = typeof input === 'string' ? input : formatProgressDump(input)
  const updated = store.updateTask(task.id, { progressDump: formatted })
  return { status: 200, body: { task: updated } }
}

/**
 * Decompose a task into subtasks and make the parent an Epic.
 */
export async function handleTriageTask({ store, gitea, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const subtasksInput = Array.isArray(input?.subtasks) ? input.subtasks : []
  if (subtasksInput.length === 0) {
    return { status: 400, body: { error: 'subtasks-required' } }
  }
  const createGitea = input?.createGiteaIssues === true && Boolean(task.owner && task.repo && gitea)

  // Convert parent into Epic
  store.updateTask(task.id, { isEpic: true })

  const created = []
  for (const item of subtasksInput) {
    const title = String(item?.title ?? '').trim()
    if (!title) continue
    const body = String(item?.body ?? '').trim()
    let issueNumber = null
    let issueUrl = null

    if (createGitea) {
      try {
        const issueBody = body ? `${body}\n\nParent epic: #${task.issueNumber || task.id}` : `Parent epic: #${task.issueNumber || task.id}`
        const giteaIssue = await gitea.createIssue({
          owner: task.owner,
          repo: task.repo,
          title,
          body: issueBody,
        })
        if (giteaIssue?.number) {
          issueNumber = giteaIssue.number
          issueUrl = giteaIssue.html_url || null
        }
      } catch { /* ignore gitea subtask creation failure */ }
    }

    const sub = store.createTask({
      board: task.board || 'main',
      column: 'backlog',
      title,
      body,
      parentId: task.id,
      owner: task.owner || null,
      repo: task.repo || null,
      issueNumber,
      issueUrl,
      labels: Array.isArray(item?.labels) ? item.labels : [],
      workspaceId: task.workspaceId || '',
    })
    created.push(sub)
  }

  store.addTransition({
    taskId: task.id,
    fromCol: task.column,
    toCol: task.column,
    source: 'manual',
    detail: `decomposed into ${created.length} subtasks (epic triage)`,
  })

  return {
    status: 200,
    body: {
      epic: store.getTask(task.id),
      subtasks: store.listSubtasks(task.id),
      counts: store.countSubtasks(task.id),
      createdCount: created.length,
    },
  }
}

/**
 * Get subtasks of a task.
 */
export function handleGetSubtasks({ store, task }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  return {
    status: 200,
    body: {
      subtasks: store.listSubtasks(task.id),
      counts: store.countSubtasks(task.id),
    },
  }
}

/**
 * Create a single subtask linked to a parent task.
 */
export async function handleCreateSubtask({ store, gitea, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const title = String(input?.title ?? '').trim()
  if (!title) return { status: 400, body: { error: 'title-required' } }
  const body = String(input?.body ?? '').trim()
  let issueNumber = null
  let issueUrl = null

  if (input?.createGiteaIssue === true && task.owner && task.repo && gitea) {
    try {
      const issueBody = body ? `${body}\n\nParent epic: #${task.issueNumber || task.id}` : `Parent epic: #${task.issueNumber || task.id}`
      const giteaIssue = await gitea.createIssue({
        owner: task.owner,
        repo: task.repo,
        title,
        body: issueBody,
      })
      if (giteaIssue?.number) {
        issueNumber = giteaIssue.number
        issueUrl = giteaIssue.html_url || null
      }
    } catch { /* ignore gitea subtask creation failure */ }
  }

  store.updateTask(task.id, { isEpic: true })
  const sub = store.createTask({
    board: task.board || 'main',
    column: input?.column || 'backlog',
    title,
    body,
    parentId: task.id,
    owner: task.owner || null,
    repo: task.repo || null,
    issueNumber,
    issueUrl,
    labels: Array.isArray(input?.labels) ? input.labels : [],
    workspaceId: task.workspaceId || '',
  })
  return { status: 200, body: { subtask: sub, counts: store.countSubtasks(task.id) } }
}

/**
 * Toggle a checklist item atomically by index or text.
 */
export function handleToggleChecklistItem({ store, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const current = Array.isArray(task.checklist) ? [...task.checklist] : []
  let targetIndex = -1

  if (typeof input?.index === 'number' && input.index >= 0 && input.index < current.length) {
    targetIndex = input.index
  } else if (typeof input?.text === 'string' && input.text.trim()) {
    const q = input.text.trim().toLowerCase()
    targetIndex = current.findIndex((item) => {
      const t = typeof item === 'string' ? item : item?.text
      return typeof t === 'string' && t.toLowerCase().includes(q)
    })
  }

  if (targetIndex === -1) {
    return { status: 404, body: { error: 'checklist-item-not-found' } }
  }

  const item = current[targetIndex]
  let updatedItem
  if (typeof item === 'string') {
    const checked = input?.checked !== undefined ? Boolean(input.checked) : true
    updatedItem = { text: item, completed: checked, done: checked }
  } else {
    const isCurrentlyDone = item.completed !== undefined ? Boolean(item.completed) : Boolean(item.done)
    const checked = input?.checked !== undefined ? Boolean(input.checked) : !isCurrentlyDone
    updatedItem = { ...item, completed: checked, done: checked }
  }
  current[targetIndex] = updatedItem
  const updated = store.updateChecklist(task.id, current)
  return { status: 200, body: { task: updated, item: updatedItem, index: targetIndex } }
}

/**
 * Create a Gitea Pull Request for a task.
 */
export async function handleCreateTaskPr({ store, gitea, task, input }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  if (!task.owner || !task.repo) {
    return { status: 400, body: { error: 'task-no-repo' } }
  }
  const head = String(input?.head || task.branch || '').trim()
  if (!head) return { status: 400, body: { error: 'branch-required' } }
  const base = String(input?.base || 'main').trim()
  const title = String(input?.title || task.title || `PR: ${task.title}`).trim()
  const body = String(input?.body || (task.issueNumber ? `Closes #${task.issueNumber}` : '')).trim()

  try {
    const pr = await gitea.createPullRequest({
      owner: task.owner,
      repo: task.repo,
      title,
      body,
      head,
      base,
    })
    store.addTransition({
      taskId: task.id,
      fromCol: task.column,
      toCol: task.column,
      source: 'manual',
      detail: `Created PR #${pr?.number || ''}: ${head} -> ${base}`,
    })
    return { status: 200, body: { pr, prUrl: pr?.html_url } }
  } catch (err) {
    return { status: 502, body: { error: 'gitea-pr-failed', detail: err?.message } }
  }
}
/**
 * Handle interactive live steering (nudge) for an active task agent (#373).
 *
 * @param {{
 *   store: object,
 *   id: string,
 *   prompt: string,
 *   agents?: object,
 *   createMessage?: Function,
 *   eventHub?: object,
 *   now?: number
 * }} options
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleTaskNudge({ store, id, prompt, agents, createMessage, eventHub, now = Date.now() }) {
  if (!store || !id) return { status: 400, body: { error: 'invalid-parameters' } }
  const task = store.getTask(id)
  if (!task) return { status: 404, body: { error: 'task-not-found' } }

  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (!text) return { status: 400, body: { error: 'prompt-required' } }

  const sessionId = typeof task.sessionId === 'string' ? task.sessionId : ''
  if (!sessionId) return { status: 409, body: { error: 'no-session' } }

  let agent
  try { agent = agents?.get?.(sessionId) } catch { agent = undefined }
  if (!agent || typeof agent.followup !== 'function') {
    return { status: 409, body: { error: 'session-not-live' } }
  }

  const msg = typeof createMessage === 'function'
    ? createMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-kanban', plugin: 'dsh-kanban', form: 'task-nudge' },
      })
    : { content: [{ type: 'text', text }] }

  agent.followup(msg)

  // Append user steering comment to task
  if (typeof store.addComment === 'function') {
    store.addComment(id, {
      author: 'user',
      role: 'user',
      text: `[Steering Nudge] ${text}`,
    })
  } else if (typeof store.addTaskComment === 'function') {
    store.addTaskComment(id, {
      author: 'user',
      role: 'user',
      text: `[Steering Nudge] ${text}`,
    })
  }

  // Broadcast change via eventHub
  if (eventHub && typeof eventHub.broadcast === 'function') {
    eventHub.broadcast('task:change', { id, col: task.col || task.column })
  }

  return {
    status: 200,
    body: {
      success: true,
      id,
      sessionId,
      prompt: text,
      nudgedAt: now,
    },
  }
}

/**
 * Handle listing or creating snapshots via dsh-time-machine (#377).
 */
export async function handleTaskSnapshot({ ctx, store, id, method, body, config, env, cwdOf, logger }) {
  const task = store.getTask(id)
  if (!task) return { status: 404, body: { error: 'task-not-found' } }

  if (method === 'GET') {
    const available = isTimeMachineAvailable(ctx)
    const snapshots = available ? await listTaskSnapshots({ ctx, task }) : []
    return {
      status: 200,
      body: {
        available,
        inceptionSnapshotId: task.inceptionSnapshotId || '',
        snapshots,
      },
    }
  }

  if (method === 'POST') {
    const label = typeof body?.label === 'string' ? body.label.trim() : ''
    const res = await createCheckpointSnapshot({ ctx, task, label, config, env, cwdOf, logger })
    if (!res.available) {
      return {
        status: 503,
        body: {
          error: 'time-machine-unavailable',
          message: 'Plugin @goodandready/dsh-time-machine is not installed or active in this profile.',
        },
      }
    }
    if (!res.created) {
      return { status: 500, body: { error: 'snapshot-failed', message: res.error } }
    }
    return { status: 201, body: { success: true, snapshot: res.snapshot } }
  }

  return { status: 405, body: { error: 'method-not-allowed' } }
}

/**
 * Handle rolling back task worktree to inception or specified snapshot (#377).
 */
export async function handleTaskRollbackSnapshot({ ctx, store, id, body, config, env, cwdOf, logger, eventHub }) {
  const task = store.getTask(id)
  if (!task) return { status: 404, body: { error: 'task-not-found' } }

  const snapshotId = typeof body?.snapshotId === 'string' ? body.snapshotId.trim() : task.inceptionSnapshotId
  const res = await rollbackToSnapshot({ ctx, task, snapshotId, config, env, cwdOf, logger })
  if (!res.available) {
    return { status: 503, body: { error: 'time-machine-unavailable', message: res.message } }
  }
  if (!res.rolledBack) {
    return { status: 400, body: { error: res.error, message: res.message } }
  }

  if (eventHub && typeof eventHub.broadcast === 'function') {
    eventHub.broadcast('task:change', { taskId: id, action: 'rollback', snapshotId: res.snapshotId })
  }

  return {
    status: 200,
    body: {
      success: true,
      snapshotId: res.snapshotId,
      result: res.result,
    },
  }
}

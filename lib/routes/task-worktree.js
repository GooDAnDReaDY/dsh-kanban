/**
 * Worktree actions for task route handlers.
 * Zero Cyrillic in lib/ according to Issue #366.
 */

export async function handleCleanupWorktree({
  store, task, workspaceRegistry, force, cleanupTaskWorktree,
  config, repoDir, cwdOf, env, gitRunner,
}) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const out = await cleanupTaskWorktree({
    store,
    task,
    workspaceRegistry,
    force: force === true,
    config,
    repoDir,
    cwdOf,
    env,
    gitRunner,
  })
  const status = out.status || (out.error ? (out.error === 'unfenced-worktree-path' ? 403 : 500) : 200)
  return { status, body: out }
}

/**
 * Get working copy diff for task.
 */
export async function handleTaskDiff({ task, getTaskDiff, getTaskDiffInspector }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  if (typeof getTaskDiffInspector === 'function') {
    const inspectorResult = await getTaskDiffInspector({ worktreePath: task.worktree })
    return { status: 200, body: inspectorResult }
  }
  const diffResult = await getTaskDiff({ worktreePath: task.worktree })
  return { status: 200, body: diffResult }
}

/**
 * Discard file changes in task worktree (#371).
 */
export async function handleTaskDiscard({ task, file, discardTaskFile, gitRunner }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  if (!file || typeof file !== 'string') return { status: 400, body: { error: 'file-required' } }
  if (!task.worktree) return { status: 400, body: { error: 'no-worktree' } }
  const result = await discardTaskFile({ worktreePath: task.worktree, file, gitRunner })
  return { status: result.success ? 200 : 400, body: result }
}

/**
 * Get commit list for task.
 */
export async function handleTaskCommits({ task, getTaskCommits, gitRunner }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const commits = await getTaskCommits({ worktreePath: task.worktree, gitRunner })
  return { status: 200, body: { commits } }
}

/**
 * Merge task worktree branch and transition to done.
 */
export async function handleTaskMerge({ store, task, targetBranch, workspaceRegistry, mergeTaskWorktree, gitRunner }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const mergeResult = await mergeTaskWorktree({
    task,
    targetBranch: typeof targetBranch === 'string' ? targetBranch.trim() : undefined,
    workspaceRegistry,
    gitRunner,
  })
  if (!mergeResult.success) {
    return {
      status: 400,
      body: { error: mergeResult.error, detail: mergeResult.detail, files: mergeResult.files },
    }
  }
  const updated = store.acceptTask(task.id)
  store.addTransition({
    taskId: task.id,
    fromCol: task.column,
    toCol: 'done',
    source: 'manual',
    detail: `accepted and merged branch ${task.branch} into ${mergeResult.targetBranch}`,
  })
  return { status: 200, body: { task: updated, merged: true, targetBranch: mergeResult.targetBranch } }
}

/**
 * Check task worktree status (branch, dirty files, workspace).
 */
export async function handleTaskWorktreeStatus({ task, checkWorktreeDirty }) {
  if (!task) return { status: 404, body: { error: 'task-not-found' } }
  const dirtyCheck = await checkWorktreeDirty({ worktreePath: task.worktree })
  return {
    status: 200,
    body: {
      worktree: task.worktree || '',
      branch: task.branch || '',
      workspaceId: task.workspaceId || '',
      dirty: dirtyCheck.dirty,
      files: dirtyCheck.files,
    },
  }
}

/**
 * Update Definition of Done checklist for task.
 */
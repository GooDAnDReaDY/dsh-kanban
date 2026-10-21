// Directed Acyclic Graph (DAG) task dependency validation and auto-unblocking logic.
// Enforces that tasks with unresolved blockers cannot transition to in-progress.
// Cycle detection prevents circular dependencies (e.g. A -> B -> A).

/**
 * Check if targetId is reachable from startId following blockedBy links.
 *
 * @param {string} startId starting task identifier
 * @param {string} targetId target task identifier
 * @param {Function|object} getTaskFn task getter function or store
 * @param {Set<string>} [visited] visited set to break cycles during traversal
 * @returns {boolean} true if targetId is reachable
 */
function canReach(startId, targetId, getTaskFn, visited = new Set()) {
  if (startId === targetId) return true
  if (visited.has(startId)) return false
  visited.add(startId)

  const task = typeof getTaskFn === 'function' ? getTaskFn(startId) : getTaskFn?.getTask?.(startId)
  if (!task) return false

  const blockers = Array.isArray(task.blockedBy) ? task.blockedBy : []
  for (const nextId of blockers) {
    if (typeof nextId === 'string' && nextId.trim() !== '') {
      if (canReach(nextId, targetId, getTaskFn, visited)) return true
    }
  }
  return false
}

/**
 * Validate proposed dependencies for a task against cycles and self-references.
 *
 * @param {string} taskId task identifier
 * @param {string[]} newBlockedBy proposed array of blocking task IDs
 * @param {Function|object} getTaskFn task getter function or store
 * @returns {{valid: boolean, error?: string}}
 */
export function validateDependencies(taskId, newBlockedBy, getTaskFn) {
  if (!Array.isArray(newBlockedBy)) {
    return { valid: true }
  }

  // 1. Check self-dependency
  if (newBlockedBy.includes(taskId)) {
    return {
      valid: false,
      error: `Self-dependency: task "${taskId}" cannot depend on itself.`,
    }
  }

  // 2. Check for circular dependency
  for (const blockerId of newBlockedBy) {
    if (typeof blockerId !== 'string' || blockerId.trim() === '') continue
    if (canReach(blockerId, taskId, getTaskFn)) {
      return {
        valid: false,
        error: `Circular dependency detected: task "${blockerId}" already depends on "${taskId}".`,
      }
    }
  }

  return { valid: true }
}

/**
 * Compute reverse mapping (blocks) from blockedBy relations across tasks.
 *
 * @param {Array<object>} tasks list of all tasks
 * @returns {Record<string, string[]>} mapping of taskId to list of tasks it blocks
 */
export function computeBlocksMap(tasks) {
  const blocks = {}
  if (!Array.isArray(tasks)) return blocks

  for (const task of tasks) {
    if (task && typeof task.id === 'string') {
      blocks[task.id] = []
    }
  }

  for (const task of tasks) {
    if (!task || typeof task.id !== 'string') continue
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : []
    for (const bId of blockedBy) {
      if (typeof bId === 'string' && bId.trim() !== '') {
        if (!blocks[bId]) blocks[bId] = []
        if (!blocks[bId].includes(task.id)) {
          blocks[bId].push(task.id)
        }
      }
    }
  }

  return blocks
}

/**
 * Check whether a task is blocked by unfinished tasks.
 *
 * @param {object} task task object
 * @param {Function|object} getTaskFn task getter function or store
 * @returns {{isBlocked: boolean, pendingBlockers: Array<object>}}
 */
export function checkTaskBlocked(task, getTaskFn) {
  const blockedBy = Array.isArray(task?.blockedBy) ? task.blockedBy : []
  if (blockedBy.length === 0) {
    return { isBlocked: false, pendingBlockers: [] }
  }

  const pending = []
  for (const bId of blockedBy) {
    if (typeof bId !== 'string' || bId.trim() === '') continue
    const bTask = typeof getTaskFn === 'function' ? getTaskFn(bId) : getTaskFn?.getTask?.(bId)
    if (bTask && bTask.column !== 'done') {
      pending.push(bTask)
    }
  }

  return {
    isBlocked: pending.length > 0,
    pendingBlockers: pending,
  }
}

/**
 * Check if moving a task to a target column is allowed under dependency constraints.
 *
 * @param {object} task task object
 * @param {string} targetColumn target column
 * @param {Function|object} getTaskFn task getter function or store
 * @returns {{allowed: boolean, reason?: string, pendingBlockers?: Array<object>}}
 */
export function checkMoveAllowed(task, targetColumn, getTaskFn) {
  if (targetColumn === 'in-progress') {
    const check = checkTaskBlocked(task, getTaskFn)
    if (check.isBlocked) {
      const names = check.pendingBlockers.map((b) => b.title || b.id).join(', ')
      return {
        allowed: false,
        reason: `Cannot move card to in-progress: task is blocked by unfinished tasks (${names}). All blockers must be in done before starting.`,
        pendingBlockers: check.pendingBlockers,
      }
    }
  }
  return { allowed: true }
}

/**
 * Find all tasks that were blocked by completedTaskId and are now unblocked.
 *
 * @param {string} completedTaskId ID of task moving to done
 * @param {Function|object} getTaskFn task getter function or store
 * @param {Function} listTasksFn function returning all tasks
 * @returns {Array<object>} tasks that transitioned from blocked to unblocked
 */
export function findUnblockedDependents(completedTaskId, getTaskFn, listTasksFn) {
  const allTasks = typeof listTasksFn === 'function' ? listTasksFn() : []
  const unblocked = []

  for (const task of allTasks) {
    if (!task || task.column === 'done') continue
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : []
    if (!blockedBy.includes(completedTaskId)) continue

    // Check if task is still blocked by any other unfinished task
    const check = checkTaskBlocked(task, getTaskFn)
    if (!check.isBlocked) {
      unblocked.push(task)
    }
  }

  return unblocked
}


// Integration service for @goodandready/dsh-time-machine snapshot and rollback capabilities.
// Provides automatic inception snapshots on task start and one-click rollback to clean state.
// Degrades gracefully when @goodandready/dsh-time-machine plugin is not installed in DSH profile.

import { resolveTaskWorktreePath } from './worktree.js'

/**
 * Check whether timeMachineEngine is available in the Cordis context.
 *
 * @param {object} ctx Cordis context or harness
 * @returns {boolean} true if time machine engine is available
 */
export function isTimeMachineAvailable(ctx) {
  if (!ctx || typeof ctx !== 'object') return false
  const engine = ctx.timeMachineEngine || (typeof ctx.get === 'function' ? (ctx.get('timeMachineEngine') || ctx.get('timeMachine')) : null)
  return !!(engine && (typeof engine.createSnapshot === 'function' || typeof engine.rollbackSnapshot === 'function' || typeof engine.listSnapshots === 'function'))
}

/**
 * Resolve the timeMachineEngine instance from context.
 *
 * @param {object} ctx Cordis context
 * @returns {object|null}
 */
export function getTimeMachineEngine(ctx) {
  if (!ctx || typeof ctx !== 'object') return null
  const engine = ctx.timeMachineEngine || (typeof ctx.get === 'function' ? (ctx.get('timeMachineEngine') || ctx.get('timeMachine')) : null)
  if (engine && (typeof engine.createSnapshot === 'function' || typeof engine.rollbackSnapshot === 'function' || typeof engine.listSnapshots === 'function')) {
    return engine
  }
  return null
}

/**
 * Resolve the directory path to snapshot for a task.
 *
 * @param {{task: object, config?: object, env?: object, cwdOf?: Function}} options
 * @returns {string}
 */
export function resolveSnapshotDir({ task, config, env, cwdOf }) {
  if (task?.worktree && typeof task.worktree === 'string' && task.worktree.trim() !== '') {
    return task.worktree.trim()
  }
  try {
    const resolved = resolveTaskWorktreePath({ task, config, env, cwdOf: cwdOf || (() => process.cwd()) })
    if (resolved) return resolved
  } catch {
    /* fallback to cwd */
  }
  return typeof cwdOf === 'function' ? cwdOf() : process.cwd()
}

/**
 * Automatically create inception snapshot when task moves to in-progress.
 *
 * @param {{ctx: object, task: object, config?: object, env?: object, cwdOf?: Function, store?: object, logger?: object}} options
 * @returns {Promise<{available: boolean, created: boolean, snapshotId?: string, alreadyExists?: boolean, snapshot?: object, error?: string}>}
 */
export async function createInceptionSnapshot({ ctx, task, config, env, cwdOf, store, logger }) {
  const engine = getTimeMachineEngine(ctx)
  if (!engine) {
    return { available: false, created: false }
  }

  if (task?.inceptionSnapshotId && typeof task.inceptionSnapshotId === 'string' && task.inceptionSnapshotId.trim() !== '') {
    return {
      available: true,
      created: false,
      alreadyExists: true,
      snapshotId: task.inceptionSnapshotId.trim(),
    }
  }

  const targetDir = resolveSnapshotDir({ task, config, env, cwdOf })
  const label = `Inception: ${task?.id || 'task'} (${task?.title || 'untitled'})`
  const sessionId = `task-${task?.id || 'default'}`

  try {
    const snapshot = await engine.createSnapshot(label, {
      sessionId,
      cwd: targetDir,
      skipIfNoChanges: false,
    })

    if (snapshot?.id && store && typeof store.updateTask === 'function' && task?.id) {
      store.updateTask(task.id, { inceptionSnapshotId: snapshot.id })
    }

    return {
      available: true,
      created: true,
      snapshotId: snapshot?.id,
      snapshot,
    }
  } catch (err) {
    logger?.warn?.('[dsh-kanban] Failed to create inception snapshot:', err?.message || err)
    return {
      available: true,
      created: false,
      error: err?.message || String(err),
    }
  }
}

/**
 * Manually create a checkpoint snapshot for a task.
 *
 * @param {{ctx: object, task: object, label?: string, config?: object, env?: object, cwdOf?: Function, logger?: object}} options
 * @returns {Promise<{available: boolean, created: boolean, snapshot?: object, error?: string}>}
 */
export async function createCheckpointSnapshot({ ctx, task, label, config, env, cwdOf, logger }) {
  const engine = getTimeMachineEngine(ctx)
  if (!engine) {
    return { available: false, created: false }
  }

  const targetDir = resolveSnapshotDir({ task, config, env, cwdOf })
  const snapshotLabel = `Checkpoint: ${label || 'manual'} (${task?.id || 'task'})`
  const sessionId = `task-${task?.id || 'default'}`

  try {
    const snapshot = await engine.createSnapshot(snapshotLabel, {
      sessionId,
      cwd: targetDir,
      skipIfNoChanges: false,
    })
    return {
      available: true,
      created: true,
      snapshot,
    }
  } catch (err) {
    logger?.warn?.('[dsh-kanban] Failed to create checkpoint snapshot:', err?.message || err)
    return {
      available: true,
      created: false,
      error: err?.message || String(err),
    }
  }
}

/**
 * Roll back task files to a snapshot (default: inception snapshot).
 *
 * @param {{ctx: object, task: object, snapshotId?: string, config?: object, env?: object, cwdOf?: Function, logger?: object}} options
 * @returns {Promise<{available: boolean, rolledBack: boolean, snapshotId?: string, result?: object, error?: string, message?: string}>}
 */
export async function rollbackToSnapshot({ ctx, task, snapshotId, config, env, cwdOf, logger }) {
  const engine = getTimeMachineEngine(ctx)
  if (!engine) {
    return {
      available: false,
      rolledBack: false,
      error: 'time-machine-unavailable',
      message: 'Plugin @goodandready/dsh-time-machine is not installed or active in this profile.',
    }
  }

  const targetId = snapshotId || task?.inceptionSnapshotId
  if (!targetId || typeof targetId !== 'string' || targetId.trim() === '') {
    return {
      available: true,
      rolledBack: false,
      error: 'no-snapshot-id',
      message: 'No snapshot ID specified and task has no inception snapshot.',
    }
  }

  const targetDir = resolveSnapshotDir({ task, config, env, cwdOf })

  try {
    const result = await engine.rollbackSnapshot(String(targetId).trim(), {
      confirm: true,
      cwd: targetDir,
    })
    return {
      available: true,
      rolledBack: true,
      snapshotId: targetId,
      result,
    }
  } catch (err) {
    logger?.error?.('[dsh-kanban] Failed to rollback snapshot:', err?.message || err)
    return {
      available: true,
      rolledBack: false,
      error: 'rollback-failed',
      message: err?.message || String(err),
    }
  }
}

/**
 * List snapshots for a task.
 *
 * @param {{ctx: object, task: object}} options
 * @returns {Promise<Array<object>>}
 */
export async function listTaskSnapshots({ ctx, task }) {
  const engine = getTimeMachineEngine(ctx)
  if (!engine || !task?.id) return []

  const sessionId = `task-${task.id}`
  try {
    if (typeof engine.listSnapshots === 'function') {
      const list = engine.listSnapshots(sessionId)
      return Array.isArray(list) ? list : []
    }
  } catch {
    /* ignore error */
  }
  return []
}


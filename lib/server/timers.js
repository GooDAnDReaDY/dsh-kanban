import { computeNextRun } from '../cron.js'
import { PERMISSION_RANKS, resolveModel, runTask } from '../launcher.js'
import { createOutbox, planOutbound } from '../outbound.js'
import { createSyncState, syncAll, intakeAll, archiveOverdue } from '../sync.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

export function registerKanbanTimers(ctx, deps) {
  const {
    store,
    getConfig,
    eventHub,
    syncPower,
    git,
    gitea,
    github,
    rearmers,
    watchdog,
  } = deps

  ctx.effect(() => {
    let cronTimer
    const armCron = () => {
      clearInterval(cronTimer)
      cronTimer = undefined
      if (getConfig().cronEnabled !== true) return
      cronTimer = setInterval(async () => {
        try {
          if (!store) return
          const now = Date.now()
          const dueTasks = store.listDueTasks(now)
          for (const task of dueTasks) {
            if (task.column === 'in-progress') {
              const next = computeNextRun(task.cron, now)
              store.updateTask(task.id, { lastRunAt: now, nextRunAt: next || 0 })
              continue
            }
            if (getConfig().permissionGateEnabled) {
              const perm = task.permission || 'read-only'
              const defaultPerm = getConfig().sessionDefaultPermission || 'read-only'
              if ((PERMISSION_RANKS[perm] ?? 0) > (PERMISSION_RANKS[defaultPerm] ?? 0) && !task.permissionConfirmedAt) {
                const next = computeNextRun(task.cron, now)
                store.updateTask(task.id, { lastRunAt: now, nextRunAt: next || 0 })
                store.addTransition({
                  taskId: task.id,
                  fromCol: task.column,
                  toCol: task.column,
                  source: 'tool',
                  detail: 'cron: run rejected (elevated permission required)',
                })
                continue
              }
            }
            const picked = resolveModel({
              requested: { model: task.model, provider: task.provider },
              fallback: ctx.get('agentDefaultModel')?.currentSelection?.(),
            })
            if (picked.model) {
              await runTask({
                agents: ctx.agents,
                store,
                task,
                config: getConfig(),
                provider: picked.provider,
                model: picked.model,
                mintSessionId: () => SessionId(`kanban-${task.id}-${randomUUID()}`),
                createMessage: createUserMessage,
                logger: ctx.logger,
                workspaceRegistry: ctx.get('workspaceRegistry'),
                claimAs: 'cron',
              })
              syncPower()
            }
            const next = computeNextRun(task.cron, now)
            store.updateTask(task.id, { lastRunAt: now, nextRunAt: next || 0 })
          }
        } catch (err) {
          ctx.logger?.warn?.(`dsh-kanban: cron scheduler error: ${err?.message}`)
        }
      }, 30_000)
      if (typeof cronTimer.unref === 'function') cronTimer.unref()
    }
    armCron()
    rearmers.add(armCron)
    return () => { rearmers.delete(armCron); clearInterval(cronTimer) }
  }, 'dsh-kanban: cron scheduler')

  const outbox = createOutbox({ gitea: git, get store() { return store }, logger: ctx.logger })

  const queueOutbound = (taskId, column) => {
    if (getConfig().pushToGitea !== true) return
    const task = store.getTask(taskId)
    if (task === undefined) return
    const ops = planOutbound(task, column, getConfig())
    if (ops.length > 0) outbox.push(taskId, ops)
  }

  let discoveredOwner
  const defaultOwner = async () => {
    const named = String(getConfig().giteaOwner ?? '').trim()
    if (named !== '') return named
    for (const task of store.listWatchable()) {
      if (typeof task.owner === 'string' && task.owner !== '') return task.owner
    }
    if (discoveredOwner !== undefined) return discoveredOwner
    const orgs = await gitea.listOrgs()
    if (orgs.length === 1) { discoveredOwner = orgs[0]; return discoveredOwner }
    return undefined
  }

  const syncState = createSyncState()

  let syncing = false
  const runSync = async () => {
    if (syncing) return { skipped: true }
    syncing = true
    syncState.started()
    try {
      const mode = String(getConfig()?.gitProvider || 'auto').toLowerCase()
      const providersToSync = []
      if (mode === 'github') {
        providersToSync.push(github)
      } else if (mode === 'gitea') {
        providersToSync.push(gitea)
      } else {
        if (await gitea.isConfigured()) providersToSync.push(gitea)
        if (await github.isConfigured()) providersToSync.push(github)
        if (providersToSync.length === 0) providersToSync.push(gitea)
      }

      let taken = { added: 0, skipped: 0, failed: 0 }
      for (const p of providersToSync) {
        const owner = p === github
          ? (String(getConfig()?.githubOwner ?? '').trim() || await p.me().catch(() => ''))
          : await defaultOwner()
        const res = await intakeAll({
          gitea: p, store, config: getConfig(), owner, logger: ctx.logger,
        })
        if (res && typeof res.added === 'number') {
          taken.added = (taken.added || 0) + res.added
          taken.skipped = (taken.skipped || 0) + (res.skipped || 0)
          taken.failed = (taken.failed || 0) + (res.failed || 0)
        }
        if (res?.problem) taken.problem = res.problem
      }
      const out = await syncAll({ gitea: git, store, logger: ctx.logger })
      const tidied = archiveOverdue({ store, config: getConfig() })
      const pushed = await outbox.flush()
      syncState.finished(out.problem === undefined && taken.problem !== undefined
        ? { ...out, problem: taken.problem }
        : out)
      return { ...out, pushed, taken, tidied }
    } catch (error) {
      syncState.failedToStart('sync', error?.message)
      throw error
    } finally {
      syncing = false
    }
  }

  ctx.effect(() => {
    let timer
    const arm = () => {
      const seconds = Number(getConfig().syncIntervalSec) || 0
      clearInterval(timer)
      timer = undefined
      if (seconds <= 0) return
      timer = setInterval(() => { runSync().catch(() => {}) }, Math.max(seconds, 15) * 1000)
      if (typeof timer.unref === 'function') timer.unref()
    }
    arm()
    rearmers.add(arm)
    return () => { rearmers.delete(arm); clearInterval(timer) }
  }, 'dsh-kanban: sync timer')

  ctx.effect(() => {
    let watchdogTimer
    const armWatchdog = () => {
      clearInterval(watchdogTimer)
      watchdogTimer = undefined
      if (getConfig().watchdogEnabled === false || !watchdog) return
      watchdogTimer = setInterval(() => {
        try {
          watchdog.checkTasks({
            store,
            agents: ctx.agents,
            config: getConfig(),
            eventHub,
            logger: ctx.logger,
          })
        } catch (err) {
          ctx.logger?.warn?.(`dsh-kanban: watchdog check error: ${err?.message}`)
        }
      }, 15000)
      if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
    }
    armWatchdog()
    rearmers.add(armWatchdog)
    return () => { rearmers.delete(armWatchdog); clearInterval(watchdogTimer) }
  }, 'dsh-kanban: watchdog timer')

  return { syncState, runSync, defaultOwner, queueOutbound }
}

import { registerPluginUpdater } from './updater.js'
// dsh-kanban — task board for DeepSeek Harness.
//
// Plugin consists of two halves: this module is the backend server, and `lib/client.js` is the
// browser bundle. The package name `@goodandready/dsh-kanban` must match in three places:
// `package.json`, `cordis.patch.yml`, and `load({ id })` in client.js.
//
// Pure domain logic is kept in standalone modules (`config.js`, `order.js`, `routes.js`)
// and tested without harness runtime. This module handles cordis integration:
// configuration, database storage, and HTTP endpoints.

import {
  MAX_BODY_BYTES,
  isTrustedRequest,
  parseTaskPath,
  buildBoard,
  applyMove,
  createTask,
  updateTask,
  confirmPermission,
  appendNote,
  setArchived,
  listArchive,
  assignTask,
  deleteTask,
  boardMetrics,
  taskBody,
  taskLog,
  taskBySession,
  exportBoard,
  importBoard,
  exportTasksCsv,
  handleCleanupWorktree,
  handleTaskDiff,
  handleTaskCommits,
  handleTaskMerge,
  handleTaskWorktreeStatus,
  handleTaskChecklist,
  handleTaskReport,
  handleGetTaskComments,
  handleAddTaskComment,
  handleAcceptTask,
  handleRejectTask,
  handleProgressDump,
  handleTriageTask,
  handleGetSubtasks,
  handleCreateSubtask,
  handleToggleChecklistItem,
  handleCreateTaskPr,
} from './routes.js'
import { listImportable, importIssue, refreshTask, searchRepos, createProjectTask } from './import.js'
import {
  runTask, resolveModel, buildStartMessage,
  runBatch, queueTask, unqueueTask, liveSessions, dispatchNextQueuedTask,
  PERMISSION_RANKS,
} from './launcher.js'
import { cleanupTaskWorktree, checkWorktreeDirty, getTaskDiff, getTaskCommits, mergeTaskWorktree, defaultGitRunner } from './worktree.js'
import { dispatchMove, MOVE_DETAIL, stopWork, STOP_DETAIL } from './commands.js'
import { createGiteaClient } from './gitea.js'
import { createGitHubClient } from './github.js'
import { createGitProvider } from './git-provider.js'
import { createKanbanTaskService } from './task-service.js'
import { WorkflowBridge } from './workflow-bridge.js'
import { syncAll, createSyncState, intakeAll, archiveOverdue } from './sync.js'
import { isWatched } from './intake.js'
import { handleSessionEvent } from './lifecycle.js'
import {
  boardMoveDefinition,
  boardPlanDefinition,
  boardChecklistDefinition,
  boardReportDefinition,
  boardCommentsDefinition,
  boardCommentAddDefinition,
  boardDecomposeDefinition,
  boardChecklistItemDefinition,
} from './board-tool.js'
import { verifySignature, parseEvent, detectWebhookProvider } from './webhook.js'
import { planOutbound, planAssign, createOutbox } from './outbound.js'
import { computeNextRun } from './cron.js'
import { PowerInhibitor } from './power.js'
import { formatProgressDump, parseProgressDump } from './progress-dump.js'
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openStore } from './store.js'
import {
  COLUMN_ORDER,
  wipLimitField,
  withDefaults,
  CONFIG_DEFAULTS,
  CONFIG_HINTS,
  rootOf,
} from './config.js'
import { eventHub } from './events.js'
import { TASK_TEMPLATES, getTemplateById } from './templates.js'

export { COLUMN_ORDER, wipLimitField, withDefaults } from './config.js'

/** Stable cordis plugin name (patch identifier). */
export const name = '@goodandready/dsh-kanban'

/**
 * Services are injected where needed. Declaring an unavailable service prevents
 * the plugin from loading entirely.
 */
export const inject = ['settings', 'webServer', 'agents', 'agentDefaultModel', 'credentials', 'llm', 'tools']

/** Settings namespace string matching client bundle definition. */
// Constant string defined in this file; identical across core versions.
export const SETTINGS_NAMESPACE = 'dsh-kanban'

/**
 * Schema constructed from default values so fields reside in one place.
 * Scalar values only: client config API only writes scalar fields;
 * dictionaries or arrays here would make the settings card uneditable.
 */
// Ensure .volatile() helper exists on Schemastery schema prototype
try {
  const schemaProto = Object.getPrototypeOf(z.boolean())
  if (schemaProto && typeof schemaProto.volatile !== 'function') {
    schemaProto.volatile = function () {
      return typeof this.extra === 'function' ? this.extra('volatile', true) : this
    }
  }
} catch {
  // safe fallback
}

export const Config = z.object(Object.fromEntries(
  Object.entries(CONFIG_DEFAULTS).map(([field, fallback]) => {
    // Node type derived from default value type.
    let node = typeof fallback === 'number' ? z.number()
      : typeof fallback === 'boolean' ? z.boolean()
        : z.string()
    if (field === 'giteaTokenRef' || field === 'webhookSecretRef' || field === 'githubTokenRef' || field === 'githubWebhookSecretRef') {
      node = node.role('credential-ref')
    }
    const described = node.default(fallback).description(CONFIG_HINTS[field] ?? '')
    return [field, typeof described.volatile === 'function' ? described.volatile() : described]
  }),
))

/** Storage directory path resolved from environment variable or user home directory. */
export function storeDir() {
  return process.env.DSH_KANBAN_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'kanban')
}

function writeJson(res, code, body) {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  } catch { /* socket closed */ }
}

/** Handler response helper: either an error object or success payload. */
function reply(res, out) {
  if (out && typeof out === 'object' && typeof out.error === 'string') {
    writeJson(res, out.status ?? 400, { error: out.error })
    return
  }
  writeJson(res, 200, out)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch { reject(Object.assign(new Error('Malformed JSON payload'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/**
 * Read raw request body bytes.
 * Webhook signatures are computed over delivery byte buffers; parsing and re-serializing
 * could alter byte sequences and fail signature verification.
 */
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function urlOf(req) {
  return new URL(req.url ?? '/', 'http://localhost')
}

export function apply(ctx, config) {
  let effective = withDefaults(config)
  const getConfig = () => effective

  // Settings control live subscriptions: sync intervals and agent tools.
  // Dynamic watcher re-evaluates configurations on change without requiring restart.
  const rearmers = new Set()
  const rearm = () => {
    for (const again of rearmers) {
      try { again() } catch (error) { ctx.logger?.warn?.(`dsh-kanban: rearm failed: ${error?.message}`) }
    }
  }

  let settingsSvc = null

  const readServedConfig = () => {
    if (typeof settingsSvc?.describe !== 'function') return null
    try {
      const row = settingsSvc.describe().find((r) => r?.ns === SETTINGS_NAMESPACE)
      if (!row || row.status !== 'ready' || !row.value) return null
      return withDefaults(row.value)
    } catch (err) {
      ctx.logger?.warn?.(`dsh-kanban: settings describe failed: ${err?.message || err}`)
      return null
    }
  }

  ctx.inject(['settings'], (sctx) => {
    try {
      settingsSvc = sctx?.settings ?? sctx?.get?.('settings') ?? null
      const served = readServedConfig()
      if (served) {
        effective = served
        rearm()
      }
    } catch (err) {
      ctx.logger?.warn?.(`dsh-kanban: settings service unavailable: ${err?.message || err}`)
    }
  })

  // Listen for config and volatile updates from host
  if (typeof ctx?.on === 'function') {
    const applyPatch = (updated) => {
      if (updated && typeof updated === 'object') {
        const incoming = updated[SETTINGS_NAMESPACE] ?? updated
        if (incoming && typeof incoming === 'object') {
          try {
            effective = withDefaults({ ...effective, ...incoming })
            rearm()
          } catch { /* ignore invalid update */ }
        }
      }
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => ctx.on('loader/volatile-update', applyPatch))
      ctx.effect(() => ctx.on('config', applyPatch))
      ctx.effect(() => ctx.on('settings/document-updated', applyPatch))
    } else {
      ctx.on('loader/volatile-update', applyPatch)
      ctx.on('config', applyPatch)
      ctx.on('settings/document-updated', applyPatch)
    }
  }

  // Dedicated Gitea client resolves token via core credentials service.
  // Secret token values are never exposed externally; only the credential reference name is stored.
  const resolveSecret = async (name) => {
    if (typeof name !== 'string' || name.trim() === '') return ''
    try {
      const resolved = await ctx.credentials.resolve(credentialRef(name.trim()))
      return resolved?.value ?? ''
    } catch {
      return ''
    }
  }

  const gitea = createGiteaClient({
    getConfig,
    resolveToken: resolveSecret,
  })

  const github = createGitHubClient({
    getConfig,
    resolveToken: resolveSecret,
  })

  const git = createGitProvider({
    gitea,
    github,
    getConfig,
  })

  // Database store opens once and is closed on effect disposal.
  let store
  const taskService = createKanbanTaskService({ getStore: () => store })
  if (typeof ctx.provide === 'function') ctx.provide('dshKanban', taskService)
  ctx.effect(() => {
    store = openStore({ dir: config?.storeDir || storeDir() })
    return () => { try { store.close() } catch { /* already closed */ } }
  }, 'dsh-kanban: task store')

  // Cross-platform system sleep inhibitor while tasks are actively running
  const powerInhibitor = new PowerInhibitor({
    platform: process.platform,
    pid: process.pid,
  })

  const workflowBridge = new WorkflowBridge({
    get store() { return store },
    get workflowEngine() { return ctx.get('workflowEngine') },
    get agentPresets() { return ctx.get('agentPresets') },
    get agents() { return ctx.agents },
    git,
    getConfig,
    logger: ctx.logger,
    eventHub,
  })
  const unbindCoreWorkflow = workflowBridge.bindCoreEvents(ctx)
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      unbindCoreWorkflow?.()
    })
  }

  const syncPower = () => {
    try {
      const cfg = getConfig()
      powerInhibitor.setEnabled(cfg.preventIdleSleep === true)
      if (store) {
        const activeCount = store.countInColumn('main', 'in-progress') + store.countInColumn('simple', 'in-progress')
        powerInhibitor.setReasons(activeCount)
      }
    } catch { /* ignore */ }
  }
  rearmers.add(syncPower)
  ctx.effect(() => {
    syncPower()
    return () => { powerInhibitor.destroy() }
  }, 'dsh-kanban: power inhibitor')

  // Inject board instructions into agent system prompt
  let disposePromptSection
  const syncPromptSection = () => {
    if (disposePromptSection) {
      try { disposePromptSection() } catch { /* cleanup best effort */ }
      disposePromptSection = undefined
    }
    const cfg = getConfig()
    const sp = ctx.get('systemPrompt')
    if (cfg.announceToAgent !== false && sp && typeof sp.section === 'function') {
      try {
        disposePromptSection = sp.section({
          name: 'plugin:dsh-kanban',
          order: 200,
          text: 'The dsh-kanban task board is available in the system. When working on tasks, you can move cards using the board_move tool and manage the plan checklist via board_plan. When context is running low or a milestone is reached, output a <<<PROGRESSDUMP\nGoal: ...\nProgress: ...\nNext steps: ...\n>>>PROGRESSDUMP block to hand over to the next session.',
        })
      } catch (err) {
        ctx.logger?.warn?.(`dsh-kanban: failed to register system prompt section: ${err?.message}`)
      }
    }
  }
  rearmers.add(syncPromptSection)
  ctx.effect(() => {
    syncPromptSection()
    return () => { if (disposePromptSection) { try { disposePromptSection() } catch { /* cleanup best effort */ } } }
  }, 'dsh-kanban: system prompt section')

  // Track waiting flags, session outcomes, and progress dump from session events.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      // Auto-sync DSH chat sessions into kanban cards (#225)
      const sessionIdStr = String(session?.id ?? '')
      if (
        getConfig().autoSyncSessions === true &&
        session &&
        !session.isSubagent &&
        session.origin !== 'subagent' &&
        session.parentId === undefined &&
        session.meta?.origin !== 'subagent' &&
        !sessionIdStr.startsWith('kanban-') &&
        !sessionIdStr.startsWith('kanban_')
      ) {
        let existingTask = store?.findTaskBySession?.(sessionIdStr)
        if (!existingTask && (event?.type === 'turn/start' || event?.type === 'session/created' || event?.type === 'input/user' || event?.type === 'message')) {
          const userText = (event?.content?.[0]?.text ?? event?.text ?? '').trim()
          const sessionTitle = session.title || session.name || (userText ? userText.slice(0, 50) : `Dialog ${sessionIdStr.slice(0, 8)}`)
          const createdTask = store.createTask({
            title: sessionTitle,
            body: userText || `Automatically created from chat session ${sessionIdStr}`,
            column: 'in-progress',
            board: 'main',
            sessionId: sessionIdStr,
            labels: ['chat-sync'],
          })
          if (createdTask) {
            existingTask = createdTask
            eventHub.broadcast('task:change', { taskId: createdTask.id, action: 'created' })
          }
        } else if (existingTask) {
          if (event?.type === 'turn/end' || event?.type === 'turn/completed') {
            if (existingTask.column === 'in-progress') {
              store.moveTask(existingTask.id, { column: 'review' })
              eventHub.broadcast('task:change', { taskId: existingTask.id, action: 'moved', toCol: 'review' })
            }
          } else if (event?.type === 'turn/error' || event?.type === 'session/error') {
            if (existingTask.column === 'in-progress') {
              store.moveTask(existingTask.id, { column: 'todo' })
              eventHub.broadcast('task:change', { taskId: existingTask.id, action: 'moved', toCol: 'todo' })
            }
          }
        }
      }

      const text = event?.content?.[0]?.text ?? event?.text ?? ''
      const res = handleSessionEvent({
        store,
        sessionId: String(session?.id ?? ''),
        session,
        type: event?.type,
        text,
        error: event?.error,
      })
      syncPower()
      // Dispatch next queued task when a session completes or fails (#214)
      if (event?.type === 'turn/end' || event?.type === 'turn/completed' || event?.type === 'session/error' || event?.type === 'turn/error') {
        dispatchNextQueuedTask({
          agents: ctx.agents,
          store,
          config: getConfig(),
          mintSessionId: () => SessionId(`kanban-queued-${randomUUID()}`),
          createMessage: createUserMessage,
          logger: ctx.logger,
          permissions: ctx.get('permissionPresets'),
          workspaceRegistry: ctx.get('workspaceRegistry'),
          claimAs: 'queue-dispatcher',
        }).catch(() => {})
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-kanban: session event handler failed: ${error?.message}`)
    }
  }), 'dsh-kanban: session events')

  // Background cron scheduler for scheduled tasks
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

  // Periodic Gitea reconciliation. 0 disables it; overlapping executions are prevented.
  // Outbound push queue to Gitea. Card moves do not block on network; failures retry in background.
  const outbox = createOutbox({ gitea: git, get store() { return store }, logger: ctx.logger })

  const queueOutbound = (taskId, column) => {
    if (getConfig().pushToGitea !== true) return
    const task = store.getTask(taskId)
    if (task === undefined) return
    const ops = planOutbound(task, column, getConfig())
    if (ops.length > 0) outbox.push(taskId, ops)
  }

  /**
   * Default repository owner for short repository names.
   * Inferred from existing board tasks when not explicitly configured.
   */
  let discoveredOwner
  const defaultOwner = async () => {
    const named = String(getConfig().giteaOwner ?? '').trim()
    if (named !== '') return named
    for (const task of store.listWatchable()) {
      if (typeof task.owner === 'string' && task.owner !== '') return task.owner
    }
    if (discoveredOwner !== undefined) return discoveredOwner
    // Fall back to Gitea organization if exactly one is accessible to the token.
    const orgs = await gitea.listOrgs()
    if (orgs.length === 1) { discoveredOwner = orgs[0]; return discoveredOwner }
    return undefined
  }

  // Sync telemetry state visible in board header.
  const syncState = createSyncState()

  let syncing = false
  const runSync = async () => {
    if (syncing) return { skipped: true }
    syncing = true
    syncState.started()
    try {
      // Order of operations: intake new issues first, reconcile active tasks, archive overdue.
      // Inspect final outcome rather than initial state.
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
      // Outbox flushes run in the same cycle to minimize redundant Gitea API calls.
      const pushed = await outbox.flush()
      // Intake errors are reported in sync telemetry to keep failures visible.
      syncState.finished(out.problem === undefined && taken.problem !== undefined
        ? { ...out, problem: taken.problem }
        : out)
      return { ...out, pushed, taken, tidied }
    } catch (error) {
      // Sync failure to start represents missing client or unconfigured credentials.
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

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/project-task',
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (!isTrustedRequest(req)) { writeJson(res, 403, { error: 'cross-site' }); return }
      try {
        const input = await readBody(req)
        reply(res, await createProjectTask({
          gitea: git, store,
          owner: input.owner || await defaultOwner(),
          repo: input.repo, newRepo: input.newRepo,
          title: input.title, body: input.body,
          board: input.board ?? 'main',
        }))
      } catch (error) {
        writeJson(res, error?.status ?? 500, { error: 'bad-request' })
      }
    },
  }), 'dsh-kanban: project task')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/presets',
    // Both services are optional in minimal environments. Empty lists render gracefully.
    handler: async (req, res) => {
      const presets = ctx.get('agentPresets')
      const permissions = ctx.get('permissionPresets')
      let agentPresets = []
      try {
        const rows = presets === undefined ? [] : await presets.list()
        // Filter out invalid presets that would fail session creation.
        agentPresets = rows.filter((row) => row?.broken === undefined).map((row) => ({
          id: row.id, name: row.name || row.id, description: row.description,
        }))
      } catch (error) {
        ctx.logger?.warn?.(`dsh-kanban: agent profiles failed to load: ${error?.message}`)
      }
      let access = []
      let accessDefault = ''
      try {
        if (permissions !== undefined) {
          access = permissions.names.map((name) => permissions.optionOf(name))
          accessDefault = permissions.defaultPreset ?? ''
        }
      } catch (error) {
        ctx.logger?.warn?.(`dsh-kanban: access levels failed to load: ${error?.message}`)
      }
      reply(res, {
        agentPresets,
        agentPresetDefault: presets?.defaultId ?? '',
        access,
        accessDefault,
      })
    },
  }), 'dsh-kanban: agent profiles and auth scopes')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/sessions',
    handler: (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      reply(res, { sessions: liveSessions({ store, agents: ctx.agents }) })
    },
  }), 'dsh-kanban: live sessions')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/batch',
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (!isTrustedRequest(req)) { writeJson(res, 403, { error: 'cross-site' }); return }
      try {
        const input = await readBody(req)
        const ids = Array.isArray(input.ids) ? input.ids : []
        const picked = ids.map((id) => store.getTask(id)).filter((task) => task !== undefined)
        const chosen = resolveModel({
          requested: input,
          fallback: ctx.get('agentDefaultModel')?.currentSelection?.(),
        })
        if (chosen === undefined) { writeJson(res, 400, { error: 'model-required' }); return }
        reply(res, await runBatch({
          agents: ctx.agents, store, tasks: picked, config: getConfig(),
          provider: chosen.provider, model: chosen.model,
          mintSessionId: () => SessionId(`kanban-batch-${randomUUID()}`),
          createMessage: createUserMessage,
          cwdOf: undefined, logger: ctx.logger, text: input.text,
          agentPreset: typeof input.agentPreset === 'string' ? input.agentPreset : undefined,
          permission: typeof input.permission === 'string' ? input.permission : undefined,
          permissions: ctx.get('permissionPresets'),
          claimAs: await whoAmI(),
        }))
      } catch (error) {
        writeJson(res, error?.status ?? 500, { error: 'batch-failed' })
      }
    },
  }), 'dsh-kanban: batch dispatch')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/archive',
    handler: (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      reply(res, listArchive({ store }))
    },
  }), 'dsh-kanban: archive')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/sync',
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (!isTrustedRequest(req)) { writeJson(res, 403, { error: 'cross-site' }); return }
      try {
        writeJson(res, 200, await runSync())
      } catch (error) {
        writeJson(res, 502, { error: 'sync-failed' })
      }
    },
  }), 'dsh-kanban: manual sync')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/webhook',
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      try {
        const raw = await readRaw(req)
        const isGithub = detectWebhookProvider(req.headers) === 'github'
        const secretRef = isGithub
          ? (getConfig().githubWebhookSecretRef || getConfig().webhookSecretRef)
          : getConfig().webhookSecretRef
        const secret = await resolveSecret(secretRef)
        const sig = isGithub ? req.headers['x-hub-signature-256'] : req.headers['x-gitea-signature']
        if (!verifySignature(secret, raw, sig)) {
          writeJson(res, 401, { error: 'bad-signature' })
          return
        }
        let payload
        try { payload = JSON.parse(raw.toString('utf8')) } catch { payload = undefined }
        const target = parseEvent(payload)
        if (target === undefined) { writeJson(res, 202, { ignored: true }); return }

        const activeGit = isGithub ? github : gitea
        const owner = isGithub
          ? (String(getConfig().githubOwner ?? '').trim() || target.owner)
          : await defaultOwner()
        const taken = target.owner === owner || isWatched({
          config: getConfig(), owner: target.owner, defaultOwner: owner, repo: target.repo,
        })
          ? await intakeAll({
            gitea: activeGit, store, config: getConfig(), owner, logger: ctx.logger,
            only: (pair) => pair.owner === target.owner && pair.repo === target.repo,
          })
          : { added: 0, skipped: 0, failed: 0 }

        const out = await syncAll({
          gitea: git, store, logger: ctx.logger,
          only: (t) => t.owner === target.owner && t.repo === target.repo
            && (target.issueNumber === undefined || t.issueNumber === target.issueNumber),
        })
        writeJson(res, 200, { ...out, taken })
      } catch (error) {
        writeJson(res, error?.status ?? 500, { error: 'webhook-failed' })
      }
    },
  }), 'dsh-kanban: gitea webhook')

  // Agent tool definition. Default disabled; workflow skills explicitly enable it.
  ctx.effect(() => {
    let unregister
    const arm = () => {
      const wanted = getConfig().boardToolEnabled === true
      if (wanted === (unregister !== undefined)) return
      if (!wanted) { unregister?.(); unregister = undefined; return }
      unregister = registerBoardTool()
    }

    // Single setting switch controls both board tools.
    const registerBoardTool = () => {
      const off = [
        ctx.tools.register(defineTool(boardMoveDefinition({ store, config: getConfig, eventHub }))),
        ctx.tools.register(defineTool(boardPlanDefinition({ store, eventHub }))),
        ctx.tools.register(defineTool(boardChecklistDefinition({ store, eventHub }))),
        ctx.tools.register(defineTool(boardReportDefinition({ store }))),
        ctx.tools.register(defineTool(boardCommentsDefinition({ store }))),
        ctx.tools.register(defineTool(boardCommentAddDefinition({ store }))),
        ctx.tools.register(defineTool(boardDecomposeDefinition({ store, gitea: git }))),
        ctx.tools.register(defineTool(boardChecklistItemDefinition({ store, eventHub }))),
      ]
      return () => { for (const stop of off) stop?.() }
    }

    arm()
    rearmers.add(arm)
    return () => { rearmers.delete(arm); unregister?.() }
  }, 'dsh-kanban: board tool')

  /**
   * Return active agent state or undefined if session is inactive.
   */
  const liveOf = (sessionId) => ctx.agents.get(sessionId)?.status

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/board',
    handler: (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      const url = urlOf(req)
      reply(res, buildBoard({
        store,
        config: getConfig(),
        board: url.searchParams.get('board') || 'main',
        repo: url.searchParams.get('repo') || undefined,
        liveOf,
        sync: syncState.snapshot(),
        // Resolved project root passed with board payload for session launch modal.
        projectRoot: rootOf(getConfig()),
      }))
    },
  }), 'dsh-kanban: board route')

  // Snapshot endpoint handles both export and import.
  /**
   * Cached identity for Gitea client to avoid redundant API lookups on task claim.
   */
  let knownLogin
  const whoAmI = async () => {
    if (knownLogin !== undefined) return knownLogin
    try {
      knownLogin = await gitea.me()
    } catch (error) {
      knownLogin = ''
    }
    return knownLogin
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/metrics',
    handler: (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      const url = urlOf(req)
      const days = Number(url.searchParams.get('staleDays'))
      reply(res, boardMetrics({
        store,
        board: url.searchParams.get('board') || 'main',
        staleDays: Number.isFinite(days) && days > 0 ? days : 14,
      }))
    },
  }), 'dsh-kanban: board metrics')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/whoami',
    // Empty login indicates unconfigured or unreachable Gitea; client omits "Mine" filter.
    handler: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      reply(res, { login: await whoAmI() })
    },
  }), 'dsh-kanban: whoami')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/export.csv',
    handler: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      const u = urlOf(req)
      const board = u.searchParams.get('board') || 'main'
      const csv = exportTasksCsv({ store, board })
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="kanban-${board}-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      })
      res.end(csv)
    },
  }), 'dsh-kanban: csv export')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/events',
    handler: (req, res) => {
      eventHub.handleSseRequest(req, res, { isTrustedRequest })
    },
  }), 'dsh-kanban: sse events stream')

  // Clean up SSE client connections and heartbeat timer on plugin disposal (#282)
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      eventHub.closeAll()
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/templates',
    handler: (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      const u = new URL(req.url, 'http://localhost')
      const tid = u.searchParams.get('id')
      if (tid) {
        const tmpl = getTemplateById(tid)
        if (!tmpl) { writeJson(res, 404, { error: 'template-not-found' }); return }
        reply(res, { template: tmpl })
        return
      }
      reply(res, { templates: TASK_TEMPLATES })
    },
  }), 'dsh-kanban: task templates')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/snapshot',
    handler: async (req, res) => {
      if (req.method === 'GET') { reply(res, exportBoard({ store })); return }
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (!isTrustedRequest(req)) { writeJson(res, 403, { error: 'cross-site' }); return }
      try {
        const input = await readBody(req)
        const impResult = importBoard({ store, input })
        if (impResult?.imported > 0) {
          eventHub.broadcast('task:change', { action: 'imported', count: impResult.imported })
        }
        reply(res, impResult)
      } catch {
        writeJson(res, 400, { error: 'bad-request' })
      }
    },
  }), 'dsh-kanban: board snapshot')

  ctx.effect(() => ctx.webServer.register({
    // Prefix registered without trailing slash for sub-path routing.
    kind: 'prefix',
    path: '/dsh-kanban/task',
    handler: async (req, res) => {
      const pathname = urlOf(req).pathname

      // Path without ID handles local task creation.
      if (pathname === '/dsh-kanban/task' || pathname === '/dsh-kanban/task/') {
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
        if (!isTrustedRequest(req)) { writeJson(res, 403, { error: 'cross-site' }); return }
        try {
          const resObj = createTask({ store, input: await readBody(req) })
          if (resObj?.task) {
            eventHub.broadcast('task:change', { taskId: resObj.task.id, action: 'created' })
          }
          reply(res, resObj)
        } catch (error) {
          writeJson(res, error?.status ?? 500, { error: 'bad-request' })
        }
        return
      }

      const parsed = parseTaskPath(pathname)
      if (parsed === undefined) { writeJson(res, 404, { error: 'not-found' }); return }
      const { id, action } = parsed

      if (req.method === 'GET' && action === 'log') { reply(res, taskLog({ store, id })); return }
      if (req.method === 'GET' && action === 'body') { reply(res, taskBody({ store, id })); return }

      // Generate start prompt on server for template consistency.
      if (req.method === 'GET' && action === 'message') {
        const task = store.getTask(id)
        if (task === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }
        writeJson(res, 200, { text: buildStartMessage(task, getConfig()) })
        return
      }
      if (!isTrustedRequest(req)) { writeJson(res, 403, { error: 'cross-site' }); return }
      if (req.method === 'DELETE' && action === undefined) {
        const resObj = deleteTask({ store, id })
        if (resObj?.deleted) {
          eventHub.broadcast('task:change', { taskId: id, action: 'deleted' })
        }
        reply(res, resObj)
        return
      }
      // Card fields update: title, body, labels, priority. Priority is board-local.
      if (req.method === 'POST' && action === 'update') {
        try {
          const input = await readBody(req)
          const resObj = updateTask({ store, id, input })
          if (resObj?.task) {
            eventHub.broadcast('task:change', { taskId: id, action: 'updated' })
          }
          reply(res, resObj)
        } catch {
          writeJson(res, 400, { error: 'bad-request' })
        }
        return
      }
      if (req.method === 'POST' && action === 'refresh') {
        reply(res, await refreshTask({ gitea: git, store, id }))
        return
      }
      if (req.method === 'GET' && action === 'workflow-status') {
        const task = store.getTask(id)
        if (task === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }
        const active = workflowBridge.activeRuns.get(id)
        reply(res, {
          active: Boolean(active),
          runId: active?.runId || task.workflowRunId || '',
          role: active?.role || '',
          status: task.workflowStatus || (active ? 'running' : 'idle'),
        })
        return
      }
      if (req.method === 'POST' && action === 'workflow-cancel') {
        try {
          const input = await readBody(req)
          const reason = typeof input?.reason === 'string' ? input.reason : 'cancelled-by-user'
          const result = await workflowBridge.cancelTaskWorkflow(id, reason)
          syncPower()
          reply(res, result)
        } catch (error) {
          writeJson(res, 500, { error: error?.message || 'cancel-failed' })
        }
        return
      }
      if (req.method === 'POST' && (action === 'start' || action === 'workflow-start')) {
        try {
          const input = await readBody(req)
          const task = store.getTask(id)
          if (task === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }
          const picked = resolveModel({
            requested: input,
            fallback: ctx.get('agentDefaultModel')?.currentSelection?.(),
          })
          if (picked.error) { writeJson(res, picked.status, { error: picked.error }); return }

          if (action === 'workflow-start' || input.workflow === true || input.mode === 'workflow') {
            const started = await workflowBridge.startTaskWorkflow({
              task,
              role: typeof input.role === 'string' ? input.role : (typeof input.agentPreset === 'string' ? input.agentPreset : undefined),
              provider: picked.provider,
              model: picked.model,
              mintSessionId: () => SessionId(`kanban-${id}-${randomUUID()}`),
              gitRunner: defaultGitRunner,
              workspaceRegistry: ctx.get('workspaceRegistry'),
              claimAs: await whoAmI(),
              permission: typeof input.permission === 'string' ? input.permission : undefined,
              permissions: ctx.get('permissionPresets'),
              cwdOf: rootOf(getConfig()),
              text: typeof input.text === 'string' ? input.text : undefined,
            })
            syncPower()
            reply(res, started)
            return
          }

          const started = await runTask({
            agents: ctx.agents,
            store,
            task,
            config: getConfig(),
            provider: picked.provider,
            model: picked.model,
            // Mint session ID lazily to avoid dangling IDs on resume.
            mintSessionId: () => SessionId(`kanban-${id}-${randomUUID()}`),
            createMessage: createUserMessage,
            logger: ctx.logger,
            text: typeof input.text === 'string' ? input.text : undefined,
            agentPreset: typeof input.agentPreset === 'string' ? input.agentPreset : undefined,
            permission: typeof input.permission === 'string' ? input.permission : undefined,
            permissions: ctx.get('permissionPresets'),
            workspaceRegistry: ctx.get('workspaceRegistry'),
            claimAs: await whoAmI(),
          })
          syncPower()
          reply(res, started)
        } catch (error) {
          ctx.logger?.warn?.(`dsh-kanban: task launch failed: ${error?.message}`)
          // Explicit permission errors are returned with status and key.
          writeJson(res, error?.status ?? 500, { error: error?.key ?? error?.message ?? 'start-failed' })
        }
        return
      }

      try {
        const input = await readBody(req)
        if (req.method === 'POST' && action === 'move') {
          // Manual move dispatches stop command to agent prior to updating card column.
          const was = store.getTask(id)
          const acted = was !== undefined && input.column !== was.column
            ? dispatchMove({
              agents: ctx.agents, task: was, column: input.column,
              kind: store.boardKind(was.board),
              createMessage: createUserMessage, logger: ctx.logger,
            }).acted
            : undefined
          const out = applyMove({
            store, config: getConfig(), id,
            column: input.column, beforeId: input.beforeId, afterId: input.afterId,
            detail: acted === undefined ? '' : (MOVE_DETAIL[acted] ?? ''),
          })
          if (out?.task !== undefined) {
            eventHub.broadcast('task:change', { taskId: id, action: 'moved', toCol: out.task.column })
            queueOutbound(id, out.task.column)
            if (acted !== undefined) out.command = acted
            if (input.column === 'cleanup' && was?.worktree) {
              const dirty = await checkWorktreeDirty({ worktreePath: was.worktree })
              if (dirty.dirty) {
                out.worktreeWarning = 'worktree-dirty'
                out.dirtyFiles = dirty.files
              }
            }
          }
          reply(res, out)
          return
        }
        if (req.method === 'POST' && action === 'cleanup-worktree') {
          const resObj = await handleCleanupWorktree({
            store, task: store.getTask(id),
            workspaceRegistry: ctx.get('workspaceRegistry'),
            force: input?.force === true,
            cleanupTaskWorktree,
          })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'GET' && action === 'diff') {
          const resObj = await handleTaskDiff({ task: store.getTask(id), getTaskDiff })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'GET' && action === 'commits') {
          const resObj = await handleTaskCommits({ task: store.getTask(id), getTaskCommits })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'merge') {
          const resObj = await handleTaskMerge({
            store, task: store.getTask(id),
            targetBranch: input?.targetBranch,
            workspaceRegistry: ctx.get('workspaceRegistry'),
            mergeTaskWorktree,
          })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'GET' && action === 'worktree-status') {
          const resObj = await handleTaskWorktreeStatus({ task: store.getTask(id), checkWorktreeDirty })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'GET' && action === 'subtasks') {
          const resObj = handleGetSubtasks({ store, task: store.getTask(id) })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'triage') {
          const resObj = await handleTriageTask({ store, gitea: git, task: store.getTask(id), input })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && (action === 'subtask' || action === 'subtasks')) {
          const resObj = await handleCreateSubtask({ store, gitea: git, task: store.getTask(id), input })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'checklist-toggle') {
          const resObj = handleToggleChecklistItem({ store, task: store.getTask(id), input })
          if (resObj?.body?.task) {
            eventHub.broadcast('task:change', { taskId: id, action: 'updated' })
          }
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'pr') {
          const resObj = await handleCreateTaskPr({ store, gitea: git, task: store.getTask(id), input })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'checklist') {
          const resObj = handleTaskChecklist({ store, task: store.getTask(id), input })
          if (resObj?.body?.task) {
            eventHub.broadcast('task:change', { taskId: id, action: 'updated' })
          }
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'report') {
          const resObj = handleTaskReport({ store, task: store.getTask(id), input })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'GET' && action === 'comments') {
          const resObj = handleGetTaskComments({ task: store.getTask(id) })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'comments') {
          const resObj = handleAddTaskComment({ store, task: store.getTask(id), input })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'accept') {
          const resObj = handleAcceptTask({ store, task: store.getTask(id) })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'reject') {
          const resObj = handleRejectTask({ store, task: store.getTask(id), input })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'resume') {
          const task = store.getTask(id)
          if (task === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }
          const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
          const picked = resolveModel({
            requested: { model: input?.model || task.model, provider: input?.provider || task.provider },
            fallback,
          })
          if (picked.error) { reply(res, picked); return }
          const out = await runTask({
            agents: ctx.agents,
            store,
            task,
            config: getConfig(),
            provider: picked.provider,
            model: picked.model,
            mintSessionId: () => SessionId(`kanban-${id}-${randomUUID()}`),
            createMessage: createUserMessage,
            cwdOf: undefined,
            logger: ctx.logger,
            text: typeof input?.text === 'string' ? input.text : undefined,
            agentPreset: input?.agentPreset || task.agentPreset,
            permission: input?.permission || task.permission,
            permissions: ctx.get('permissionPresets'),
            claimAs: await whoAmI(),
            workspaceRegistry: ctx.get('workspaceRegistry'),
            resume: true,
          })
          syncPower()
          reply(res, out)
          return
        }
        if (req.method === 'POST' && action === 'confirm-permission') {
          reply(res, confirmPermission({ store, id }))
          return
        }
        if (req.method === 'POST' && action === 'progress-dump') {
          const resObj = handleProgressDump({ store, task: store.getTask(id), input, formatProgressDump })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'stop') {
          const task = store.getTask(id)
          if (task === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }
          const out = stopWork({ agents: ctx.agents, task, logger: ctx.logger })
          if (out.acted === 'stopped') {
            const latestRun = Array.isArray(task.runs) ? task.runs[0] : undefined
            if (latestRun && !latestRun.endedAt && typeof store.updateTaskRun === 'function') {
              store.updateTaskRun(task.id, latestRun.id, { endedAt: Date.now(), result: 'cancelled' })
            }
            syncPower()
            // Stop event recorded in transition history.
            store.addTransition({
              taskId: task.id, fromCol: task.column, toCol: task.column,
              source: 'manual', detail: STOP_DETAIL.stopped,
            })
          }
          reply(res, out)
          return
        }
        if (req.method === 'POST' && action === 'assign') {
          const was = store.getTask(id)
          if (was === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }
          // Empty login unassigns; 'me' resolves authenticated token identity.
          let login = typeof input.login === 'string' ? input.login.trim() : ''
          if (login === 'me') {
            login = await whoAmI()
            if (login === '') { writeJson(res, 502, { error: 'gitea-unreachable' }); return }
          }
          const out = assignTask({ store, id, login })
          if (out.task !== undefined && config.pushToGitea !== false) {
            // Queue assignment update to outbox for offline resilience.
            outbox.push(id, planAssign(out.task, login))
          }
          reply(res, out)
          return
        }
        if (req.method === 'POST' && action === 'archive') {
          reply(res, setArchived({ store, id, archived: true }))
          return
        }
        if (req.method === 'POST' && action === 'restore') {
          reply(res, setArchived({ store, id, archived: false }))
          return
        }
        if (req.method === 'POST' && action === 'queue') {
          reply(res, await queueTask({
            agents: ctx.agents, store, task: store.getTask(id),
            sessionId: input.sessionId, config: getConfig(),
            createMessage: createUserMessage, text: input.text,
          }))
          return
        }
        if (req.method === 'POST' && action === 'unqueue') {
          reply(res, unqueueTask({ store, task: store.getTask(id) }))
          return
        }
        if (req.method === 'POST' && action === 'note') {
          reply(res, appendNote({ store, id, input }))
          return
        }
        if (req.method === 'PATCH' && action === undefined) {
          reply(res, updateTask({ store, id, input }))
          return
        }
        writeJson(res, 405, { error: 'method-not-allowed' })
      } catch (error) {
        writeJson(res, error?.status ?? 500, { error: 'bad-request' })
      }
    },
  }), 'dsh-kanban: task routes')

  // Check Gitea readiness per request to handle dynamically updated credentials.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/gitea/repos',
    handler: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      const url = urlOf(req)
      reply(res, await searchRepos({ gitea: git, query: url.searchParams.get('q') || '' }))
    },
  }), 'dsh-kanban: repo search')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/gitea/issues',
    handler: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      const url = urlOf(req)
      reply(res, await listImportable({
        gitea: git,
        store,
        owner: url.searchParams.get('owner') || undefined,
        repo: url.searchParams.get('repo') || undefined,
        board: url.searchParams.get('board') || 'main',
      }))
    },
  }), 'dsh-kanban: importable issues')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/import',
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (!isTrustedRequest(req)) { writeJson(res, 403, { error: 'cross-site' }); return }
      try {
        const input = await readBody(req)
        reply(res, await importIssue({
          gitea, store,
          owner: input.owner, repo: input.repo, issueNumber: input.issueNumber,
          board: input.board ?? 'main', column: input.column ?? 'backlog',
        }))
      } catch (error) {
        writeJson(res, error?.status ?? 500, { error: 'bad-request' })
      }
    },
  }), 'dsh-kanban: issue import')

  // Providers returned immediately; models queried on-demand for selected provider.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/models',
    handler: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      const current = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
      const llmService = ctx.get('llm')
      let providers = []
      try {
        providers = ((llmService?.listProviders?.() ?? []).map((p) => ({ id: p.id, name: p.name ?? p.id })))
      } catch { providers = [] }

      const wanted = urlOf(req).searchParams.get('provider') || ''
      if (wanted === '') { writeJson(res, 200, { current, providers, models: [] }); return }

      try {
        const rows = await llmService?.listModels?.(wanted)
        writeJson(res, 200, {
          current, providers,
          models: (rows ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
        })
      } catch {
        // Provider errors return empty model list while preserving selected provider.
        writeJson(res, 200, { current, providers, models: [] })
      }
    },
  }), 'dsh-kanban: providers and models')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-kanban/session',
    handler: (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      const m = /^\/dsh-kanban\/session\/([^/]+)\/task\/?$/.exec(urlOf(req).pathname)
      if (m === null) { writeJson(res, 404, { error: 'not-found' }); return }
      reply(res, taskBySession({ store, sessionId: decodeURIComponent(m[1]), agents: ctx.agents }))
    },
  }), 'dsh-kanban: task route by session')

  ctx.effect(() => registerPluginUpdater(ctx, {
    endpoint: '/api/dsh-kanban/update',
    packageName: '@goodandready/dsh-kanban',
    manifestUrl: new URL('../package.json', import.meta.url),
  }), 'dsh-kanban: plugin updater route')

}

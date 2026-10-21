import { registerPluginUpdater } from './updater.js'
import {
  MAX_BODY_BYTES,
  isTrustedRequest,
  rejectUntrustedRequest,
} from './routes.js'
import { isCostMeterAvailable } from './cost-telemetry.js'
import { createRemoteGitRunner } from './remote-runner.js'
import { createGiteaClient } from './gitea.js'
import { createGitHubClient } from './github.js'
import { createGitProvider } from './git-provider.js'
import { createKanbanTaskService } from './task-service.js'
import { eventHub } from './events.js'
import { openStore } from './store.js'
import { defaultGitRunner } from './worktree.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  COLUMN_ORDER,
  wipLimitField,
  withDefaults,
  CONFIG_DEFAULTS,
  CONFIG_HINTS,
  buildPromptSectionText,
  rootOf,
} from './config.js'

import { registerKanbanServices } from './server/services.js'
import { registerKanbanTimers } from './server/timers.js'
import { createRouteHandlers } from './server/route-handlers.js'
import { createTaskRouteHandler } from './server/task-handler.js'

export { COLUMN_ORDER, buildPromptSectionText, wipLimitField, withDefaults } from './config.js'

/** Stable cordis plugin name (patch identifier). */
export const name = '@goodandready/dsh-kanban'

/**
 * Services are injected where needed. Declaring an unavailable service prevents
 * the plugin from loading entirely.
 */
export const inject = ['settings', 'webServer', 'agents', 'agentDefaultModel', 'credentials', 'llm', 'tools', 'connection']

/** Settings namespace string matching client bundle definition. */
export const SETTINGS_NAMESPACE = 'dsh-kanban'

/**
 * Schema constructed from default values so fields reside in one place.
 * Scalar values only: client config API only writes scalar fields;
 * dictionaries or arrays here would make the settings card uneditable.
 */
export const Config = z.object(Object.fromEntries(
  Object.entries(CONFIG_DEFAULTS).map(([field, fallback]) => {
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
  const getGitRunner = () => createRemoteGitRunner(getConfig(), defaultGitRunner)

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
      if (!row || !row.value || (row.status !== undefined && row.status !== 'ready')) return null
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
    const handleDocumentUpdated = (ns) => {
      if (!ns || ns === SETTINGS_NAMESPACE) {
        const served = readServedConfig()
        if (served) {
          effective = served
          rearm()
        }
      }
    }
    const handleVolatileUpdate = (payload) => {
      const served = readServedConfig()
      if (served) {
        effective = served
        rearm()
        return
      }
      applyPatch(payload)
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => ctx.on('loader/volatile-update', handleVolatileUpdate))
      ctx.effect(() => ctx.on('config', applyPatch))
      ctx.effect(() => ctx.on('settings/document-updated', handleDocumentUpdated))
    } else {
      ctx.on('loader/volatile-update', handleVolatileUpdate)
      ctx.on('config', applyPatch)
      ctx.on('settings/document-updated', handleDocumentUpdated)
    }
  }

  const resolveSecret = async (secretName) => {
    if (typeof secretName !== 'string' || secretName.trim() === '') return ''
    try {
      const resolved = await ctx.credentials.resolve(credentialRef(secretName.trim()))
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

  let store
  const taskService = createKanbanTaskService({ getStore: () => store })
  if (typeof ctx.provide === 'function') ctx.provide('dshKanban', taskService)
  ctx.effect(() => {
    store = openStore({ dir: config?.storeDir || storeDir() })
    return () => { try { store.close() } catch { /* already closed */ } }
  }, 'dsh-kanban: task store')

  let knownLogin
  const whoAmI = async () => {
    if (knownLogin !== undefined) return knownLogin
    try {
      knownLogin = await gitea.me()
    } catch {
      knownLogin = ''
    }
    return knownLogin
  }

  const resolveConnection = () => {
    try {
      if (ctx && typeof ctx.get === 'function') {
        const c = ctx.get('connection')
        if (c) return c
      }
    } catch { /* ignore */ }
    try {
      if (ctx && ctx.connection) {
        return ctx.connection
      }
    } catch { /* ignore */ }
    return undefined
  }

  const routeOptions = () => ({
    get connection() {
      return resolveConnection()
    },
  })

  const isTrusted = (req) => isTrustedRequest(req, routeOptions())
  const rejectUntrusted = (req, res) => rejectUntrustedRequest(req, res, routeOptions())

  const services = registerKanbanServices(ctx, {
    store,
    getConfig,
    eventHub,
    git,
    rearmers,
  })

  const timers = registerKanbanTimers(ctx, {
    store,
    getConfig,
    eventHub,
    syncPower: services.syncPower,
    git,
    gitea,
    github,
    rearmers,
    watchdog: services.watchdog,
  })

  const handlers = createRouteHandlers({
    ctx,
    store,
    getConfig,
    git,
    gitea,
    github,
    getGitRunner,
    eventHub,
    syncState: timers.syncState,
    runSync: timers.runSync,
    liveOf: services.liveOf,
    defaultOwner: timers.defaultOwner,
    whoAmI,
    isCostMeterAvailable,
    resolveSecret,
    isTrusted,
    urlOf,
    writeJson,
    reply,
    readBody,
    readRaw,
    rejectUntrusted,
  })

  const taskHandler = createTaskRouteHandler({
    store,
    getConfig,
    eventHub,
    ctx,
    git,
    gitea,
    getGitRunner,
    syncPower: services.syncPower,
    workflowBridge: services.workflowBridge,
    queueOutbound: timers.queueOutbound,
    watchdog: services.watchdog,
    whoAmI,
    defaultOwner: timers.defaultOwner,
    urlOf,
    writeJson,
    reply,
    readBody,
    rejectUntrusted,
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/project-task',
    handler: handlers.handleProjectTask,
  }), 'dsh-kanban: project task')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/presets',
    handler: handlers.handlePresets,
  }), 'dsh-kanban: agent profiles and auth scopes')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/sessions',
    handler: handlers.handleSessions,
  }), 'dsh-kanban: live sessions')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/batch',
    handler: handlers.handleBatch,
  }), 'dsh-kanban: batch dispatch')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/archive',
    handler: handlers.handleArchive,
  }), 'dsh-kanban: archive')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/sync',
    handler: handlers.handleSync,
  }), 'dsh-kanban: manual sync')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/webhook',
    handler: handlers.handleWebhook,
  }), 'dsh-kanban: gitea webhook')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/board',
    handler: handlers.handleBoard,
  }), 'dsh-kanban: board route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/remote/test',
    handler: handlers.handleRemoteTest,
  }), 'dsh-kanban: remote connection test')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-kanban/remote/test',
    handler: handlers.handleRemoteTest,
  }), 'dsh-kanban: remote connection test alias')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/metrics',
    handler: handlers.handleMetrics,
  }), 'dsh-kanban: board metrics')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/whoami',
    handler: handlers.handleWhoami,
  }), 'dsh-kanban: whoami')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/export.csv',
    handler: handlers.handleExportCsv,
  }), 'dsh-kanban: csv export')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/events',
    handler: handlers.handleEvents,
  }), 'dsh-kanban: sse events stream')

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      eventHub.closeAll()
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/templates',
    handler: handlers.handleTemplates,
  }), 'dsh-kanban: task templates')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/snapshot',
    handler: handlers.handleSnapshot,
  }), 'dsh-kanban: board snapshot')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-kanban/task',
    handler: taskHandler,
  }), 'dsh-kanban: task routes')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/gitea/repos',
    handler: handlers.handleGiteaRepos,
  }), 'dsh-kanban: repo search')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/gitea/issues',
    handler: handlers.handleGiteaIssues,
  }), 'dsh-kanban: importable issues')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/import',
    handler: handlers.handleGiteaImport,
  }), 'dsh-kanban: issue import')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/models',
    handler: handlers.handleModels,
  }), 'dsh-kanban: providers and models')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-kanban/session',
    handler: handlers.handleSessionTask,
  }), 'dsh-kanban: task route by session')

  ctx.effect(() => registerPluginUpdater(ctx, {
    endpoint: '/api/dsh-kanban/update',
    packageName: '@goodandready/dsh-kanban',
    manifestUrl: new URL('../package.json', import.meta.url),
  }), 'dsh-kanban: plugin updater route')
}

import {
  buildBoard,
  boardMetrics,
  listArchive,
  exportBoard,
  importBoard,
  exportTasksCsv,
  taskBySession,
} from '../routes.js'
import { runBatch, resolveModel, liveSessions } from '../launcher.js'
import { listImportable, importIssue, createProjectTask, searchRepos } from '../import.js'
import { shouldRelay, relayRequest, testRemoteServer } from '../remote-relay.js'
import { testRemoteConnection, isRemoteMode } from '../remote-runner.js'
import { rootOf } from '../config.js'
import { TASK_TEMPLATES, getTemplateById } from '../templates.js'
import { verifySignature, detectWebhookProvider, parseEvent } from '../webhook.js'
import { isWatched } from '../intake.js'
import { intakeAll, syncAll } from '../sync.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

export function createRouteHandlers(deps) {
  const {
    ctx,
    store,
    getConfig,
    git,
    gitea,
    github,
    getGitRunner,
    eventHub,
    syncState,
    runSync,
    liveOf,
    defaultOwner,
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
  } = deps

  return {
    async handleProjectTask(req, res) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
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

    async handlePresets(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      const presets = ctx.get('agentPresets')
      const permissions = ctx.get('permissionPresets')
      let agentPresets = []
      try {
        const rows = presets === undefined ? [] : await presets.list()
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

    handleSessions(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      reply(res, { sessions: liveSessions({ store, agents: ctx.agents }) })
    },

    async handleBatch(req, res) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
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

    handleArchive(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      reply(res, listArchive({ store }))
    },

    async handleSync(req, res) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      try {
        writeJson(res, 200, await runSync())
      } catch (error) {
        writeJson(res, 502, { error: 'sync-failed' })
      }
    },

    async handleWebhook(req, res) {
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

    async handleBoard(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      const cfg = getConfig()
      if (shouldRelay(cfg)) {
        const url = urlOf(req)
        const relayRes = await relayRequest({
          config: cfg,
          urlPath: '/dsh-kanban/board' + (url.search || ''),
          method: 'GET',
          headers: req.headers,
        })
        writeJson(res, relayRes.status, relayRes.body)
        return
      }
      const url = urlOf(req)
      reply(res, buildBoard({
        store,
        config: cfg,
        board: url.searchParams.get('board') || 'main',
        repo: url.searchParams.get('repo') || undefined,
        liveOf,
        sync: syncState.snapshot(),
        projectRoot: rootOf(cfg),
        costMeterAvailable: isCostMeterAvailable(ctx),
      }))
    },

    async handleRemoteTest(req, res) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      const cfg = getConfig()
      const sshRes = await testRemoteConnection(cfg)
      const serverRes = cfg.remoteServerUrl ? await testRemoteServer(cfg) : { ok: false, error: 'no-server-url' }
      writeJson(res, 200, {
        remoteMode: isRemoteMode(cfg),
        ssh: sshRes,
        server: serverRes,
      })
    },

    handleMetrics(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      const url = urlOf(req)
      const days = Number(url.searchParams.get('staleDays'))
      reply(res, boardMetrics({
        store,
        board: url.searchParams.get('board') || 'main',
        staleDays: Number.isFinite(days) && days > 0 ? days : 14,
      }))
    },

    async handleWhoami(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      reply(res, { login: await whoAmI() })
    },

    handleExportCsv(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
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

    handleEvents(req, res) {
      eventHub.handleSseRequest(req, res, { isTrustedRequest: isTrusted })
    },

    handleTemplates(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
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

    async handleSnapshot(req, res) {
      if (rejectUntrusted(req, res)) return
      if (req.method === 'GET') { reply(res, exportBoard({ store })); return }
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
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

    async handleGiteaRepos(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      const url = urlOf(req)
      reply(res, await searchRepos({ gitea: git, query: url.searchParams.get('q') || '' }))
    },

    async handleGiteaIssues(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      const url = urlOf(req)
      reply(res, await listImportable({
        gitea: git,
        store,
        owner: url.searchParams.get('owner') || undefined,
        repo: url.searchParams.get('repo') || undefined,
        board: url.searchParams.get('board') || 'main',
      }))
    },

    async handleGiteaImport(req, res) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      try {
        const input = await readBody(req)
        reply(res, await importIssue({
          gitea: git, store,
          owner: input.owner, repo: input.repo, issueNumber: input.issueNumber,
          board: input.board ?? 'main', column: input.column ?? 'backlog',
          forge: input.forge || input.provider,
        }))
      } catch (error) {
        writeJson(res, error?.status ?? 500, { error: 'bad-request' })
      }
    },

    async handleModels(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
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
        writeJson(res, 200, { current, providers, models: [] })
      }
    },

    handleSessionTask(req, res) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (rejectUntrusted(req, res)) return
      const m = /^\/dsh-kanban\/session\/([^/]+)\/task\/?$/.exec(urlOf(req).pathname)
      if (m === null) { writeJson(res, 404, { error: 'not-found' }); return }
      reply(res, taskBySession({ store, sessionId: decodeURIComponent(m[1]), agents: ctx.agents }))
    },
  }
}

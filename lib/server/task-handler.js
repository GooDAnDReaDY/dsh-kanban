import {
  createTask,
  parseTaskPath,
  taskLog,
  taskBody,
  deleteTask,
  updateTask,
  applyMove,
  assignTask,
  confirmPermission,
  appendNote,
  handleAcceptTask,
  handleRejectTask,
  handleTaskChecklist,
  handleGetSubtasks,
  handleCreateSubtask,
  handleTriageTask,
  handleCreateTaskPr,
  handleTaskDiff,
  handleTaskDiscard,
  handleTaskCommits,
  handleTaskMerge,
  handleTaskWorktreeStatus,
  handleCleanupWorktree,
  handleTaskNudge,
  handleProgressDump,
  handleTaskReport,
  handleGetTaskComments,
  handleAddTaskComment,
  handleToggleChecklistItem,
} from '../routes.js'
import { verifyAndRecordGate } from '../verification.js'
import { handleTaskSnapshot, handleTaskRollbackSnapshot } from '../routes.js'
import { createInceptionSnapshot } from '../time-machine.js'
import { runTask, queueTask, unqueueTask, resolveModel, buildStartMessage, PERMISSION_RANKS } from '../launcher.js'
import { dispatchMove, stopWork, MOVE_DETAIL, STOP_DETAIL } from '../commands.js'
import { checkWorktreeDirty } from '../worktree.js'
import { refreshTask } from '../import.js'
import { parseProgressDump, formatProgressDump } from '../progress-dump.js'
import { rootOf } from '../config.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

export function createTaskRouteHandler(deps) {
  const {
    store,
    getConfig,
    eventHub,
    ctx,
    git,
    gitea,
    getGitRunner,
    syncPower,
    workflowBridge,
    queueOutbound,
    whoAmI,
    defaultOwner,
    watchdog,
    urlOf,
    writeJson,
    reply,
    readBody,
    rejectUntrusted,
  } = deps

  return async (req, res) => {
      const pathname = urlOf(req).pathname

      // Path without ID handles local task creation.
      if (pathname === '/dsh-kanban/task' || pathname === '/dsh-kanban/task/') {
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
        if (rejectUntrusted(req, res)) return
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

      if (rejectUntrusted(req, res)) return

      if (req.method === 'GET' && action === 'log') { reply(res, taskLog({ store, id })); return }
      if (req.method === 'GET' && action === 'body') { reply(res, taskBody({ store, id })); return }

      // Generate start prompt on server for template consistency.
      if (req.method === 'GET' && action === 'message') {
        const task = store.getTask(id)
        if (task === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }
        writeJson(res, 200, { text: buildStartMessage(task, getConfig()) })
        return
      }
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
          const was = store.getTask(id)
          if (was === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }

          // Automated Verification Gate (#372): intercept transition to review
          if (input.column === 'review' && was.column !== 'review') {
            const gateResult = await verifyAndRecordGate({
              task: was,
              config: getConfig(),
              store,
              agents: ctx.agents,
              createMessage: createUserMessage,
            })
            if (!gateResult.allowed) {
              writeJson(res, 422, {
                error: 'verification-failed',
                command: gateResult.verification.command,
                exitCode: gateResult.verification.exitCode,
                log: gateResult.verification.logSnippet,
                task: store.getTask(id),
              })
              return
            }
          }

          // Manual move dispatches stop command to agent prior to updating card column.
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
            if (out.task.column === 'in-progress' && was?.column !== 'in-progress') {
              const cfg = getConfig()
              if (cfg?.timeMachineEnabled !== false && cfg?.timeMachineAutoSnapshot !== false) {
                createInceptionSnapshot({
                  ctx,
                  task: out.task,
                  config: cfg,
                  env: process.env,
                  cwdOf: () => rootOf(cfg, () => process.cwd()).path,
                  store,
                  logger: ctx.logger,
                }).catch(() => {})
              }
            }
            if (Array.isArray(out.unblocked) && out.unblocked.length > 0) {
              for (const dep of out.unblocked) {
                eventHub.broadcast('task:change', { taskId: dep.id, action: 'unblocked', task: dep })
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
            gitRunner: getGitRunner(),
            config: getConfig(),
            repoDir: rootOf(getConfig()).path,
            cwdOf: () => rootOf(getConfig()).path,
          })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'discard') {
          const resObj = await handleTaskDiscard({
            task: store.getTask(id),
            file: input?.file,
            discardTaskFile,
            gitRunner: getGitRunner(),
          })
          if (resObj?.body?.success) {
            eventHub.broadcast('task:change', { taskId: id, action: 'discard', file: input?.file })
          }
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && (action === 'nudge' || (input && input.action === 'nudge'))) {
          const resObj = await handleTaskNudge({
            store,
            id,
            prompt: input?.prompt || input?.text,
            agents: ctx.agents,
            createMessage: createUserMessage,
            eventHub,
          })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'GET' && action === 'diff') {
          const resObj = await handleTaskDiff({
            task: store.getTask(id),
            getTaskDiff: (opts) => getTaskDiff({ ...opts, gitRunner: getGitRunner() }),
            getTaskDiffInspector: (opts) => getTaskDiffInspector({ ...opts, gitRunner: getGitRunner() }),
          })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'GET' && action === 'commits') {
          const resObj = await handleTaskCommits({
            task: store.getTask(id),
            getTaskCommits: (opts) => getTaskCommits({ ...opts, gitRunner: getGitRunner() }),
          })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'merge') {
          const resObj = await handleTaskMerge({
            store, task: store.getTask(id),
            targetBranch: input?.targetBranch,
            workspaceRegistry: ctx.get('workspaceRegistry'),
            mergeTaskWorktree,
            gitRunner: getGitRunner(),
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
          if (resObj?.body?.task || resObj?.body?.report) {
            eventHub.broadcast('task:change', { taskId: id, action: 'updated' })
          }
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
          if (resObj?.body?.task || resObj?.status === 200) {
            eventHub.broadcast('task:change', { taskId: id, action: 'updated', task: store.getTask(id) })
          }
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
        if ((req.method === 'GET' || req.method === 'POST') && action === 'snapshot') {
          const cfg = getConfig()
          const resObj = await handleTaskSnapshot({
            ctx, store, id, method: req.method, body: input, config: cfg,
            env: process.env, cwdOf: () => rootOf(cfg, () => process.cwd()).path, logger: ctx.logger,
          })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'rollback-snapshot') {
          const cfg = getConfig()
          const resObj = await handleTaskRollbackSnapshot({
            ctx, store, id, body: input, config: cfg,
            env: process.env, cwdOf: () => rootOf(cfg, () => process.cwd()).path, logger: ctx.logger, eventHub,
          })
          writeJson(res, resObj.status, resObj.body)
          return
        }
        if (req.method === 'POST' && action === 'resume') {
          watchdog?.resumeTask?.({ store, taskId: id, eventHub })
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
          const resObj = setArchived({ store, id, archived: true })
          if (resObj?.task) {
            eventHub.broadcast('task:change', { taskId: id, action: 'archived' })
          }
          reply(res, resObj)
          return
        }
        if (req.method === 'POST' && action === 'restore') {
          const resObj = setArchived({ store, id, archived: false })
          if (resObj?.task) {
            eventHub.broadcast('task:change', { taskId: id, action: 'restored' })
          }
          reply(res, resObj)
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
          const out = appendNote({ store, id, input })
          if (out?.task || out?.text) {
            eventHub.broadcast('task:change', { taskId: id, action: 'updated', task: store.getTask(id) })
          }
          reply(res, out)
          return
        }
        if (req.method === 'PATCH' && (action === undefined || action === '')) {
          const resObj = updateTask({ store, id, input })
          if (resObj?.task) {
            eventHub.broadcast('task:change', { taskId: id, action: 'updated' })
          }
          reply(res, resObj)
          return
        }
        writeJson(res, 405, { error: 'method-not-allowed' })
      } catch (error) {
        writeJson(res, error?.status ?? 500, { error: 'bad-request' })
      }
  }
}

import { PowerInhibitor } from '../power.js'
import { createWatchdogService } from '../watchdog.js'
import { WorkflowBridge } from '../workflow-bridge.js'
import { buildPromptSectionText } from '../config.js'
import { handleSessionEvent } from '../lifecycle.js'
import { dispatchNextQueuedTask } from '../launcher.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  boardMoveDefinition,
  boardPlanDefinition,
  boardChecklistDefinition,
  boardReportDefinition,
  boardCommentsDefinition,
  boardCommentAddDefinition,
  boardDecomposeDefinition,
  boardChecklistItemDefinition,
} from '../board-tool.js'

export function registerKanbanServices(ctx, deps) {
  const {
    store,
    getConfig,
    eventHub,
    git,
    rearmers,
  } = deps

  const watchdog = createWatchdogService()

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

  let disposePromptSection
  const syncPromptSection = () => {
    if (disposePromptSection) {
      try { disposePromptSection() } catch { /* cleanup best effort */ }
      disposePromptSection = undefined
    }
    const cfg = getConfig()
    const sp = ctx.get('systemPrompt')
    const promptText = buildPromptSectionText(cfg)
    if (promptText && sp && typeof sp.section === 'function') {
      try {
        disposePromptSection = sp.section({
          name: 'plugin:dsh-kanban',
          order: 200,
          text: promptText,
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

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
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
      if (existingTask) {
        if (event?.type === 'tool/error' || event?.type === 'turn/error' || event?.type === 'session/error') {
          watchdog.recordError(existingTask.id, event.error || text)
        } else {
          watchdog.recordActivity(existingTask.id, event?.type)
          if (event?.type === 'tool/result' || event?.type === 'turn/completed' || event?.type === 'turn/end') {
            watchdog.clearError(existingTask.id)
          }
        }
      }
      handleSessionEvent({
        store,
        sessionId: String(session?.id ?? ''),
        session,
        type: event?.type,
        text,
        error: event?.error,
      })
      syncPower()
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

  ctx.effect(() => {
    let unregister
    const arm = () => {
      const wanted = getConfig().boardToolEnabled === true
      if (wanted === (unregister !== undefined)) return
      if (!wanted) { unregister?.(); unregister = undefined; return }
      unregister = registerBoardTool()
    }

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

  const liveOf = (sessionId) => {
    try {
      const a = ctx.agents?.get?.(sessionId)
      if (!a) return undefined
      return {
        status: a.status || (typeof a.isIdle === 'function' && a.isIdle() ? 'idle' : 'running'),
        state: a.state || a.lifecycleState,
        step: a.step || a.currentStep || a.stateDetail || a.activity || '',
        activity: a.activity || a.statusDetail || '',
      }
    } catch {
      return undefined
    }
  }

  return { powerInhibitor, syncPower, workflowBridge, liveOf, watchdog }
}

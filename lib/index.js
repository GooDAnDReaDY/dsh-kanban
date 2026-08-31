// dsh-kanban — доска задач для DeepSeek Harness.
//
// Плагин состоит из двух половин: этот модуль — серверная, `lib/client.js` —
// браузерная. Имя пакета `@goodandready-private/dsh-kanban` обязано совпадать в трёх
// местах: `package.json`, `cordis.patch.yml` и `load({ id })` в client.js.
// Расхождение НЕ даёт ошибки в журнале — интерфейс просто не появляется.
//
// Чистая логика вынесена в модули без зависимостей (`config.js`, `order.js`,
// `routes.js`) и проверяется тестами без харнесса. Здесь остаётся обвязка
// cordis: настройки, хранилище и маршруты.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CONFIG_DEFAULTS, CONFIG_HINTS, withDefaults, rootOf } from './config.js'
import { openStore } from './store.js'
import {
  MAX_BODY_BYTES, isTrustedRequest, parseTaskPath,
  buildBoard, applyMove, createTask, updateTask, deleteTask, appendNote, setArchived, listArchive,
  taskBody,
  taskLog, taskBySession,
} from './routes.js'
import { listImportable, importIssue, refreshTask, searchRepos, createProjectTask } from './import.js'
import {
  runTask, resolveModel, buildStartMessage,
  runBatch, queueTask, unqueueTask, liveSessions,
} from './launcher.js'
import { dispatchMove, MOVE_DETAIL, stopWork, STOP_DETAIL } from './commands.js'
import { createGiteaClient } from './gitea.js'
import { syncAll, createSyncState, intakeAll, archiveOverdue } from './sync.js'
import { isWatched } from './intake.js'
import { handleSessionEvent } from './lifecycle.js'
import { boardMoveDefinition, boardPlanDefinition } from './board-tool.js'
import { verifySignature, parseEvent } from './webhook.js'
import { planOutbound, createOutbox } from './outbound.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export { COLUMN_ORDER, wipLimitField, withDefaults } from './config.js'

/** Стабильное имя плагина cordis (строка в патче сборки). */
export const name = 'dsh-kanban'

/**
 * Службы добавляются там, где впервые нужны: `gitea` — вместе с импортом
 * задач, `agents`/`sessions` — вместе с запуском работы. Объявленная, но
 * отсутствующая служба не даёт плагину загрузиться вовсе.
 */
export const inject = ['settings', 'webServer', 'agents', 'agentDefaultModel', 'credentials', 'llm', 'tools']

/** Пространство настроек; то же имя продублировано в браузерной половине. */
// Пространство настроек — просто строка.
//
// В 0.1.1 ядро отдавало помощника `settingsNamespace`, который проверял имя по
// образцу и возвращал ту же строку с типом-меткой. В 0.1.2-alpha.2 помощника
// убрали, и импорт его роняет ЗАГРУЗКУ ВСЕГО ПРОФИЛЯ, а не один плагин.
// Проверять здесь нечего: имя — постоянная этого файла, а не пользовательский
// ввод. На обеих версиях ядра значение одно и то же.
export const SETTINGS_NAMESPACE = 'dsh-kanban'

/**
 * Схема собирается из значений по умолчанию, чтобы список полей жил в одном
 * месте. Только скаляры: клиентский API настроек пишет ТОЛЬКО скалярные поля,
 * и словарь или массив здесь сделал бы карточку нередактируемой.
 */
export const Config = z.object(Object.fromEntries(
  Object.entries(CONFIG_DEFAULTS).map(([field, fallback]) => {
    // Узел схемы выбирается по типу умолчания. Пропустить здесь булево значит
    // объявить его строкой — и плагин не загрузится вовсе с «invalid config».
    const node = typeof fallback === 'number' ? z.number()
      : typeof fallback === 'boolean' ? z.boolean()
        : z.string()
    return [field, node.default(fallback).description(CONFIG_HINTS[field] ?? '')]
  }),
))

/** Каталог хранилища. Абсолютных путей в коде нет — только переменная и дом. */
export function storeDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'kanban')
}

function writeJson(res, code, body) {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  } catch { /* сокет закрыт */ }
}

/** Ответ обработчика: либо объект с `error` и `status`, либо полезная нагрузка. */
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
        reject(Object.assign(new Error('тело запроса слишком велико'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch { reject(Object.assign(new Error('тело запроса не JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/**
 * Сырое тело запроса.
 *
 * Подпись вебхука считается по БАЙТАМ доставки. Разобрать JSON и собрать его
 * обратно — значит получить другую последовательность байт и не сойтись в
 * подписи на пустом месте.
 */
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('тело запроса слишком велико'), { status: 413 }))
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

  // Часть настроек управляет живыми подписками: промежутком сверки и наличием
  // инструмента у агента. Прочитать их один раз при загрузке — значит сделать
  // переключатель в карточке настроек безответным до перезапуска харнесса.
  const rearmers = new Set()
  const rearm = () => {
    for (const again of rearmers) {
      try { again() } catch (error) { ctx.logger?.warn?.(`dsh-kanban: перевзвод не удался: ${error?.message}`) }
    }
  }

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: effective })
    const read = () => withDefaults(scope.get() ?? effective)
    effective = read()
    ctx.effect(() => scope.watch(() => { effective = read(); rearm() }), 'dsh-kanban: слежение за настройками')
  })

  // Клиент Gitea свой: токен всё равно живёт в службе учётных данных ядра, а
  // шесть вызовов REST дешевле зависимости от чужого выпуска. Значение токена
  // наружу не отдаётся — в настройках только ИМЯ учётной записи.
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

  // Хранилище открывается один раз и закрывается уборщиком того же эффекта:
  // выгрузка плагина обязана отпустить файл базы.
  let store
  ctx.effect(() => {
    store = openStore({ dir: storeDir() })
    return () => { try { store.close() } catch { /* уже закрыта */ } }
  }, 'dsh-kanban: хранилище задач')

  // Признак ожидания по событиям сессии. Задача ищется по идентификатору
  // сессии; сессий не с доски большинство, и для них здесь ничего не
  // происходит — это штатный ход, а не пропуск.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      handleSessionEvent({ store, sessionId: String(session?.id ?? ''), type: event?.type })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-kanban: событие сессии не обработано: ${error?.message}`)
    }
  }), 'dsh-kanban: события сессии')

  // Периодическая сверка с Gitea. Ноль в настройках отключает её целиком, а
  // перекрытие запусков не допускается: медленный инстанс иначе копил бы
  // очередь сверок вместо одной идущей.
  // Очередь отправки в Gitea. Перенос карточки не ждёт сети: доска обязана
  // работать и при недоступном Gitea, а неудачная отправка повторяется и, если
  // так и не удалась, попадает в журнал задачи.
  const outbox = createOutbox({ gitea, store, logger: ctx.logger })

  const queueOutbound = (taskId, column) => {
    if (getConfig().pushToGitea !== true) return
    const task = store.getTask(taskId)
    if (task === undefined) return
    const ops = planOutbound(task, column, getConfig())
    if (ops.length > 0) outbox.push(taskId, ops)
  }

  /**
   * Владелец для коротких имён в списке отслеживаемых репозиториев.
   *
   * Берётся из задач, уже лежащих на доске: другого источника у плагина нет,
   * а спрашивать владельца отдельной настройкой значит просить дважды одно и
   * то же.
   */
  let discoveredOwner
  const defaultOwner = async () => {
    const named = String(getConfig().giteaOwner ?? '').trim()
    if (named !== '') return named
    for (const task of store.listWatchable()) {
      if (typeof task.owner === 'string' && task.owner !== '') return task.owner
    }
    if (discoveredOwner !== undefined) return discoveredOwner
    // Спрашиваем у Gitea, и только когда организация ровно одна: при
    // нескольких гадание молча смотрело бы не туда, а это хуже отказа.
    const orgs = await gitea.listOrgs()
    if (orgs.length === 1) { discoveredOwner = orgs[0]; return discoveredOwner }
    return undefined
  }

  // Состояние сверки видно человеку в шапке доски: доска, переставшая
  // обновляться, не имеет права молчать об этом.
  const syncState = createSyncState()

  let syncing = false
  const runSync = async () => {
    if (syncing) return { skipped: true }
    syncing = true
    syncState.started()
    try {
      // Порядок важен. Сперва забираем новое: свежая задача должна попасть на
      // доску и тут же быть сверена, а не ждать следующего прохода. Архивация
      // последней — она смотрит на итог, а не на исходное.
      const taken = await intakeAll({
        gitea, store, config: getConfig(), owner: await defaultOwner(), logger: ctx.logger,
      })
      const out = await syncAll({ gitea, store, logger: ctx.logger })
      const tidied = archiveOverdue({ store, config: getConfig() })
      // Отложенные отправки уходят той же волной: отдельный таймер ради них
      // означал бы второй источник обращений к Gitea без всякой пользы.
      const pushed = await outbox.flush()
      // Беда подхвата — такая же слепота доски, как беда сверки: задачи не
      // приезжают, а человеку об этом никто не говорит.
      syncState.finished(out.problem === undefined && taken.problem !== undefined
        ? { ...out, problem: taken.problem }
        : out)
      return { ...out, pushed, taken, tidied }
    } catch (error) {
      // Сверка не начиналась вовсе — тоже беда, и своя: так выглядит
      // неразрешённый токен или отсутствующий клиент Gitea.
      syncState.failedToStart('сверка', error?.message)
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
  }, 'dsh-kanban: таймер сверки')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/project-task',
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      if (!isTrustedRequest(req)) { writeJson(res, 403, { error: 'cross-site' }); return }
      try {
        const input = await readBody(req)
        reply(res, await createProjectTask({
          gitea, store,
          owner: input.owner || await defaultOwner(),
          repo: input.repo, newRepo: input.newRepo,
          title: input.title, body: input.body,
          board: input.board ?? 'main',
        }))
      } catch (error) {
        writeJson(res, error?.status ?? 500, { error: 'bad-request' })
      }
    },
  }), 'dsh-kanban: проектная задача')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/presets',
    // Обе службы необязательны: развёртывание может не собирать ни профили,
    // ни уровни доступа. Пустой список — не поломка, а «выбирать не из чего»,
    // и браузер просто не рисует поле.
    handler: async (req, res) => {
      const presets = ctx.get('agentPresets')
      const permissions = ctx.get('permissionPresets')
      let agentPresets = []
      try {
        const rows = presets === undefined ? [] : await presets.list()
        // Сломанный профиль остаётся в списке ядра, но выбрать его нельзя:
        // сессия на нём не соберётся, а отказ прилетит уже после запуска.
        agentPresets = rows.filter((row) => row?.broken === undefined).map((row) => ({
          id: row.id, name: row.name || row.id, description: row.description,
        }))
      } catch (error) {
        ctx.logger?.warn?.(`dsh-kanban: профили агента не прочитались: ${error?.message}`)
      }
      let access = []
      let accessDefault = ''
      try {
        if (permissions !== undefined) {
          access = permissions.names.map((name) => permissions.optionOf(name))
          accessDefault = permissions.defaultPreset ?? ''
        }
      } catch (error) {
        ctx.logger?.warn?.(`dsh-kanban: уровни доступа не прочитались: ${error?.message}`)
      }
      reply(res, {
        agentPresets,
        agentPresetDefault: presets?.defaultId ?? '',
        access,
        accessDefault,
      })
    },
  }), 'dsh-kanban: профили агента и уровни доступа')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/sessions',
    handler: (req, res) => { reply(res, { sessions: liveSessions({ store, agents: ctx.agents }) }) },
  }), 'dsh-kanban: живые сессии')

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
        }))
      } catch (error) {
        writeJson(res, error?.status ?? 500, { error: 'batch-failed' })
      }
    },
  }), 'dsh-kanban: групповой запуск')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/archive',
    handler: (req, res) => { reply(res, listArchive({ store })) },
  }), 'dsh-kanban: архив')

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
  }), 'dsh-kanban: ручная сверка')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/webhook',
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
      try {
        const raw = await readRaw(req)
        const secret = await resolveSecret(getConfig().webhookSecretRef)
        // Без секрета вебхук не принимается вовсе: иначе карточки двигал бы
        // кто угодно снаружи.
        if (!verifySignature(secret, raw, req.headers['x-gitea-signature'])) {
          writeJson(res, 401, { error: 'bad-signature' })
          return
        }
        let payload
        try { payload = JSON.parse(raw.toString('utf8')) } catch { payload = undefined }
        const target = parseEvent(payload)
        if (target === undefined) { writeJson(res, 202, { ignored: true }); return }

        // Сперва подхват, потом сверка — тот же порядок, что и по таймеру:
        // новый issue должен стать карточкой и тут же быть сверен. Без этого
        // он ждал бы таймера, хотя вебхук про него уже знает, а вебхук мы и
        // заводили ради двух секунд вместо ста двадцати.
        //
        // Только по репозиторию события: полный обход при каждом чихе в любом
        // из отслеживаемых означал бы обращение ко всем.
        // Событие всегда называет свой репозиторий, и владельца выяснять не
        // надо: подхватываем его напрямую, если он вообще под наблюдением.
        const owner = await defaultOwner()
        const taken = target.owner === owner || isWatched({
          config: getConfig(), owner: target.owner, defaultOwner: owner, repo: target.repo,
        })
          ? await intakeAll({
            gitea, store, config: getConfig(), owner: await defaultOwner(), logger: ctx.logger,
            only: (pair) => pair.owner === target.owner && pair.repo === target.repo,
          })
          : { added: 0, skipped: 0, failed: 0 }

        // Вебхук говорит «здесь что-то произошло», а решает сверка: у неё перед
        // глазами полная картина, а у события — только его кусок.
        const out = await syncAll({
          gitea, store, logger: ctx.logger,
          only: (t) => t.owner === target.owner && t.repo === target.repo
            && (target.issueNumber === undefined || t.issueNumber === target.issueNumber),
        })
        writeJson(res, 200, { ...out, taken })
      } catch (error) {
        writeJson(res, error?.status ?? 500, { error: 'webhook-failed' })
      }
    },
  }), 'dsh-kanban: вебхук Gitea')

  // Инструмент для агента. По умолчанию ВЫКЛЮЧЕН: скилл воркфлоу пока
  // запрещает этому CLI трогать канбан, и включить инструмент раньше правки
  // скилла — значит толкать агента на нарушение.
  ctx.effect(() => {
    let unregister
    const arm = () => {
      const wanted = getConfig().boardToolEnabled === true
      if (wanted === (unregister !== undefined)) return
      if (!wanted) { unregister?.(); unregister = undefined; return }
      unregister = registerBoardTool()
    }

    // Один выключатель на оба инструмента доски: разделять их значило бы
    // множить настройки ради разницы, которой человек не почувствует.
    const registerBoardTool = () => {
      const off = [
        ctx.tools.register(defineTool(boardMoveDefinition({ store }))),
        ctx.tools.register(defineTool(boardPlanDefinition({ store }))),
      ]
      return () => { for (const stop of off) stop?.() }
    }

    arm()
    rearmers.add(arm)
    return () => { rearmers.delete(arm); unregister?.() }
  }, 'dsh-kanban: инструмент доски')

  /**
   * Состояние живого агента сессии либо `undefined`, если агента нет.
   * Отказ реестра на незнакомый идентификатор ловит сборка доски.
   */
  const liveOf = (sessionId) => ctx.agents.get(sessionId)?.status

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/board',
    handler: (req, res) => {
      const url = urlOf(req)
      reply(res, buildBoard({
        store,
        config: getConfig(),
        board: url.searchParams.get('board') || 'main',
        repo: url.searchParams.get('repo') || undefined,
        liveOf,
        sync: syncState.snapshot(),
        // Фактический корень проектов едет с доской: браузер показывает его в
        // окне запуска, когда человек не задал корень настройкой, — иначе
        // сессия молча поднимается в рабочей папке харнесса.
        projectRoot: rootOf(getConfig()),
      }))
    },
  }), 'dsh-kanban: маршрут доски')

  ctx.effect(() => ctx.webServer.register({
    // Префикс регистрируется БЕЗ завершающего слэша: со слэшем сопоставление
    // сводится к равенству пути, и всё, что глубже, уходит в статику.
    kind: 'prefix',
    path: '/dsh-kanban/task',
    handler: async (req, res) => {
      const pathname = urlOf(req).pathname

      // Сам путь без идентификатора — создание своей задачи.
      if (pathname === '/dsh-kanban/task' || pathname === '/dsh-kanban/task/') {
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'method-not-allowed' }); return }
        if (!isTrustedRequest(req)) { writeJson(res, 403, { error: 'cross-site' }); return }
        try {
          reply(res, createTask({ store, input: await readBody(req) }))
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

      // Заготовку сообщения отдаём отсюда, а не собираем второй раз в браузере:
      // иначе шаблон окажется в двух местах и однажды разойдётся.
      if (req.method === 'GET' && action === 'message') {
        const task = store.getTask(id)
        if (task === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }
        writeJson(res, 200, { text: buildStartMessage(task, getConfig()) })
        return
      }
      if (!isTrustedRequest(req)) { writeJson(res, 403, { error: 'cross-site' }); return }
      if (req.method === 'DELETE' && action === undefined) { reply(res, deleteTask({ store, id })); return }
      if (req.method === 'POST' && action === 'refresh') {
        reply(res, await refreshTask({ gitea, store, id }))
        return
      }
      if (req.method === 'POST' && action === 'start') {
        try {
          const input = await readBody(req)
          const task = store.getTask(id)
          if (task === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }
          const picked = resolveModel({
            requested: input,
            fallback: ctx.get('agentDefaultModel')?.currentSelection?.(),
          })
          if (picked.error) { writeJson(res, picked.status, { error: picked.error }); return }
          reply(res, await runTask({
            agents: ctx.agents,
            store,
            task,
            config: getConfig(),
            provider: picked.provider,
            model: picked.model,
            // Идентификатор мнётся ЛЕНИВО: при продолжении новая сессия не
            // поднимается вовсе, и заранее занятое имя осталось бы висеть.
            mintSessionId: () => SessionId(`kanban-${id}-${randomUUID()}`),
            createMessage: createUserMessage,
            logger: ctx.logger,
            text: typeof input.text === 'string' ? input.text : undefined,
            agentPreset: typeof input.agentPreset === 'string' ? input.agentPreset : undefined,
            permission: typeof input.permission === 'string' ? input.permission : undefined,
            permissions: ctx.get('permissionPresets'),
          }))
        } catch (error) {
          ctx.logger?.warn?.(`dsh-kanban: запуск задачи не удался: ${error?.message}`)
          // Отказ по уровню доступа называется своим именем: «не удалось» на
          // месте «сессия пошла бы с большими правами» — это молчание.
          writeJson(res, error?.status ?? 500, { error: error?.key ?? 'start-failed' })
        }
        return
      }

      try {
        const input = await readBody(req)
        if (req.method === 'POST' && action === 'move') {
          // Ручной перенос — КОМАНДА агенту, а не запись о состоянии.
          // Автоматика (сверка, инструмент, жизненный цикл) сюда не приходит:
          // она двигает карточку мимо этого маршрута.
          //
          // Команду отдаём ДО переноса: остановка должна случиться раньше, чем
          // доска объявит работу прекращённой, а её исход становится
          // пояснением к единственному переходу в журнале.
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
            queueOutbound(id, out.task.column)
            if (acted !== undefined) out.command = acted
          }
          reply(res, out)
          return
        }
        if (req.method === 'POST' && action === 'stop') {
          const task = store.getTask(id)
          if (task === undefined) { writeJson(res, 404, { error: 'task-not-found' }); return }
          const out = stopWork({ agents: ctx.agents, task, logger: ctx.logger })
          if (out.acted === 'stopped') {
            // Остановка — событие, и в журнале ей место наравне с переносом:
            // иначе прерванная работа выглядит просто оборвавшейся сама.
            store.addTransition({
              taskId: task.id, fromCol: task.column, toCol: task.column,
              source: 'manual', detail: STOP_DETAIL.stopped,
            })
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
  }), 'dsh-kanban: маршруты задачи')

  // Готовность Gitea проверяется на каждом запросе, а не при загрузке: адрес и
  // учётная запись правятся в карточке настроек на ходу, и маршруты обязаны
  // внятно объяснять причину, а не отвечать 404.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/gitea/repos',
    handler: async (req, res) => {
      const url = urlOf(req)
      reply(res, await searchRepos({ gitea, query: url.searchParams.get('q') || '' }))
    },
  }), 'dsh-kanban: поиск репозиториев')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/gitea/issues',
    handler: async (req, res) => {
      const url = urlOf(req)
      reply(res, await listImportable({
        gitea,
        store,
        owner: url.searchParams.get('owner') || undefined,
        repo: url.searchParams.get('repo') || undefined,
        board: url.searchParams.get('board') || 'main',
      }))
    },
  }), 'dsh-kanban: список issue для импорта')

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
  }), 'dsh-kanban: импорт issue')

  // Провайдеры отдаются сразу, модели — только для запрошенного провайдера:
  // перечень моделей провайдер отдаёт по сети, и опрашивать все разом ради
  // одного выпадающего списка незачем.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/models',
    handler: async (req, res) => {
      const current = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
      let providers = []
      try {
        providers = (ctx.llm.listProviders() ?? []).map((p) => ({ id: p.id, name: p.name ?? p.id }))
      } catch { providers = [] }

      const wanted = urlOf(req).searchParams.get('provider') || ''
      if (wanted === '') { writeJson(res, 200, { current, providers, models: [] }); return }

      try {
        const rows = await ctx.llm.listModels(wanted)
        writeJson(res, 200, {
          current, providers,
          models: (rows ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
        })
      } catch {
        // Провайдер может быть не настроен или недоступен: это не поломка
        // доски, а пустой список с сохранённым выбором провайдера.
        writeJson(res, 200, { current, providers, models: [] })
      }
    },
  }), 'dsh-kanban: провайдеры и модели')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-kanban/session',
    handler: (req, res) => {
      const m = /^\/dsh-kanban\/session\/([^/]+)\/task\/?$/.exec(urlOf(req).pathname)
      if (m === null) { writeJson(res, 404, { error: 'not-found' }); return }
      reply(res, taskBySession({ store, sessionId: decodeURIComponent(m[1]) }))
    },
  }), 'dsh-kanban: маршрут задачи по сессии')
}

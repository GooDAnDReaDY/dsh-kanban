// dsh-kanban — доска задач для DeepSeek Harness.
//
// Плагин состоит из двух половин: этот модуль — серверная, `lib/client.js` —
// браузерная. Имя пакета `@goodandready/dsh-kanban` обязано совпадать в трёх
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
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CONFIG_DEFAULTS, CONFIG_HINTS, withDefaults } from './config.js'
import { openStore } from './store.js'
import {
  MAX_BODY_BYTES, isTrustedRequest, parseTaskPath,
  buildBoard, applyMove, createTask, updateTask, deleteTask, taskLog, taskBySession,
} from './routes.js'
import { listImportable, importIssue, refreshTask, searchRepos } from './import.js'
import { startTask, resolveModel } from './launcher.js'
import { createGiteaClient } from './gitea.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export { COLUMN_ORDER, columnLabelField, wipLimitField, withDefaults } from './config.js'

/** Стабильное имя плагина cordis (строка в патче сборки). */
export const name = 'dsh-kanban'

/**
 * Службы добавляются там, где впервые нужны: `gitea` — вместе с импортом
 * задач, `agents`/`sessions` — вместе с запуском работы. Объявленная, но
 * отсутствующая служба не даёт плагину загрузиться вовсе.
 */
export const inject = ['settings', 'webServer', 'agents', 'agentDefaultModel', 'credentials']

/** Пространство настроек; то же имя продублировано в браузерной половине. */
export const SETTINGS_NAMESPACE = settingsNamespace('dsh-kanban')

/**
 * Схема собирается из значений по умолчанию, чтобы список полей жил в одном
 * месте. Только скаляры: клиентский API настроек пишет ТОЛЬКО скалярные поля,
 * и словарь или массив здесь сделал бы карточку нередактируемой.
 */
export const Config = z.object(Object.fromEntries(
  Object.entries(CONFIG_DEFAULTS).map(([field, fallback]) => {
    const node = typeof fallback === 'number' ? z.number() : z.string()
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

function urlOf(req) {
  return new URL(req.url ?? '/', 'http://localhost')
}

export function apply(ctx, config) {
  let effective = withDefaults(config)
  const getConfig = () => effective

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: effective })
    const read = () => withDefaults(scope.get() ?? effective)
    effective = read()
    ctx.effect(() => scope.watch(() => { effective = read() }), 'dsh-kanban: слежение за настройками')
  })

  // Клиент Gitea свой: токен всё равно живёт в службе учётных данных ядра, а
  // шесть вызовов REST дешевле зависимости от чужого выпуска. Значение токена
  // наружу не отдаётся — в настройках только ИМЯ учётной записи.
  const gitea = createGiteaClient({
    getConfig,
    resolveToken: async (name) => {
      try {
        const resolved = await ctx.credentials.resolve(credentialRef(name))
        return resolved?.value ?? ''
      } catch {
        return ''
      }
    },
  })

  // Хранилище открывается один раз и закрывается уборщиком того же эффекта:
  // выгрузка плагина обязана отпустить файл базы.
  let store
  ctx.effect(() => {
    store = openStore({ dir: storeDir() })
    return () => { try { store.close() } catch { /* уже закрыта */ } }
  }, 'dsh-kanban: хранилище задач')

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
          reply(res, await startTask({
            agents: ctx.agents,
            store,
            task,
            config: getConfig(),
            provider: picked.provider,
            model: picked.model,
            sessionId: SessionId(`kanban-${id}-${randomUUID()}`),
            createMessage: createUserMessage,
          }))
        } catch (error) {
          ctx.logger?.warn?.(`dsh-kanban: запуск задачи не удался: ${error?.message}`)
          writeJson(res, error?.status ?? 500, { error: 'start-failed' })
        }
        return
      }

      try {
        const input = await readBody(req)
        if (req.method === 'POST' && action === 'move') {
          reply(res, applyMove({
            store, config: getConfig(), id,
            column: input.column, beforeId: input.beforeId, afterId: input.afterId,
          }))
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

  // Перечня моделей служба ядра не отдаёт — только текущий выбор. Поэтому
  // маршрут возвращает его, а выбрать другую модель можно, указав её явно.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-kanban/models',
    handler: (req, res) => {
      const current = ctx.get('agentDefaultModel')?.currentSelection?.()
      writeJson(res, 200, { current: current ?? null })
    },
  }), 'dsh-kanban: текущая модель')

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

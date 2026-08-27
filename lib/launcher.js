// Запуск работы по задаче: отдельная сессия агента с выбранной моделью.
//
// Плагин НЕ готовит ничего, кроме сессии. Ветку и worktree он не создаёт: по
// воркфлоу агент сначала делает preflight — смотрит открытые ветки и worktree,
// проверяет рабочее дерево — и только потом заводит worktree от свежего
// origin/main. Плагин, создающий ветку заранее, ломает preflight: ветка
// появится до того, как выяснится, что задачу вообще нельзя начинать.
//
// По той же причине плагин не пишет стартовый комментарий в issue. Его пишет
// агент после preflight, потому что до preflight ветка и план неизвестны.
//
// Пакеты ядра здесь не импортируются: идентификатор сессии и сборка сообщения
// приходят параметрами. Так модуль проверяется без харнесса и без сети.

import { isAbsolute, join, resolve } from 'node:path'

/**
 * Хвост своей задачи — УСЛОВИЕ, а не приказ.
 *
 * На доску вешают что угодно: «прибраться в логах», «найди мне вот такую
 * информацию». Распоряжение делать preflight веток и заводить worktree для
 * такой задачи бессмысленно — агент честно уходил искать репозитории и
 * перечислять worktree вместо того, чтобы заняться написанным.
 *
 * Поэтому решает агент по содержанию задачи, а не доска заранее.
 */
const OWN_TAIL = 'Если задача окажется про код проекта — придерживайся его воркфлоу; '
  + 'если нет — просто сделай, что написано выше.'

/** Хвост про воркфлоу — ТОЛЬКО для задач, за которыми стоит issue. */
const WORKFLOW_TAIL = [
  'Работай по действующему воркфлоу проекта: сначала preflight открытых веток и',
  'worktree, затем worktree от свежего origin/main, стартовый комментарий в issue',
  'с планом и проверками, дальше реализация.',
].join('\n')

/**
 * Первое сообщение агенту.
 *
 * Сообщение НЕ содержит указаний создать ветку с конкретным именем: имя ветки
 * выбирает агент после preflight.
 *
 * @param {object} task задача доски
 * @param {object} config настройки плагина
 * @returns {string} текст сообщения
 */
export function buildStartMessage(task, config) {
  const vars = {
    repo: task?.repo ?? '',
    issueNumber: typeof task?.issueNumber === 'number' ? String(task.issueNumber) : '',
    title: task?.title ?? '',
    body: task?.body ?? '',
    issueUrl: task?.issueUrl ?? '',
  }

  const note = typeof config?.replyInstruction === 'string' ? config.replyInstruction.trim() : ''

  const custom = typeof config?.startPrompt === 'string' ? config.startPrompt.trim() : ''
  if (custom !== '') return joinBlocks([substitute(custom, vars), note])

  // Задача из issue и своя задача — разные сообщения, а не одно с пропусками.
  const fromIssue = vars.repo !== '' && vars.issueNumber !== ''
  const head = fromIssue
    ? `Задача ${vars.repo}#${vars.issueNumber}: ${vars.title}`
    : `Задача: ${vars.title}`

  return joinBlocks([
    head,
    vars.body,
    fromIssue && vars.issueUrl !== '' ? `Ссылка: ${vars.issueUrl}` : '',
    fromIssue ? WORKFLOW_TAIL : OWN_TAIL,
    note,
  ])
}

/** Склеить непустые куски пустой строкой между ними. */
function joinBlocks(parts) {
  return parts.map((p) => String(p ?? '').trim()).filter(Boolean).join('\n\n')
}

function substitute(template, vars) {
  let text = template
  for (const [name, value] of Object.entries(vars)) {
    text = text.split(`{${name}}`).join(value)
  }
  return text
}

/**
 * Рабочая папка сессии — КОРНЕВОЙ checkout проекта, не worktree.
 *
 * Корневой checkout по воркфлоу только для чтения, и это ровно то место, где
 * положено начинать: preflight читает состояние репозитория. Worktree заведёт
 * агент.
 *
 * Имя репозитория приходит из данных Gitea, а не из кода, поэтому выход за
 * пределы корня отвергается: иначе задача с подделанным именем увела бы сессию
 * в произвольный каталог.
 *
 * @throws если корень не абсолютный либо имя репозитория выводит за его пределы
 */
export function resolveCwd(task, config, cwdOf = () => process.cwd()) {
  const root = typeof config?.defaultProjectRoot === 'string' && config.defaultProjectRoot.trim() !== ''
    ? config.defaultProjectRoot.trim()
    : cwdOf()
  if (!isAbsolute(root)) throw new Error('корень проектов должен быть абсолютным путём')

  const repo = typeof task?.repo === 'string' ? task.repo.trim() : ''
  if (repo === '') return root

  const target = resolve(join(root, repo))
  const fence = resolve(root)
  if (target !== fence && !target.startsWith(fence.endsWith('/') ? fence : fence + '/')) {
    throw new Error('имя репозитория выводит за пределы корня проектов')
  }
  return target
}

/**
 * Взять агента задачи: живого, возобновлённого или нового.
 *
 * Правило владельца — **одна задача, один чат**, сколько бы этапов в ней ни
 * было. Поэтому новую сессию поднимаем только когда прежней взять неоткуда.
 *
 * Возобновление не проверяем заранее отдельным вопросом «сохранена ли сессия»:
 * такого вопроса у ядра нет, а `resume` сам скажет отказом. Пробуем и ловим.
 *
 * @returns {{agent: object, sessionId: string, mode: 'opened'|'resumed'|'created'}}
 */
export async function obtainAgent({
  agents, task, config, provider, model, mintSessionId, cwdOf, logger,
}) {
  const known = typeof task?.sessionId === 'string' && task.sessionId !== '' ? task.sessionId : undefined

  if (known !== undefined) {
    // Живой агент — просто берём его.
    let live
    try { live = agents.get(known) } catch { live = undefined }
    if (live !== undefined) return { agent: live, sessionId: known, mode: 'opened' }

    // Сессия выгружена, но могла сохраниться.
    try {
      const handle = await agents.resume({ resumeSessionId: known, agentOptions: { provider, model } })
      return { agent: handle.agent, sessionId: handle.agent.session.id, mode: 'resumed' }
    } catch (error) {
      logger?.warn?.(`dsh-kanban: сессия ${known} не возобновилась: ${error?.message}`)
    }
  }

  const cwd = resolveCwd(task, config, cwdOf)
  const handle = await agents.create({
    sessionId: mintSessionId(),
    meta: { cwd },
    agentOptions: { provider, model },
  })
  return { agent: handle.agent, sessionId: handle.agent.session.id, mode: 'created' }
}

/**
 * Запустить или продолжить работу по задаче.
 *
 * Порядок важен: сначала берём агента, дожидаемся простоя, отправляем
 * сообщение и только потом пишем в хранилище. Запись до запуска оставила бы
 * задачу в «В работе» без сессии, если запуск упадёт.
 *
 * Колонку двигаем ТОЛЬКО при первом запуске из бэклога. Задача в «Ревью», по
 * которой нажали «Продолжить», обязана остаться в «Ревью»: продолжение — это
 * не откат к началу.
 *
 * @param {string} [text] сообщение человека; пусто — встроенная заготовка
 * @returns {{sessionId: string, mode: string, task: object}}
 */
export async function runTask({
  agents, store, task, config, provider, model,
  mintSessionId, createMessage, cwdOf, logger, text,
}) {
  const taken = await obtainAgent({
    agents, task, config, provider, model, mintSessionId, cwdOf, logger,
  })

  await taken.agent.whenIdle()
  taken.agent.followup(createMessage({
    // Содержимое — МАССИВ блоков, а не строка: ядро перебирает его как список
    // (`content.some(...)`), и строка роняет ход целиком.
    content: [{ type: 'text', text: messageFor(task, config, text) }],
    source: { kind: 'plugin', plugin: 'dsh-kanban', form: 'task-start' },
  }))

  const before = store.getTask(task.id)
  const patch = { sessionId: taken.sessionId, provider, model }
  store.updateTask(task.id, patch)

  // Подмена чата не должна быть молчаливой: человек вернётся к задаче и не
  // поймёт, куда делась переписка.
  if (taken.mode === 'created' && before.sessionId) {
    store.addTransition({
      taskId: task.id,
      fromCol: before.column,
      toCol: before.column,
      source: 'session',
      detail: `прежняя сессия не возобновилась, поднята новая: ${taken.sessionId}`,
    })
  }

  let current = store.getTask(task.id)
  if (taken.mode === 'created' && before.column === 'backlog') {
    current = store.moveTask(task.id, { column: 'in-progress' })
    store.addTransition({
      taskId: task.id,
      fromCol: before.column,
      toCol: 'in-progress',
      source: 'session',
      detail: `сессия ${taken.sessionId}, модель ${model}`,
    })
  }

  return { sessionId: taken.sessionId, mode: taken.mode, task: current }
}

/** Текст сообщения: человеческий, если он есть, иначе встроенная заготовка. */
function messageFor(task, config, text) {
  const own = typeof text === 'string' ? text.trim() : ''
  return own !== '' ? own : buildStartMessage(task, config)
}

/**
 * Провайдер и модель для запуска: сначала выбор человека, затем модель по
 * умолчанию из харнесса. Если не выбрано ни там, ни там — внятный отказ, а не
 * падение.
 */
export function resolveModel({ requested, fallback }) {
  const provider = requested?.provider || fallback?.provider
  const model = requested?.model || fallback?.model
  if (!provider || !model) return { error: 'model-not-selected', status: 409 }
  return { provider, model }
}

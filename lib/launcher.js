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

/** Встроенный шаблон первого сообщения. */
const BUILTIN = [
  '{head}',
  '',
  '{body}',
  '{link}',
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

  const custom = typeof config?.startPrompt === 'string' ? config.startPrompt.trim() : ''
  if (custom !== '') return substitute(custom, vars)

  // Своя задача без issue: ссылка и номер опускаются целиком, а не
  // подставляются пустотой посреди строки.
  const head = vars.repo !== '' && vars.issueNumber !== ''
    ? `Задача ${vars.repo}#${vars.issueNumber}: ${vars.title}`
    : `Задача: ${vars.title}`
  const link = vars.issueUrl !== '' ? `Ссылка: ${vars.issueUrl}\n` : ''

  return substitute(BUILTIN, { ...vars, head, link })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
 * Поднять сессию по задаче и отдать первое сообщение.
 *
 * Порядок важен: сначала создаём сессию, дожидаемся простоя, отправляем
 * сообщение и только потом пишем в хранилище. Запись до запуска оставила бы
 * задачу в «В работе» без сессии, если запуск упадёт.
 *
 * @returns {{sessionId: string, task: object}}
 */
export async function startTask({
  agents, store, task, config, provider, model,
  sessionId, createMessage, cwdOf,
}) {
  const cwd = resolveCwd(task, config, cwdOf)
  const handle = await agents.create({
    sessionId,
    meta: { cwd },
    agentOptions: { provider, model },
  })

  await handle.agent.whenIdle()
  handle.agent.followup(createMessage({
    content: buildStartMessage(task, config),
    source: { kind: 'plugin', plugin: 'dsh-kanban', form: 'task-start' },
  }))

  const live = handle.agent.session.id
  const before = store.getTask(task.id)
  store.updateTask(task.id, { sessionId: live, provider, model })
  const moved = store.moveTask(task.id, { column: 'in-progress' })
  if (before.column !== 'in-progress') {
    store.addTransition({
      taskId: task.id,
      fromCol: before.column,
      toCol: 'in-progress',
      source: 'session',
      detail: `сессия ${live}, модель ${model}`,
    })
  }
  return { sessionId: live, task: moved }
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

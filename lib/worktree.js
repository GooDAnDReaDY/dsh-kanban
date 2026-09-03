// Управляемые воркдеревья для сессий агентов под задачи (Issue #193).
//
// Изоляция сессии агента в отдельном git worktree защищает основной
// репозиторий от параллельных правок нескольких задач, предотвращает
// перезапись веток и фиксирует рабочее окружение карточки.
//
// Жизненный цикл:
// 1. При переходе в In Progress создаётся воркдерево task/<id>-<slug>
// 2. Воркдерево регистрируется в DSH workspaceRegistry как рабочий каталог
// 3. Сессия агента запускается с cwd = worktreePath
// 4. В колонке Cleanup проверяются незакоммиченные файлы (dirtyFiles)
// 5. После подтверждения воркдерево удаляется, воркспейс дерегистрируется.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

const execFileAsync = promisify(execFile)

/**
 * Стандартный исполнитель git-команд.
 * Принимает аргументы массивом, исключая шелл-инъекции.
 */
export async function defaultGitRunner(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 }
  } catch (err) {
    const error = new Error(`git ${args.join(' ')} failed: ${err.stderr || err.message}`)
    error.code = err.code || 1
    error.stdout = err.stdout ? String(err.stdout).trim() : ''
    error.stderr = err.stderr ? String(err.stderr).trim() : ''
    throw error
  }
}

/**
 * Преобразовать строку в безопасный фрагмент имени ветки или каталога.
 */
export function slugify(text) {
  if (typeof text !== 'string') return 'task'
  const slug = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9а-яё_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return slug || 'task'
}

/**
 * Безопасный ключ репозитория для каталога воркдеревьев.
 */
export function safeRepoKey(task) {
  const owner = typeof task?.owner === 'string' ? task.owner.trim() : ''
  const repo = typeof task?.repo === 'string' ? task.repo.trim() : ''
  if (owner && repo) return `${owner}_${repo}`
  if (repo) return repo
  return 'local'
}

/**
 * Определить корневой каталог для всех управляемых воркдеревьев.
 */
export function resolveWorktreeRoot(config, env = process.env, cwdOf = () => process.cwd()) {
  const custom = typeof config?.worktreeRoot === 'string' ? config.worktreeRoot.trim() : ''
  if (custom !== '') {
    return isAbsolute(custom) ? resolve(custom) : resolve(join(cwdOf(), custom))
  }
  if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') {
    return resolve(join(env.DSH_HOME.trim(), 'worktrees'))
  }
  const projectRoot = typeof config?.defaultProjectRoot === 'string' && config.defaultProjectRoot.trim() !== ''
    ? config.defaultProjectRoot.trim()
    : cwdOf()
  return resolve(join(projectRoot, '.worktrees'))
}

/**
 * Вычислить канонический путь к воркдереву задачи с защитой от path traversal.
 */
export function resolveTaskWorktreePath({ task, config, env, cwdOf }) {
  const root = resolveWorktreeRoot(config, env, cwdOf)
  const repoKey = safeRepoKey(task)
  const taskId = typeof task?.id === 'string' && task.id.trim() !== '' ? task.id.trim() : 'task'
  const target = resolve(join(root, repoKey, taskId))

  const fenceSep = root.endsWith(sep) || root.endsWith('/') ? root : root + sep
  if (target !== root && !target.startsWith(fenceSep) && !target.startsWith(root + '/')) {
    throw new Error('путь воркдерева выходит за пределы корня воркдеревьев')
  }
  return target
}

/**
 * Сформировать имя ветки задачи.
 */
export function resolveTaskBranch(task) {
  const prefix = typeof task?.issueNumber === 'number'
    ? String(task.issueNumber)
    : (typeof task?.id === 'string' ? task.id.slice(0, 8) : 'task')
  const slug = slugify(task?.title || '')
  return `task/${prefix}-${slug}`
}

/**
 * Проверить, является ли каталог git-репозиторием.
 */
export async function isGitRepo(repoDir, gitRunner = defaultGitRunner) {
  if (!repoDir) return false
  try {
    const res = await gitRunner(['rev-parse', '--is-inside-work-tree'], repoDir)
    return res.stdout === 'true'
  } catch {
    return false
  }
}

/**
 * Получить список существующих путей воркдеревьев для репозитория.
 */
export async function listWorktrees(repoDir, gitRunner = defaultGitRunner) {
  try {
    const res = await gitRunner(['worktree', 'list', '--porcelain'], repoDir)
    const paths = []
    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        paths.push(resolve(line.slice(9).trim()))
      }
    }
    return paths
  } catch {
    return []
  }
}

/**
 * Определить базовую ветку для создания воркдерева.
 */
export async function determineBaseRef(repoDir, gitRunner = defaultGitRunner) {
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master', 'HEAD']) {
    try {
      await gitRunner(['rev-parse', '--verify', '--quiet', candidate], repoDir)
      return candidate
    } catch {
      continue
    }
  }
  return 'HEAD'
}

/**
 * Создать или переиспользовать воркдерево под задачу.
 */
export async function createTaskWorktree({
  task,
  repoDir,
  config,
  gitRunner = defaultGitRunner,
  env,
  cwdOf,
}) {
  if (!repoDir) return undefined
  const isGit = await isGitRepo(repoDir, gitRunner)
  if (!isGit) return undefined

  const worktreePath = resolveTaskWorktreePath({ task, config, env, cwdOf })
  const branchName = resolveTaskBranch(task)

  // Проверяем, не зарегистрировано ли уже это воркдерево
  const existing = await listWorktrees(repoDir, gitRunner)
  if (existing.includes(resolve(worktreePath))) {
    return { worktreePath, branchName, reused: true }
  }

  // Проверяем, существует ли уже локальная ветка с таким именем
  let branchExists = false
  try {
    await gitRunner(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], repoDir)
    branchExists = true
  } catch {
    branchExists = false
  }

  if (branchExists) {
    await gitRunner(['worktree', 'add', worktreePath, branchName], repoDir)
  } else {
    const baseRef = await determineBaseRef(repoDir, gitRunner)
    await gitRunner(['worktree', 'add', '-b', branchName, worktreePath, baseRef], repoDir)
  }

  return { worktreePath, branchName, created: true }
}

/**
 * Проверить наличие незакоммиченных изменений в воркдереве.
 */
export async function checkWorktreeDirty({ worktreePath, gitRunner = defaultGitRunner }) {
  if (!worktreePath || !existsSync(worktreePath)) {
    return { dirty: false, files: [] }
  }
  try {
    const res = await gitRunner(['status', '--porcelain'], worktreePath)
    const files = res.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    return { dirty: files.length > 0, files }
  } catch (error) {
    return { dirty: false, files: [], error: String(error?.message ?? error) }
  }
}

/**
 * Безопасно удалить воркдерево задачи.
 */
export async function removeTaskWorktree({
  repoDir,
  worktreePath,
  branchName,
  force = false,
  deleteBranch = true,
  gitRunner = defaultGitRunner,
}) {
  if (!worktreePath || !existsSync(worktreePath)) {
    return { removed: false, reason: 'not-found' }
  }

  const dirtyCheck = await checkWorktreeDirty({ worktreePath, gitRunner })
  if (dirtyCheck.dirty && !force) {
    return {
      removed: false,
      error: 'worktree-dirty',
      files: dirtyCheck.files,
    }
  }

  const removeArgs = force
    ? ['worktree', 'remove', '--force', worktreePath]
    : ['worktree', 'remove', worktreePath]

  await gitRunner(removeArgs, repoDir)
  try { await gitRunner(['worktree', 'prune'], repoDir) } catch { /* prune игнорирует ошибки */ }

  let branchDeleted = false
  if (deleteBranch && branchName && repoDir) {
    try {
      await gitRunner(['branch', '-d', branchName], repoDir)
      branchDeleted = true
    } catch {
      // Игнорируем: ветка не удалена, если ещё не влита
      branchDeleted = false
    }
  }

  return { removed: true, branchDeleted }
}

/**
 * Зарегистрировать каталог воркдерева в DSH workspaceRegistry.
 */
export async function registerDshWorkspace({ workspaceRegistry, worktreePath, title }) {
  if (!workspaceRegistry || typeof workspaceRegistry.create !== 'function') return undefined
  try {
    const entity = await workspaceRegistry.create(worktreePath, title || 'Task Workspace')
    return entity?.id
  } catch {
    return undefined
  }
}

/**
 * Дерегистрировать воркспейс из DSH workspaceRegistry.
 */
export async function deregisterDshWorkspace({ workspaceRegistry, workspaceId }) {
  if (!workspaceRegistry || typeof workspaceRegistry.delete !== 'function' || !workspaceId) return false
  try {
    return (await workspaceRegistry.delete(workspaceId)) === true
  } catch {
    return false
  }
}

/**
 * Выполнить очистку воркдерева задачи с проверкой незакоммиченных изменений.
 */
export async function cleanupTaskWorktree({
  store,
  task,
  repoDir,
  workspaceRegistry,
  force = false,
  deleteBranch = true,
  gitRunner = defaultGitRunner,
}) {
  const current = typeof task === 'object' && task !== null ? task : store?.getTask?.(task)
  if (!current) return { error: 'task-not-found', status: 404 }
  if (!current.worktree) return { noop: true, removed: false }

  const targetRepoDir = repoDir || current.worktree
  const result = await removeTaskWorktree({
    repoDir: targetRepoDir,
    worktreePath: current.worktree,
    branchName: current.branch,
    force,
    deleteBranch,
    gitRunner,
  })

  if (result.error === 'worktree-dirty') {
    store?.addTransition?.({
      taskId: current.id,
      fromCol: current.column,
      toCol: current.column,
      source: 'session',
      detail: `очистка отложена: обнаружены незакоммиченные файлы: ${result.files.slice(0, 3).join(', ')}`,
    })
    return { error: 'worktree-dirty', files: result.files }
  }

  if (workspaceRegistry && current.workspaceId) {
    await deregisterDshWorkspace({ workspaceRegistry, workspaceId: current.workspaceId })
  }

  store?.updateTask?.(current.id, { worktree: '', workspaceId: '' })
  store?.addTransition?.({
    taskId: current.id,
    fromCol: current.column,
    toCol: current.column,
    source: 'session',
    detail: 'очистка: воркдерево удалено' + (result.branchDeleted ? ', ветка удалена' : ''),
  })

  return { success: true, removed: true, branchDeleted: result.branchDeleted }
}

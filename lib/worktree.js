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
import { existsSync, readFileSync } from 'node:fs'
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
    return res.stdout?.trim() === 'true'
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
function isSubmoduleDrift(worktreePath, line) {
  try {
    const filePath = line.slice(3).trim()
    if (!filePath) return false
    const fullPath = resolve(worktreePath, filePath)
    const gitFile = join(fullPath, '.git')
    if (existsSync(gitFile)) {
      return true
    }
    const gitmodulesPath = join(worktreePath, '.gitmodules')
    if (existsSync(gitmodulesPath)) {
      const content = readFileSync(gitmodulesPath, 'utf8')
      const paths = [...content.matchAll(/path\s*=\s*([^\r\n]+)/g)].map((m) => m[1].trim())
      if (paths.includes(filePath) || paths.some((p) => filePath.startsWith(p + '/') || filePath === p)) {
        return true
      }
    }
  } catch {
    // Игнорируем ошибки доступа к файлам при проверке
  }
  return false
}

/**
 * Проверить наличие незакоммиченных изменений в воркдереве.
 * Исключает структурный шум субмодулей и дрейф gitlinks (#213).
 */
export async function checkWorktreeDirty({ worktreePath, gitRunner = defaultGitRunner }) {
  if (!worktreePath || !existsSync(worktreePath)) {
    return { dirty: false, files: [] }
  }
  try {
    const res = await gitRunner(['status', '--porcelain', '--ignore-submodules=all'], worktreePath)
    const files = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((line) => !isSubmoduleDrift(worktreePath, line))
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

/**
 * Получить unified diff изменений в воркдереве задачи (#211).
 *
 * @param {{worktreePath: string, baseRef?: string, gitRunner?: Function}} options
 * @returns {Promise<{diff: string, truncated: boolean, filesChanged: number}>}
 */
export async function getTaskDiff({ worktreePath, baseRef, gitRunner = defaultGitRunner }) {
  if (!worktreePath) return { diff: '', truncated: false, filesChanged: 0 }
  const isRepo = await isGitRepo(worktreePath, gitRunner)
  if (!isRepo) return { diff: '', truncated: false, filesChanged: 0 }

  let base = baseRef
  if (!base) {
    base = await determineBaseRef(worktreePath, gitRunner)
  }

  // Сначала пробуем git diff base...HEAD, если base доступен
  let diffOut = ''
  if (base) {
    const res = await gitRunner(['diff', `${base}...HEAD`], worktreePath)
    if (res.exitCode === 0) {
      diffOut = res.stdout
    }
  }

  // Дополнительно смотрим незакоммиченные изменения (unstaged + staged)
  const unstaged = await gitRunner(['diff', 'HEAD'], worktreePath)
  if (unstaged.exitCode === 0 && unstaged.stdout.trim() !== '') {
    diffOut = diffOut ? `${diffOut}\n\n# Uncommitted Changes:\n${unstaged.stdout}` : unstaged.stdout
  }

  // Если и base...HEAD, и HEAD ничего не дали, берём чистый git diff
  if (!diffOut.trim()) {
    const fallback = await gitRunner(['diff'], worktreePath)
    if (fallback.exitCode === 0) diffOut = fallback.stdout
  }

  // Подсчитываем число затронутых файлов
  const fileLines = diffOut.split('\n').filter((l) => l.startsWith('diff --git'))
  const filesChanged = fileLines.length

  // Защита от переполнения: обрезаем diff до 250 КБ
  const MAX_DIFF_BYTES = 250 * 1024
  let truncated = false
  if (Buffer.byteLength(diffOut, 'utf8') > MAX_DIFF_BYTES) {
    diffOut = diffOut.slice(0, MAX_DIFF_BYTES) + '\n\n... [Diff truncated: exceeded 250 KB limit]'
    truncated = true
  }

  return { diff: diffOut, truncated, filesChanged }
}

/**
 * Получить список коммитов ветки задачи относительно базовой ветки (#211).
 *
 * @param {{worktreePath: string, baseRef?: string, gitRunner?: Function}} options
 * @returns {Promise<Array<{hash: string, subject: string, author: string, date: string}>>}
 */
export async function getTaskCommits({ worktreePath, baseRef, gitRunner = defaultGitRunner }) {
  if (!worktreePath) return []
  const isRepo = await isGitRepo(worktreePath, gitRunner)
  if (!isRepo) return []

  let base = baseRef
  if (!base) {
    base = await determineBaseRef(worktreePath, gitRunner)
  }

  const range = base ? `${base}..HEAD` : '-n 20'
  const logRes = await gitRunner(['log', range, '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short'], worktreePath)
  if (logRes.exitCode !== 0 || !logRes.stdout.trim()) {
    // fallback на последние 10 коммитов
    const fallback = await gitRunner(['log', '-n', '10', '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short'], worktreePath)
    if (fallback.exitCode !== 0 || !fallback.stdout.trim()) return []
    return fallback.stdout.trim().split('\n').map(parseCommitLine).filter(Boolean)
  }

  return logRes.stdout.trim().split('\n').map(parseCommitLine).filter(Boolean)
}

function parseCommitLine(line) {
  const parts = line.split('\t')
  if (parts.length < 4) return null
  return {
    hash: parts[0],
    author: parts[1],
    date: parts[2],
    subject: parts[3],
  }
}

/**
 * Слияние ветки воркдерева в основную ветку репозитория (--no-ff) при приёмке (#212).
 *
 * @param {{task: object, targetBranch?: string, gitRunner?: Function, workspaceRegistry?: object}} options
 * @returns {Promise<{success: boolean, merged: boolean, error?: string}>}
 */
export async function mergeTaskWorktree({
  task, targetBranch, gitRunner = defaultGitRunner, workspaceRegistry,
}) {
  if (!task.worktree || !task.branch) {
    return { success: false, merged: false, error: 'no-worktree-or-branch' }
  }

  // 1. Проверяем чистоту воркдерева
  const dirtyCheck = await checkWorktreeDirty({ worktreePath: task.worktree, gitRunner })
  if (dirtyCheck.dirty) {
    return { success: false, merged: false, error: 'worktree-dirty', files: dirtyCheck.files }
  }

  // 2. Находим корень основного репозитория (из .git файла воркдерева или config)
  let mainRepoDir = ''
  const revParse = await gitRunner(['rev-parse', '--git-common-dir'], task.worktree)
  if (revParse.exitCode === 0 && revParse.stdout.trim()) {
    const commonDir = revParse.stdout.trim()
    mainRepoDir = commonDir.endsWith('/.git') ? commonDir.slice(0, -5) : commonDir
  }

  if (!mainRepoDir) {
    return { success: false, merged: false, error: 'main-repo-not-found' }
  }

  // 3. Определяем целевую ветку для слияния
  let target = targetBranch
  if (!target) {
    target = await determineBaseRef(mainRepoDir, gitRunner)
  }
  if (!target) target = 'main'

  // 4. Переключаемся или проверяем, что в целевой ветке в основном репо
  const currentBranch = await gitRunner(['branch', '--show-current'], mainRepoDir)
  if (currentBranch.stdout.trim() !== target) {
    const checkoutRes = await gitRunner(['checkout', target], mainRepoDir)
    if (checkoutRes.exitCode !== 0) {
      return { success: false, merged: false, error: 'checkout-target-failed', detail: checkoutRes.stderr }
    }
  }

  // 5. Выполняем git merge --no-ff
  const mergeMsg = `Merge branch '${task.branch}' for task ${task.id}`
  const mergeRes = await gitRunner(['merge', '--no-ff', task.branch, '-m', mergeMsg], mainRepoDir)
  if (mergeRes.exitCode !== 0) {
    // В случае конфликта откатываем мерж
    await gitRunner(['merge', '--abort'], mainRepoDir)
    return { success: false, merged: false, error: 'merge-conflict', detail: mergeRes.stderr || mergeRes.stdout }
  }

  // 6. Очищаем воркдерево задачи
  await cleanupTaskWorktree({
    task,
    workspaceRegistry,
    gitRunner,
    force: true,
  })

  return { success: true, merged: true, targetBranch: target }
}

// Managed worktrees for task agent sessions (Issue #193).
//
// Isolating agent sessions in git worktrees protects the main repository
// from concurrent modifications, prevents branch overwrite conflicts,
// and scopes working directory per task.
//
// Lifecycle:
// 1. On transition to In Progress: create worktree task/<id>-<slug>
// 2. Register worktree in DSH workspaceRegistry as active workspace
// 3. Launch agent session with cwd = worktreePath
// 4. In Cleanup column: verify uncommitted files (dirtyFiles)
// 5. Upon confirmation: remove worktree and deregister workspace.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { isAbsolute, join, resolve, sep } from 'node:path'

const execFileAsync = promisify(execFile)

/**
 * Standard git command runner.
 * Accepts argument array to eliminate shell injection vulnerabilities.
 */
export async function defaultGitRunner(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    })
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0, exitCode: 0 }
  } catch (err) {
    const error = new Error(`git ${args.join(' ')} failed: ${err.stderr || err.message}`)
    error.code = err.code || 1
    error.exitCode = err.code || 1
    error.stdout = err.stdout ? String(err.stdout).trim() : ''
    error.stderr = err.stderr ? String(err.stderr).trim() : ''
    throw error
  }
}

/**
 * Convert string into safe branch/directory slug.
 */
export function slugify(text) {
  if (typeof text !== 'string') return 'task'
  const slug = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}0-9_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return slug || 'task'
}

/**
 * Safe repository key for worktree root directory.
 */
export function safeRepoKey(task) {
  const owner = typeof task?.owner === 'string' ? task.owner.trim() : ''
  const repo = typeof task?.repo === 'string' ? task.repo.trim() : ''
  if (owner && repo) return `${owner}_${repo}`
  if (repo) return repo
  return 'local'
}

/**
 * Resolve root directory for all managed worktrees.
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
 * Resolve canonical worktree path for task with path traversal protection.
 */
export function isSafeBranchName(name) {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.startsWith('-') || trimmed.startsWith('/') || trimmed.endsWith('/')) return false
  if (trimmed.includes('..') || trimmed.includes('~') || trimmed.includes('^') || trimmed.includes(':') || trimmed.includes('?') || trimmed.includes('*') || trimmed.includes('[') || trimmed.includes('\\') || trimmed.includes('@{') || trimmed.endsWith('.lock')) return false
  return /^[A-Za-z0-9_./-]+$/.test(trimmed)
}

export function isPathFenced(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false
  const resolvedTarget = resolve(targetPath)
  const resolvedRoot = resolve(rootPath)
  const fence = resolvedRoot.endsWith(sep) || resolvedRoot.endsWith('/') ? resolvedRoot : resolvedRoot + sep
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(fence)
}

export function resolveTaskWorktreePath({ task, config, env, cwdOf }) {
  const root = resolveWorktreeRoot(config, env, cwdOf)
  const repoKey = safeRepoKey(task)
  const taskId = typeof task?.id === 'string' && task.id.trim() !== '' ? task.id.trim() : 'task'
  const target = resolve(join(root, repoKey, taskId))

  const fenceSep = root.endsWith(sep) || root.endsWith('/') ? root : root + sep
  if (target !== root && !target.startsWith(fenceSep) && !target.startsWith(root + '/')) {
    throw new Error('worktree path escapes worktree root')
  }
  return target
}

/**
 * Generate task branch name.
 */
export function resolveTaskBranch(task) {
  const prefix = typeof task?.issueNumber === 'number'
    ? String(task.issueNumber)
    : (typeof task?.id === 'string' ? task.id.slice(0, 8) : 'task')
  const slug = slugify(task?.title || '')
  return `task/${prefix}-${slug}`
}

/**
 * Check if directory is a valid git repository.
 */
export async function isGitRepo(repoDir, gitRunner = defaultGitRunner) {
  if (!repoDir) return false
  try {
    const res = await gitRunner(['rev-parse', '--is-inside-work-tree'], repoDir)
    return res.stdout?.trim() === 'true'
  } catch (err) {
    const msg = String(err?.stderr || err?.message || '').toLowerCase()
    if (
      msg.includes('not a git repo') ||
      msg.includes('not a git repository') ||
      msg.includes('не найден git репозиторий') ||
      msg.includes('не является git-репозиторием') ||
      (err?.code === 'ENOENT' && repoDir && !existsSync(repoDir))
    ) {
      return false
    }
    throw err
  }
}

/**
 * List existing worktree paths for repository.
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
 * Resolve base ref for worktree creation.
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
 * Create or reuse worktree for task.
 */
export async function createTaskWorktree({
  task,
  repoDir,
  config,
  gitRunner = defaultGitRunner,
  env,
  cwdOf,
}) {
  if (!repoDir) {
    if (task?.workspacePath) {
      return prepareMultiRepoMirror({ task, workspacePath: task.workspacePath, gitRunner, config })
    }
    return undefined
  }
  const isGit = await isGitRepo(repoDir, gitRunner)
  if (!isGit) return undefined

  const worktreePath = resolveTaskWorktreePath({ task, config, env, cwdOf })
  const branchName = resolveTaskBranch(task)

  // Check if worktree is already registered
  const existing = await listWorktrees(repoDir, gitRunner)
  if (existing.includes(resolve(worktreePath))) {
    return { worktreePath, branchName, reused: true }
  }

  // Check if local branch already exists
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
 * Check for uncommitted changes in worktree.
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
    // Ignore file access errors during check
  }
  return false
}

/**
 * Check for uncommitted changes in worktree.
 * Excludes submodule noise and gitlink drift (#213).
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
    return { dirty: true, files: [], error: String(error?.message ?? error) }
  }
}

/**
 * Safely remove task worktree.
 */
export async function removeTaskWorktree({
  repoDir,
  worktreePath,
  branchName,
  force = false,
  deleteBranch = true,
  gitRunner = defaultGitRunner,
  rootPath,
}) {
  if (!worktreePath || !existsSync(worktreePath)) {
    return { removed: false, reason: 'not-found' }
  }

  if (rootPath && !isPathFenced(worktreePath, rootPath)) {
    return { removed: false, error: 'unfenced-worktree-path' }
  }

  const dirtyCheck = await checkWorktreeDirty({ worktreePath, gitRunner })
  if (dirtyCheck.error) {
    return {
      removed: false,
      error: 'worktree-status-error',
      detail: dirtyCheck.error,
    }
  }
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
  try { await gitRunner(['worktree', 'prune'], repoDir) } catch { /* prune ignores errors */ }

  let branchDeleted = false
  if (deleteBranch && branchName && repoDir) {
    try {
      await gitRunner(['branch', '-d', branchName], repoDir)
      branchDeleted = true
    } catch {
      // Ignored: branch not deleted if not yet merged
      branchDeleted = false
    }
  }

  return { removed: true, branchDeleted }
}

/**
 * Register worktree path in DSH workspaceRegistry.
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
 * Deregister workspace from DSH workspaceRegistry.
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
 * Clean up task worktree with dirty files guard.
 */
export async function cleanupTaskWorktree({
  store,
  task,
  repoDir,
  workspaceRegistry,
  force = false,
  deleteBranch = true,
  gitRunner = defaultGitRunner,
  config,
  env,
  cwdOf,
}) {
  const current = typeof task === 'object' && task !== null ? task : store?.getTask?.(task)
  if (!current) return { error: 'task-not-found', status: 404 }
  if (!current.worktree) return { noop: true, removed: false }

  const root = resolveWorktreeRoot(config, env, cwdOf)
  const customRoot = typeof config?.worktreeRoot === 'string' && config.worktreeRoot.trim() !== ''
    ? root
    : undefined
  const candidateRoots = [
    root,
    repoDir,
    typeof cwdOf === 'function' ? cwdOf() : (!customRoot && !repoDir ? process.cwd() : undefined),
  ].filter(Boolean)
  const isFenced = candidateRoots.length === 0 || candidateRoots.some((c) => isPathFenced(current.worktree, c))
  if (!isFenced) {
    return { error: 'unfenced-worktree-path', status: 403 }
  }

  // 1. Verify worktree cleanliness (force must not bypass dirty worktree ban #341)
  const dirtyCheck = await checkWorktreeDirty({ worktreePath: current.worktree, gitRunner })
  if (dirtyCheck.error) {
    return { error: 'worktree-status-error', detail: dirtyCheck.error }
  }
  if (dirtyCheck.dirty) {
    store?.addTransition?.({
      taskId: current.id,
      fromCol: current.column,
      toCol: current.column,
      source: 'session',
      detail: `cleanup deferred: uncommitted files detected: ${dirtyCheck.files.slice(0, 3).join(', ')}`,
    })
    return { error: 'worktree-dirty', files: dirtyCheck.files }
  }

  // 2. Ownership fencing: ensure worktree is registered in repository before removal (#315)
  let baseRepo = repoDir
  if (!baseRepo && current?.repo) {
    const root = typeof config?.defaultProjectRoot === 'string' && config.defaultProjectRoot.trim() !== ''
      ? config.defaultProjectRoot.trim()
      : (typeof cwdOf === 'function' ? cwdOf() : process.cwd())
    baseRepo = resolve(join(root, current.repo))
  }
  if (!baseRepo) {
    const rev = await gitRunner(['rev-parse', '--git-common-dir'], current.worktree)
    if ((rev?.exitCode ?? rev?.code ?? 0) === 0 && rev?.stdout?.trim()) {
      const cd = rev.stdout.trim()
      baseRepo = cd.endsWith('/.git') ? cd.slice(0, -5) : cd
    }
  }
  if (baseRepo) {
    const registered = await listWorktrees(baseRepo, gitRunner)
    const norm = resolve(current.worktree)
    if (!registered.some((p) => resolve(p) === norm)) {
      return { error: 'worktree-not-registered', status: 403 }
    }
  }

  const targetRepoDir = repoDir || current.worktree
  const result = await removeTaskWorktree({
    repoDir: targetRepoDir,
    worktreePath: current.worktree,
    branchName: current.branch,
    force,
    deleteBranch,
    gitRunner,
  })

  if (result.error) {
    if (result.error === 'worktree-dirty') {
      store?.addTransition?.({
        taskId: current.id,
        fromCol: current.column,
        toCol: current.column,
        source: 'session',
        detail: `cleanup deferred: uncommitted files detected: ${result.files.slice(0, 3).join(', ')}`,
      })
      return { error: 'worktree-dirty', files: result.files }
    }
    return { success: false, removed: false, error: result.error, detail: result.detail }
  }

  if (!result.removed) {
    return { success: false, removed: false, reason: result.reason }
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
    detail: 'cleanup: worktree removed' + (result.branchDeleted ? ', branch deleted' : ''),
  })

  return { success: true, removed: true, branchDeleted: result.branchDeleted }
}

/**
 * Generate unified diff of changes in task worktree (#211).
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

  // Try git diff base...HEAD first if base ref is available
  let diffOut = ''
  if (base) {
    const res = await gitRunner(['diff', `${base}...HEAD`], worktreePath)
    if ((res?.exitCode ?? res?.code ?? 0) === 0) {
      diffOut = res.stdout
    }
  }

  // Include uncommitted changes (unstaged + staged)
  const unstaged = await gitRunner(['diff', 'HEAD'], worktreePath)
  if ((unstaged?.exitCode ?? unstaged?.code ?? 0) === 0 && unstaged.stdout.trim() !== '') {
    diffOut = diffOut ? `${diffOut}\n\n# Uncommitted Changes:\n${unstaged.stdout}` : unstaged.stdout
  }

  // Fallback to plain git diff if base...HEAD produced no output
  if (!diffOut.trim()) {
    const fallback = await gitRunner(['diff'], worktreePath)
    if ((fallback?.exitCode ?? fallback?.code ?? 0) === 0) diffOut = fallback.stdout
  }

  // Count affected files
  const fileLines = diffOut.split('\n').filter((l) => l.startsWith('diff --git'))
  const filesChanged = fileLines.length

  // Memory guard: cap diff output at 250 KiB
  const MAX_DIFF_BYTES = 250 * 1024
  let truncated = false
  if (Buffer.byteLength(diffOut, 'utf8') > MAX_DIFF_BYTES) {
    diffOut = diffOut.slice(0, MAX_DIFF_BYTES) + '\n\n... [Diff truncated: exceeded 250 KB limit]'
    truncated = true
  }

  return { diff: diffOut, truncated, filesChanged }
}

/**
 * List task branch commits relative to base branch (#211).
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
  if ((logRes?.exitCode ?? logRes?.code ?? 0) !== 0 || !logRes.stdout.trim()) {
    // Fallback to last 10 commits
    const fallback = await gitRunner(['log', '-n', '10', '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short'], worktreePath)
    if ((fallback?.exitCode ?? fallback?.code ?? 0) !== 0 || !fallback.stdout.trim()) return []
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
 * Merge worktree branch into repository main branch (--no-ff) upon acceptance (#212).
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

  if (targetBranch && !isSafeBranchName(targetBranch)) {
    return { success: false, merged: false, error: 'invalid-target-branch' }
  }

  // 1. Verify worktree cleanliness
  const dirtyCheck = await checkWorktreeDirty({ worktreePath: task.worktree, gitRunner })
  if (dirtyCheck.error) {
    return { success: false, merged: false, error: 'worktree-status-error', detail: dirtyCheck.error }
  }
  if (dirtyCheck.dirty) {
    return { success: false, merged: false, error: 'worktree-dirty', files: dirtyCheck.files }
  }

  // 2. Locate main repository root
  let mainRepoDir = ''
  const revParse = await gitRunner(['rev-parse', '--git-common-dir'], task.worktree)
  if ((revParse?.exitCode ?? revParse?.code ?? 0) === 0 && revParse.stdout.trim()) {
    const commonDir = revParse.stdout.trim()
    mainRepoDir = commonDir.endsWith('/.git') ? commonDir.slice(0, -5) : commonDir
  }

  if (!mainRepoDir) {
    return { success: false, merged: false, error: 'main-repo-not-found' }
  }

  // Repository ownership fence: main repository name must match task.repo (#315)
  if (task.repo) {
    const expectedRepo = task.repo.trim()
    const baseName = basename(mainRepoDir)
    if (baseName !== expectedRepo && !mainRepoDir.endsWith('/' + expectedRepo) && !mainRepoDir.endsWith(sep + expectedRepo)) {
      return { success: false, merged: false, error: 'foreign-repository-mismatch' }
    }
  }

  const registered = await listWorktrees(mainRepoDir, gitRunner)
  const normTaskWorktree = resolve(task.worktree)
  if (!registered.some((p) => resolve(p) === normTaskWorktree)) {
    return { success: false, merged: false, error: 'worktree-not-registered' }
  }

  // 3. Resolve target merge branch
  let target = targetBranch
  if (target && !isSafeBranchName(target)) {
    return { success: false, merged: false, error: 'invalid-target-branch' }
  }
  if (!target) {
    target = await determineBaseRef(mainRepoDir, gitRunner)
  }
  if (!target || !isSafeBranchName(target)) target = 'main'

  // 4. Switch or verify target branch in main repository
  const currentBranch = await gitRunner(['branch', '--show-current'], mainRepoDir)
  if (currentBranch.stdout.trim() !== target) {
    const checkoutRes = await gitRunner(['checkout', '--', target], mainRepoDir)
    if ((checkoutRes?.exitCode ?? checkoutRes?.code ?? 0) !== 0) {
      return { success: false, merged: false, error: 'checkout-target-failed', detail: checkoutRes.stderr }
    }
  }

  // 5. Execute git merge --no-ff
  const mergeMsg = `Merge branch '${task.branch}' for task ${task.id}`
  const mergeRes = await gitRunner(['merge', '--no-ff', task.branch, '-m', mergeMsg], mainRepoDir)
  if ((mergeRes?.exitCode ?? mergeRes?.code ?? 0) !== 0) {
    // Roll back merge on conflict
    await gitRunner(['merge', '--abort'], mainRepoDir)
    return { success: false, merged: false, error: 'merge-conflict', detail: mergeRes.stderr || mergeRes.stdout }
  }

  // 6. Clean up task worktree
  await cleanupTaskWorktree({
    task,
    workspaceRegistry,
    gitRunner,
    force: true,
  })

  return { success: true, merged: true, targetBranch: target }
}


/**
 * Recursive discovery of git repositories within workspace directory (#210).
 *
 * @param {string} rootDir Root directory to scan
 * @param {{maxDepth?: number, maxRepos?: number, gitRunner?: Function}} options
 * @returns {Promise<Array<{relPath: string, fullPath: string, name: string}>>}
 */
export async function findWorkspaceGitRepos(rootDir, options = {}) {
  const maxDepth = options.maxDepth ?? 3
  const maxRepos = options.maxRepos ?? 20
  const gitRunner = options.gitRunner ?? defaultGitRunner

  if (!rootDir || !existsSync(rootDir)) return []

  const results = []

  async function scan(dir, depth) {
    if (depth > maxDepth || results.length >= maxRepos) return
    try {
      const isRepo = await isGitRepo(dir, gitRunner)
      if (isRepo) {
        const rel = relative(rootDir, dir) || '.'
        results.push({
          relPath: rel,
          fullPath: resolve(dir),
          name: basename(resolve(dir)),
        })
        // Do not recurse into nested non-root repositories
        if (depth > 0) return
      }

      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.worktrees') continue
        await scan(join(dir, entry.name), depth + 1)
      }
    } catch {
      // Ignore inaccessible directories
    }
  }

  await scan(rootDir, 0)
  return results
}

/**
 * Multi-repository mirror setup for workspaces with multiple git repositories (#210).
 *
 * @param {{task: object, workspacePath: string, gitRunner?: Function, config?: object}} options
 * @returns {Promise<{mirrors: Array<{repo: string, worktreePath: string, branch: string}>, errors?: Array<string>}>}
 */
export async function prepareMultiRepoMirror({ task, workspacePath, gitRunner = defaultGitRunner, config }) {
  if (!workspacePath || !existsSync(workspacePath)) {
    return { mirrors: [], errors: ['workspace-path-not-found'] }
  }

  const repos = await findWorkspaceGitRepos(workspacePath, { gitRunner })
  const mirrors = []
  const errors = []
  const branchName = resolveTaskBranch(task)

  for (const repo of repos) {
    try {
      const mirrorRoot = resolve(workspacePath, '.dsh-worktrees', task.id, repo.relPath === '.' ? 'root' : repo.relPath)
      const existing = await listWorktrees(repo.fullPath, gitRunner)
      if (existing.includes(mirrorRoot)) {
        mirrors.push({ repo: repo.name, worktreePath: mirrorRoot, branch: branchName, reused: true })
        continue
      }

      let branchExists = false
      try {
        await gitRunner(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], repo.fullPath)
        branchExists = true
      } catch {
        branchExists = false
      }

      if (branchExists) {
        await gitRunner(['worktree', 'add', mirrorRoot, branchName], repo.fullPath)
      } else {
        const baseRef = await determineBaseRef(repo.fullPath, gitRunner)
        await gitRunner(['worktree', 'add', '-b', branchName, mirrorRoot, baseRef], repo.fullPath)
      }
      mirrors.push({ repo: repo.name, worktreePath: mirrorRoot, branch: branchName, created: true })
    } catch (err) {
      errors.push(`${repo.name}: ${err?.message || 'failed'}`)
    }
  }

  return { mirrors, errors: errors.length > 0 ? errors : undefined }
}

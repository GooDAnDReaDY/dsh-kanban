import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import {
  slugify,
  safeRepoKey,
  resolveWorktreeRoot,
  resolveTaskWorktreePath,
  resolveTaskBranch,
  isGitRepo,
  listWorktrees,
  determineBaseRef,
  createTaskWorktree,
  checkWorktreeDirty,
  removeTaskWorktree,
  registerDshWorkspace,
  deregisterDshWorkspace,
  cleanupTaskWorktree,
} from '../lib/worktree.js'
import { freshStore } from './helpers.mjs'

test('slugify формирует безопасную строку', () => {
  assert.equal(slugify('Fix user authentication'), 'fix-user-authentication')
  assert.equal(slugify('[fix] #123: super / great! -- test'), 'fix-123-super-great-test')
  assert.equal(slugify('Починка бага в сессиях'), 'починка-бага-в-сессиях')
  assert.equal(slugify(''), 'task')
  assert.equal(slugify(null), 'task')
})

test('safeRepoKey собирает ключ с владельцем или без', () => {
  assert.equal(safeRepoKey({ owner: 'goodandready', repo: 'dsh-kanban' }), 'goodandready_dsh-kanban')
  assert.equal(safeRepoKey({ repo: 'my-repo' }), 'my-repo')
  assert.equal(safeRepoKey({}), 'local')
})

test('resolveWorktreeRoot учитывает приоритет настроек и окружения', () => {
  // Настройка в config побеждает
  const fromConfig = resolveWorktreeRoot({ worktreeRoot: '/custom/worktrees' })
  assert.equal(fromConfig, resolve('/custom/worktrees'))

  // DSH_HOME в env
  const fromEnv = resolveWorktreeRoot({}, { DSH_HOME: '/dsh' })
  assert.equal(fromEnv, resolve('/dsh/worktrees'))

  // defaultProjectRoot
  const fromProject = resolveWorktreeRoot({ defaultProjectRoot: '/projects' }, {})
  assert.equal(fromProject, resolve('/projects/.worktrees'))

  // Fallback на cwd
  const fromCwd = resolveWorktreeRoot({}, {}, () => '/work')
  assert.equal(fromCwd, resolve('/work/.worktrees'))
})

test('resolveTaskWorktreePath строит путь и защищает от выхода за пределы', () => {
  const task = { id: 'task-123', owner: 'org', repo: 'proj' }
  const path = resolveTaskWorktreePath({ task, config: { worktreeRoot: '/worktrees' } })
  assert.equal(path, resolve('/worktrees/org_proj/task-123'))

  // Попытка path traversal в id
  assert.throws(() => {
    resolveTaskWorktreePath({
      task: { id: '../../etc', repo: 'proj' },
      config: { worktreeRoot: '/worktrees' },
    })
  })
})

test('resolveTaskBranch использует issueNumber или префикс id', () => {
  assert.equal(
    resolveTaskBranch({ issueNumber: 193, title: 'Worktree isolation' }),
    'task/193-worktree-isolation',
  )
  assert.equal(
    resolveTaskBranch({ id: 'abcdef12-3456-7890', title: 'Local task' }),
    'task/abcdef12-local-task',
  )
})

test('isGitRepo проверяет признак git-репозитория', async () => {
  const gitOk = async () => ({ stdout: 'true', stderr: '', code: 0 })
  assert.equal(await isGitRepo('/some/dir', gitOk), true)

  const gitFail = async () => { throw new Error('not a git repo') }
  assert.equal(await isGitRepo('/not/git', gitFail), false)
  assert.equal(await isGitRepo(null, gitOk), false)
})

test('listWorktrees парсит вывод porcelain', async () => {
  const runner = async () => ({
    stdout: 'worktree /root/repo\nHEAD abc\n\nworktree /root/worktrees/task-1\nHEAD def\n',
    stderr: '',
    code: 0,
  })
  const list = await listWorktrees('/root/repo', runner)
  assert.equal(list.length, 2)
  assert.equal(list[0], resolve('/root/repo'))
  assert.equal(list[1], resolve('/root/worktrees/task-1'))
})

test('determineBaseRef перебирает кандидатов по приоритету', async () => {
  const seen = []
  const runner = async (args) => {
    seen.push(args[3])
    if (args[3] === 'origin/main') throw new Error('missing')
    if (args[3] === 'main') return { stdout: 'hash', stderr: '', code: 0 }
    throw new Error('missing')
  }
  const ref = await determineBaseRef('/repo', runner)
  assert.equal(ref, 'main')
  assert.deepEqual(seen, ['origin/main', 'origin/master', 'main'])
})

test('createTaskWorktree переиспользует уже созданное воркдерево', async () => {
  const calls = []
  const task = { id: 't1', repo: 'r', title: 'Test' }
  const runner = async (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { stdout: 'true' }
    if (args[0] === 'worktree' && args[1] === 'list') {
      const p = resolveTaskWorktreePath({ task, config: { defaultProjectRoot: '/proj' }, cwdOf: () => '/proj' })
      return { stdout: `worktree ${p}\nHEAD 123\n` }
    }
    return { stdout: '' }
  }

  const res = await createTaskWorktree({
    task,
    repoDir: '/proj/r',
    config: { defaultProjectRoot: '/proj' },
    gitRunner: runner,
    cwdOf: () => '/proj',
  })

  assert.equal(res.reused, true)
  assert.ok(res.worktreePath.endsWith('t1'))
})

test('createTaskWorktree создаёт новое воркдерево с новой веткой', async () => {
  const calls = []
  const task = { id: 't2', issueNumber: 10, repo: 'r', title: 'Feature' }
  const runner = async (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { stdout: 'true' }
    if (args[0] === 'worktree' && args[1] === 'list') return { stdout: 'worktree /proj/r\n' }
    if (args[0] === 'rev-parse' && args[3] === 'refs/heads/task/10-feature') throw new Error('not found')
    if (args[0] === 'rev-parse' && args[3] === 'origin/main') return { stdout: 'hash' }
    return { stdout: '' }
  }

  const res = await createTaskWorktree({
    task,
    repoDir: '/proj/r',
    config: { defaultProjectRoot: '/proj' },
    gitRunner: runner,
    cwdOf: () => '/proj',
  })

  assert.equal(res.created, true)
  assert.equal(res.branchName, 'task/10-feature')
  const addCmd = calls.find((c) => c.includes('worktree add -b task/10-feature'))
  assert.ok(addCmd, 'команда worktree add -b вызвана')
})

test('checkWorktreeDirty различает чистое и изменённое воркдерево', async () => {
  // Несуществующий каталог
  const notExist = await checkWorktreeDirty({ worktreePath: '/does-not-exist' })
  assert.equal(notExist.dirty, false)

  // Чистый репозиторий
  const cleanRunner = async () => ({ stdout: '' })
  const clean = await checkWorktreeDirty({ worktreePath: process.cwd(), gitRunner: cleanRunner })
  assert.equal(clean.dirty, false)
  assert.deepEqual(clean.files, [])

  // Изменённые файлы
  const dirtyRunner = async () => ({ stdout: ' M file.js\n?? new.txt\n' })
  const dirty = await checkWorktreeDirty({ worktreePath: process.cwd(), gitRunner: dirtyRunner })
  assert.equal(dirty.dirty, true)
  assert.deepEqual(dirty.files, ['M file.js', '?? new.txt'])
})

test('removeTaskWorktree блокирует удаление при dirty без force', async () => {
  const dirtyRunner = async (args) => {
    if (args[0] === 'status') return { stdout: ' M dirty.js\n' }
    return { stdout: '' }
  }
  const res = await removeTaskWorktree({
    repoDir: '/repo',
    worktreePath: process.cwd(),
    branchName: 'task/1-test',
    force: false,
    gitRunner: dirtyRunner,
  })
  assert.equal(res.removed, false)
  assert.equal(res.error, 'worktree-dirty')
  assert.deepEqual(res.files, ['M dirty.js'])
})

test('removeTaskWorktree удаляет с force и удаляет ветку', async () => {
  const calls = []
  const runner = async (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'status') return { stdout: ' M dirty.js\n' }
    return { stdout: '' }
  }
  const res = await removeTaskWorktree({
    repoDir: '/repo',
    worktreePath: process.cwd(),
    branchName: 'task/1-test',
    force: true,
    gitRunner: runner,
  })
  assert.equal(res.removed, true)
  assert.ok(calls.includes('worktree remove --force ' + process.cwd()))
  assert.ok(calls.includes('worktree prune'))
  assert.ok(calls.includes('branch -d task/1-test'))
})

test('registerDshWorkspace и deregisterDshWorkspace вызывают workspaceRegistry', async () => {
  let createdTitle, createdPath, deletedId
  const stubRegistry = {
    async create(path, title) {
      createdPath = path
      createdTitle = title
      return { id: 'ws-99' }
    },
    async delete(id) {
      deletedId = id
      return true
    },
  }

  const id = await registerDshWorkspace({
    workspaceRegistry: stubRegistry,
    worktreePath: '/path/to/wt',
    title: 'My Title',
  })
  assert.equal(id, 'ws-99')
  assert.equal(createdPath, '/path/to/wt')
  assert.equal(createdTitle, 'My Title')

  const delRes = await deregisterDshWorkspace({
    workspaceRegistry: stubRegistry,
    workspaceId: 'ws-99',
  })
  assert.equal(delRes, true)
  assert.equal(deletedId, 'ws-99')
})

test('cleanupTaskWorktree проводит полный цикл безопасной очистки', async () => {
  const { store, cleanup } = freshStore()
  let deletedWsId

  const stubRegistry = {
    async delete(id) {
      deletedWsId = id
      return true
    },
  }

  const task = store.createTask({
    board: 'main',
    column: 'cleanup',
    title: 'Done task',
    repo: 'r',
    worktree: process.cwd(),
    branch: 'task/done-1',
    workspaceId: 'ws-123',
  })

  // Чистый воркдерево
  const cleanRunner = async (args) => {
    if (args[0] === 'status') return { stdout: '' }
    return { stdout: '' }
  }

  const res = await cleanupTaskWorktree({
    store,
    task,
    workspaceRegistry: stubRegistry,
    gitRunner: cleanRunner,
  })

  assert.equal(res.success, true)
  assert.equal(res.removed, true)
  assert.equal(deletedWsId, 'ws-123')

  const after = store.getTask(task.id)
  assert.equal(after.worktree, '')
  assert.equal(after.workspaceId, '')

  const transitions = store.listTransitions(task.id)
  assert.ok(transitions.some((t) => t.detail.includes('очистка: воркдерево удалено')))

  cleanup()
})

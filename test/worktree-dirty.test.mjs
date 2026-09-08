import test from 'node:test'
import assert from 'node:assert/strict'
import { checkWorktreeDirty } from '../lib/worktree.js'

test('checkWorktreeDirty игнорирует субмодули и gitlink drift (#213)', async () => {
  // 1. Имитация вывода git status с субмодулем (дрейф gitlink)
  const submoduleRunner = async (args) => {
    assert.ok(args.includes('--ignore-submodules=all'), 'должен передавать флаг --ignore-submodules=all')
    return { stdout: '' }
  }

  const res = await checkWorktreeDirty({
    worktreePath: process.cwd(),
    gitRunner: submoduleRunner,
  })
  assert.equal(res.dirty, false, 'чистый репозиторий с субмодулями не должен быть dirty')
  assert.deepEqual(res.files, [])

  // 2. Реальные изменения файлов должны по-прежнему фиксироваться как dirty
  const dirtyRunner = async () => ({
    stdout: ' M lib/index.js\n?? test/new.test.mjs\n',
  })

  const dirtyRes = await checkWorktreeDirty({
    worktreePath: process.cwd(),
    gitRunner: dirtyRunner,
  })
  assert.equal(dirtyRes.dirty, true, 'измененные файлы проекта должны делать воркдерево dirty')
  assert.deepEqual(dirtyRes.files, ['M lib/index.js', '?? test/new.test.mjs'])
})
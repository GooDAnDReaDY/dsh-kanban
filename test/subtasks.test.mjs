import test from 'node:test'
import assert from 'node:assert/strict'
import { freshStore, reopenStore } from './helpers.mjs'

test('createTask sets parentId and isEpic properly', () => {
  const { store, cleanup } = freshStore()
  const epic = store.createTask({
    title: 'Epic Task',
    isEpic: true,
  })
  assert.equal(epic.isEpic, true)
  assert.equal(epic.parentId, '')

  const sub = store.createTask({
    title: 'Subtask 1',
    parentId: epic.id,
  })
  assert.equal(sub.parentId, epic.id)
  assert.equal(sub.isEpic, false)
  cleanup()
})

test('listSubtasks and countSubtasks track subtasks and their completion', () => {
  const { store, cleanup } = freshStore()
  const epic = store.createTask({ title: 'Epic 1', isEpic: true })
  
  assert.deepEqual(store.listSubtasks(epic.id), [])
  assert.deepEqual(store.countSubtasks(epic.id), { total: 0, completed: 0 })

  const sub1 = store.createTask({ title: 'Sub 1', parentId: epic.id, column: 'backlog', createdAt: 100 })
  const sub2 = store.createTask({ title: 'Sub 2', parentId: epic.id, column: 'in-progress', createdAt: 200 })
  const sub3 = store.createTask({ title: 'Sub 3', parentId: epic.id, column: 'done', createdAt: 300 })

  const subs = store.listSubtasks(epic.id)
  assert.equal(subs.length, 3)
  assert.equal(subs[0].id, sub1.id)
  assert.equal(subs[1].id, sub2.id)
  assert.equal(subs[2].id, sub3.id)

  const count = store.countSubtasks(epic.id)
  assert.equal(count.total, 3)
  assert.equal(count.completed, 1)

  // Move sub2 to done
  store.moveTask(sub2.id, { column: 'done' })
  assert.deepEqual(store.countSubtasks(epic.id), { total: 3, completed: 2 })

  cleanup()
})

test('updateTask and setParent update parentId and isEpic', () => {
  const { store, cleanup } = freshStore()
  const t1 = store.createTask({ title: 'Task 1' })
  const t2 = store.createTask({ title: 'Task 2' })

  assert.equal(t1.isEpic, false)
  assert.equal(t2.parentId, '')

  store.updateTask(t1.id, { isEpic: true })
  assert.equal(store.getTask(t1.id).isEpic, true)

  store.setParent(t2.id, t1.id)
  assert.equal(store.getTask(t2.id).parentId, t1.id)

  store.setParent(t2.id, '')
  assert.equal(store.getTask(t2.id).parentId, '')
  cleanup()
})

test('subtasks persist after store reload', () => {
  const { store, dir, cleanup } = freshStore()
  const epic = store.createTask({ title: 'Epic P', isEpic: true })
  store.createTask({ title: 'Child P', parentId: epic.id })
  store.close()

  const reopened = reopenStore(dir)
  const loadedEpic = reopened.getTask(epic.id)
  assert.equal(loadedEpic.isEpic, true)
  const children = reopened.listSubtasks(epic.id)
  assert.equal(children.length, 1)
  assert.equal(children[0].title, 'Child P')
  reopened.close()
  cleanup()
})

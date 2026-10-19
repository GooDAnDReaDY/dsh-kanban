import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.js";
import { handleTaskNudge } from "../lib/routes.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "dkb-test-nudge-"));
  const store = openStore({ dir });
  return { store, cleanup: () => { try { store.close() } catch {} rmSync(dir, { recursive: true, force: true }) } };
}

test("handleTaskNudge: валидация параметров и обработка ошибок (#373)", async () => {
  const { store, cleanup } = freshStore();

  // Отсутствие store или id
  let res = await handleTaskNudge({ store: null, id: "t1", prompt: "hello" });
  assert.equal(res.status, 400);

  res = await handleTaskNudge({ store, id: null, prompt: "hello" });
  assert.equal(res.status, 400);

  // Задача не найдена
  res = await handleTaskNudge({ store, id: "non-existent", prompt: "hello" });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "task-not-found");

  const taskNoSession = store.createTask({ title: "Task 1" });

  // Пустой prompt
  res = await handleTaskNudge({ store, id: taskNoSession.id, prompt: "   " });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "prompt-required");

  // Задача без сессии
  res = await handleTaskNudge({ store, id: taskNoSession.id, prompt: "Focus on tests" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "no-session");

  // Сессия не жива (агент не найден в агентах)
  const taskWithSession = store.createTask({ title: "Task 2", sessionId: "sess-123" });
  res = await handleTaskNudge({
    store,
    id: taskWithSession.id,
    prompt: "Focus on tests",
    agents: new Map(),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "session-not-live");

  cleanup();
});

test("handleTaskNudge: успешное направление агента (followup, комментарий, broadcast) (#373)", async () => {
  const { store, cleanup } = freshStore();
  const task = store.createTask({
    title: "Steerable Task",
    sessionId: "sess-active-1",
    column: "in-progress",
  });

  const sentMessages = [];
  const fakeAgent = {
    followup: (msg) => { sentMessages.push(msg); },
  };

  const agents = {
    get: (id) => (id === "sess-active-1" ? fakeAgent : null),
  };

  const broadcasts = [];
  const eventHub = {
    broadcast: (event, payload) => { broadcasts.push({ event, payload }); },
  };

  const res = await handleTaskNudge({
    store,
    id: task.id,
    prompt: "Please verify edge cases for empty arrays",
    agents,
    eventHub,
    createMessage: ({ content, source }) => ({ custom: true, content, source }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.id, task.id);
  assert.equal(res.body.sessionId, "sess-active-1");
  assert.equal(res.body.prompt, "Please verify edge cases for empty arrays");

  // Проверяем, что агент получил followup сообщение
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].custom, true);
  assert.equal(sentMessages[0].content[0].text, "Please verify edge cases for empty arrays");
  assert.equal(sentMessages[0].source.form, "task-nudge");

  // Проверяем, что к задаче добавлен комментарий
  const updatedTask = store.getTask(task.id);
  assert.ok(Array.isArray(updatedTask.comments));
  assert.equal(updatedTask.comments.length, 1);
  assert.match(updatedTask.comments[0].text, /\[Steering Nudge\] Please verify edge cases/);

  // Проверяем broadcast
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].event, "task:change");
  assert.equal(broadcasts[0].payload.id, task.id);

  cleanup();
});

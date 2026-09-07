import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.js";
import { boardCommentsDefinition, boardCommentAddDefinition } from "../lib/board-tool.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "dkb-test-comments-"));
  const store = openStore({ dir });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("комментарии: добавление человеком и агентом, чтение треда (#208)", async () => {
  const { store, cleanup } = freshStore();
  const task = store.createTask({
    title: "Задача с обсуждением",
    sessionId: "sess-comm-1",
  });

  const readTool = boardCommentsDefinition({ store });
  const addTool = boardCommentAddDefinition({ store });
  const exec = { agent: { session: { id: "sess-comm-1" } } };

  // До комментариев
  const empty = await readTool.execute({}, exec);
  assert.equal(empty, "No comments on this task yet.");

  // Человек оставляет комментарий
  store.addComment(task.id, { author: "vadim", role: "user", text: "Обрати внимание на производительность" });

  // Агент отвечает
  const addRes = await addTool.execute({ text: "Принято, добавлю бенчмарки" }, exec);
  assert.match(addRes, /Comment posted to task/);

  // Читаем ветку
  const thread = await readTool.execute({}, exec);
  assert.match(thread, /User/);
  assert.match(thread, /Обрати внимание на производительность/);
  assert.match(thread, /Agent/);
  assert.match(thread, /Принято, добавлю бенчмарки/);

  const saved = store.getTask(task.id);
  assert.equal(saved.comments.length, 2);
  assert.equal(saved.comments[0].role, "user");
  assert.equal(saved.comments[1].role, "agent");

  cleanup();
});

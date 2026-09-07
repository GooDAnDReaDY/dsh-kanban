import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.js";
import { boardMoveDefinition } from "../lib/board-tool.js";
import { resolveModel } from "../lib/launcher.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "dkb-test-accept-"));
  const store = openStore({ dir });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("протокольный шлюз: board_move запрещает агенту перемещение в done (#209)", async () => {
  const { store, cleanup } = freshStore();
  const task = store.createTask({
    title: "Самовольное закрытие",
    sessionId: "sess-gate-1",
    column: "review",
  });

  const tool = boardMoveDefinition({ store });
  const exec = { agent: { session: { id: "sess-gate-1" } } };

  const blocked = await tool.execute({ column: "done" }, exec);
  assert.match(blocked, /The done column is a human-only acceptance boundary/);
  assert.equal(store.getTask(task.id).column, "review");

  cleanup();
});

test("двусторонний цикл приемки: reject возвращает карточку и логирует причину (#207)", () => {
  const { store, cleanup } = freshStore();
  const task = store.createTask({
    title: "Приемка задачи",
    column: "review",
  });

  // Человек отклоняет работу
  const rejected = store.rejectTask(task.id, "Отсутствуют unit-тесты для крайних случаев");
  assert.equal(rejected.column, "in-progress");
  assert.equal(rejected.rejectReason, "Отсутствуют unit-тесты для крайних случаев");
  assert.ok(rejected.rejectedAt > 0);

  // Проверяем добавление комментария
  assert.ok(rejected.comments.length > 0);
  assert.match(rejected.comments[0].text, /Отсутствуют unit-тесты/);

  // Проверяем историю переходов
  const transitions = store.listTransitions(task.id);
  const last = transitions[transitions.length - 1];
  assert.equal(last.toCol, "in-progress");
  assert.match(last.detail, /Rejected: Отсутствуют unit-тесты/);

  // Человек принимает исправленную задачу
  const accepted = store.acceptTask(task.id);
  assert.equal(accepted.column, "done");
  assert.equal(accepted.rejectReason, "");
  assert.equal(accepted.rejectedAt, 0);

  const finalTransitions = store.listTransitions(task.id);
  const doneTr = finalTransitions[finalTransitions.length - 1];
  assert.equal(doneTr.toCol, "done");
  assert.equal(doneTr.detail, "Accepted by human");

  cleanup();
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.js";
import { boardChecklistDefinition, boardMoveDefinition } from "../lib/board-tool.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "dkb-test-checklist-"));
  const store = openStore({ dir });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("DoD checklist сохраняется и обновляется в карточке", () => {
  const { store, cleanup } = freshStore();
  const task = store.createTask({
    title: "Тестовая задача",
    checklist: [
      { text: "Написать тесты", required: true, completed: false },
      { text: "Обновить документацию", required: true, completed: false },
    ],
  });
  assert.equal(task.checklist.length, 2);
  assert.equal(task.checklist[0].completed, false);

  const updated = store.updateChecklist(task.id, [
    { text: "Написать тесты", required: true, completed: true, evidence: "node --test passed" },
    { text: "Обновить документацию", required: true, completed: false },
  ]);
  assert.equal(updated.checklist[0].completed, true);
  assert.equal(updated.checklist[0].evidence, "node --test passed");
  cleanup();
});

test("board_checklist инструмент отмечает пункт выполненным с evidence", async () => {
  const { store, cleanup } = freshStore();
  const task = store.createTask({
    title: "Фича X",
    sessionId: "sess-1",
    checklist: [
      { text: "Покрыть unit-тестами", required: true, completed: false },
      { text: "Проверить линтер", required: false, completed: false },
    ],
  });

  const tool = boardChecklistDefinition({ store });
  const exec = { agent: { session: { id: "sess-1" } } };

  // Ошибка при отсутствии evidence
  const failEv = await tool.execute({ item: 1, evidence: "" }, exec);
  assert.match(failEv, /Evidence is required/);

  // Ошибка при неверном номере
  const failIdx = await tool.execute({ item: 5, evidence: "ok" }, exec);
  assert.match(failIdx, /Invalid item 5/);

  // Успешная отметка
  const res = await tool.execute({ item: 1, evidence: "34 tests pass" }, exec);
  assert.match(res, /marked as completed/);
  assert.match(res, /Progress: 1\/2/);

  const saved = store.getTask(task.id);
  assert.equal(saved.checklist[0].completed, true);
  assert.equal(saved.checklist[0].evidence, "34 tests pass");
  assert.ok(saved.checklist[0].completedAt > 0);
  cleanup();
});

test("board_move блокирует перевод в review при незакрытых обязательных DoD (#205)", async () => {
  const { store, cleanup } = freshStore();
  const task = store.createTask({
    title: "Задача с DoD",
    sessionId: "sess-2",
    column: "in-progress",
    checklist: [
      { text: "Тест 1", required: true, completed: false },
      { text: "Необязательный пункт", required: false, completed: false },
    ],
  });

  const moveTool = boardMoveDefinition({ store });
  const exec = { agent: { session: { id: "sess-2" } } };

  // Попытка перевести в review с незакрытым DoD блокируется
  const blocked = await moveTool.execute({ column: "review" }, exec);
  assert.match(blocked, /Cannot move card to review: uncompleted required DoD checklist items/);
  assert.match(blocked, /Pending: Тест 1/);

  const checklistTool = boardChecklistDefinition({ store });
  await checklistTool.execute({ item: 1, evidence: "All tests pass" }, exec);

  // После закрытия обязательного пункта перевод разрешён
  const ok = await moveTool.execute({ column: "review" }, exec);
  assert.equal(ok, "Card moved to review.");
  assert.equal(store.getTask(task.id).column, "review");

  cleanup();
});

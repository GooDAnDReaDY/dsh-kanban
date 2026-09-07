import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.js";
import { boardReportDefinition } from "../lib/board-tool.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "dkb-test-report-"));
  const store = openStore({ dir });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("board_report валидирует наличие summary и сохраняет отчет (#206)", async () => {
  const { store, cleanup } = freshStore();
  const task = store.createTask({
    title: "Реализация фичи Z",
    sessionId: "sess-rep-1",
    column: "in-progress",
  });

  const tool = boardReportDefinition({ store });
  const exec = { agent: { session: { id: "sess-rep-1" } } };

  // Ошибка при пустом summary
  const fail = await tool.execute({ summary: "" }, exec);
  assert.match(fail, /A summary is required/);

  // Успешная сдача отчета
  const res = await tool.execute({
    summary: "Внедрена поддержка структурированных отчетов",
    changed_files: ["lib/store.js", "lib/board-tool.js"],
    checks_run: ["node --test test/report.test.mjs (PASS)"],
    artifacts: ["tarball-0.1.29.tgz"],
    risks: ["Необходимо проверить поддержку старых версий"],
  }, exec);

  assert.match(res, /Execution report for task "Реализация фичи Z" saved successfully/);

  const saved = store.getTask(task.id);
  assert.equal(saved.report.summary, "Внедрена поддержка структурированных отчетов");
  assert.deepEqual(saved.report.changedFiles, ["lib/store.js", "lib/board-tool.js"]);
  assert.deepEqual(saved.report.checksRun, ["node --test test/report.test.mjs (PASS)"]);
  assert.deepEqual(saved.report.artifacts, ["tarball-0.1.29.tgz"]);
  assert.deepEqual(saved.report.risks, ["Необходимо проверить поддержку старых версий"]);
  assert.ok(saved.report.createdAt > 0);

  cleanup();
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  isRemoteMode,
  quoteArg,
  buildSshArgs,
  createRemoteGitRunner,
  testRemoteConnection,
  remotePathExists,
} from "../lib/remote-runner.js";

test("isRemoteMode: корректное распознавание конфигурации (#390)", () => {
  assert.equal(isRemoteMode(null), false);
  assert.equal(isRemoteMode({}), false);
  assert.equal(isRemoteMode({ remoteMode: false }), false);
  assert.equal(isRemoteMode({ remoteMode: true }), true);
});

test("quoteArg: безопасное экранирование аргументов для POSIX shell (#390)", () => {
  assert.equal(quoteArg("simple"), "'simple'");
  assert.equal(quoteArg("with spaces"), "'with spaces'");
  assert.equal(quoteArg("has'quote"), "'has'\\''quote'");
  assert.equal(quoteArg(""), "''");
  assert.equal(quoteArg(123), "'123'");
  assert.equal(quoteArg(null), "''");
});

test("buildSshArgs: сборка аргументов команды ssh (#390)", () => {
  const cfg = {
    remoteHost: "192.168.1.111",
    remotePort: 22,
    remoteUser: "migrate",
    remoteKeyPath: "/home/user/.ssh/id_rsa",
    remoteSudoUser: "vadim",
  };

  const args = buildSshArgs(cfg, "git status");
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("22"));
  assert.ok(args.includes("-i"));
  assert.ok(args.includes("/home/user/.ssh/id_rsa"));
  assert.ok(args.includes("migrate@192.168.1.111"));

  const lastArg = args[args.length - 1];
  assert.match(lastArg, /sudo -u vadim -H bash -c 'git status'/);

  // Без sudo пользователя
  const cfgNoSudo = { ...cfg, remoteSudoUser: "" };
  const argsNoSudo = buildSshArgs(cfgNoSudo, "git status");
  assert.equal(argsNoSudo[argsNoSudo.length - 1], "git status");
});

test("createRemoteGitRunner: делегирование в локальный runner при remoteMode=false (#390)", async () => {
  let calledLocal = false;
  const localRunner = async (args, cwd) => {
    calledLocal = true;
    return { stdout: "local-ok", stderr: "" };
  };

  const runner = createRemoteGitRunner({ remoteMode: false }, localRunner);
  const res = await runner(["status"], "/tmp");
  assert.equal(calledLocal, true);
  assert.equal(res.stdout, "local-ok");
});

test("testRemoteConnection: fail-soft обработка ошибок подключения (#390)", async () => {
  // Заведомо недоступный хост
  const badCfg = {
    remoteMode: true,
    remoteHost: "127.0.0.1",
    remotePort: 54321,
    remoteUser: "nonexistent",
  };

  const res = await testRemoteConnection(badCfg);
  assert.equal(res.ok, false);
  assert.ok(typeof res.error === "string");
});

test("remotePathExists: возврат boolean без исключений (#390)", async () => {
  const badCfg = {
    remoteMode: true,
    remoteHost: "127.0.0.1",
    remotePort: 54321,
  };

  const exists = await remotePathExists("/invalid/path", badCfg);
  assert.equal(exists, false);
});

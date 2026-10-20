import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldRelay,
  getRemoteServerUrl,
  buildRemoteHeaders,
  relayRequest,
  testRemoteServer,
} from "../lib/remote-relay.js";

test("shouldRelay: проверка условий проксирования (#390)", () => {
  assert.equal(shouldRelay(null), false);
  assert.equal(shouldRelay({}), false);
  assert.equal(shouldRelay({ remoteMode: true }), false);
  assert.equal(shouldRelay({ remoteMode: false, remoteServerUrl: "http://111:3080" }), false);
  assert.equal(shouldRelay({ remoteMode: true, remoteServerUrl: "http://111:3080" }), true);
});

test("getRemoteServerUrl: нормализация путей и URL (#390)", () => {
  const cfg = { remoteServerUrl: "http://192.168.1.111:3080/" };
  assert.equal(getRemoteServerUrl(cfg, "/dsh-kanban/board"), "http://192.168.1.111:3080/dsh-kanban/board");
  assert.equal(getRemoteServerUrl(cfg, "dsh-kanban/board"), "http://192.168.1.111:3080/dsh-kanban/board");
  assert.equal(getRemoteServerUrl(cfg, ""), "http://192.168.1.111:3080");
});

test("buildRemoteHeaders: добавление заголовков и токенов (#390)", () => {
  const cfgNoToken = { remoteServerToken: "" };
  const h1 = buildRemoteHeaders(cfgNoToken);
  assert.equal(h1["Accept"], "application/json, text/plain, */*");
  assert.equal(h1["Authorization"], undefined);

  const cfgToken = { remoteServerToken: "secret-token-xyz" };
  const h2 = buildRemoteHeaders(cfgToken, { "content-type": "application/json" });
  assert.equal(h2["Authorization"], "Bearer secret-token-xyz");
  assert.equal(h2["Cookie"], "dsh_token=secret-token-xyz");
  assert.equal(h2["Content-Type"], "application/json");
});

test("relayRequest: корректная обработка недоступного сервера (503) (#390)", async () => {
  const cfg = {
    remoteMode: true,
    remoteServerUrl: "http://127.0.0.1:54322",
  };

  const res = await relayRequest({
    config: cfg,
    path: "/dsh-kanban/board",
    method: "GET",
    timeoutMs: 1500,
  });

  assert.equal(res.status, 503);
  assert.equal(res.body.error, "remote-server-unavailable");
  assert.ok(res.body.detail.includes("Failed to reach remote DSH server"));
});

test("testRemoteServer: возврат ошибки при недоступном сервере (#390)", async () => {
  const cfg = {
    remoteMode: true,
    remoteServerUrl: "http://127.0.0.1:54322",
  };

  const probe = await testRemoteServer(cfg);
  assert.equal(probe.ok, false);
  assert.ok(typeof probe.error === "string");
  assert.ok(probe.latencyMs >= 0);
});

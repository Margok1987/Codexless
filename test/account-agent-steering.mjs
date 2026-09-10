import assert from "node:assert/strict";
import test from "node:test";
import { CodexAccountAgentExecutor } from "../src/codex-account-agent-executor.mjs";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture({ maxControlBindings = 100, uncertain = false } = {}) {
  const clients = new Map();
  const hooksByAccount = new Map();
  const registry = { source: "registry", accounts: [{ id: "primary" }, { id: "secondary" }] };
  const pool = new CodexAccountAgentExecutor({
    registry,
    factory: async (account, hooks) => {
      hooksByAccount.set(account.id, hooks);
      const client = {
        running: false, requests: [], beforeRefresh: null, holdSteer: false,
        steerEntered: gate(), steerRelease: gate(),
        async start() { this.running = true; return {}; },
        async close() { this.running = false; this.steerRelease.resolve(); },
        onNotification() { return () => {}; },
        async request(method, params) {
          this.requests.push({ method, params: structuredClone(params) });
          if (method === "thread/start") return { thread: { id: `thread-${account.id}` }, model: "fixture" };
          if (method === "turn/start") return { turn: { id: `turn-${account.id}`, status: "inProgress" } };
          if (method === "thread/turns/list") {
            this.beforeRefresh?.();
            return { data: [{ id: `turn-${account.id}`, status: "inProgress", items: [] }] };
          }
          if (method === "turn/steer") {
            this.steerEntered.resolve();
            if (this.holdSteer) await this.steerRelease.promise;
            if (uncertain) throw new Error("fixture transport acceptance unknown");
            return { turnId: `turn-${account.id}` };
          }
          throw new Error(`unexpected fixture RPC ${method}`);
        },
      };
      clients.set(account.id, client);
      return new CodexAgentExecutor({
        defaultCwd: process.cwd(),
        clientFactory: () => client, maxControlBindings,
        admissionCheck: hooks.assertHealthy, cleanupFailureHandler: hooks.quarantine,
      });
    },
  });
  return { pool, clients, hooksByAccount };
}

const start = (pool, account) => pool.start({ account, task: "fixture", clientRequestId: `start-${account}` });
const steer = (snapshot, clientRequestId = "steer") => ({
  agentRef: snapshot.agentRef, expectedTurnId: snapshot.turnId, message: "finish this turn", clientRequestId,
});
const steerCalls = (client) => client.requests.filter(({ method }) => method === "turn/steer");

test("steering keeps the account binding and exact replay identity through the pool", async () => {
  const { pool, clients } = fixture();
  try {
    const primary = await start(pool, "primary");
    const secondary = await start(pool, "secondary");
    const input = steer(secondary);
    const [first, duplicate] = await Promise.all([pool.steer(input), pool.steer(input)]);
    assert.equal(first.account, "secondary");
    assert.equal(first.controlAcceptance, "accepted");
    assert.equal(duplicate.duplicate, true);
    assert.equal(steerCalls(clients.get("secondary")).length, 1);
    assert.equal(steerCalls(clients.get("primary")).length, 0);
    assert.deepEqual(steerCalls(clients.get("secondary"))[0].params, {
      threadId: "thread-secondary", expectedTurnId: "turn-secondary",
      clientUserMessageId: "steer", input: [{ type: "text", text: input.message }],
    });
    for (const changed of [
      { ...input, message: "different instruction" },
      { ...input, expectedTurnId: "different-turn" },
      steer(primary),
    ]) await assert.rejects(pool.steer(changed), { code: "CODEX_REQUEST_CONFLICT" });
    await assert.rejects(pool.steer({ ...input, account: "primary" }), { code: "CODEX_ACCOUNT_IMMUTABLE" });
    await assert.rejects(pool.steer({ ...input, clientRequestId: "stale", expectedTurnId: "old-turn" }), /turn changed/);
    assert.equal(steerCalls(clients.get("secondary")).length, 1);
  } finally { await pool.close(); }
});

test("uncertain account steering is never automatically replayed", async () => {
  const { pool, clients } = fixture({ uncertain: true });
  try {
    const input = steer(await start(pool, "secondary"));
    assert.equal((await pool.steer(input)).controlAcceptance, "unknown");
    const duplicate = await pool.steer(input);
    assert.equal(duplicate.controlAcceptance, "unknown");
    assert.equal(duplicate.duplicate, true);
    assert.equal(steerCalls(clients.get("secondary")).length, 1);
  } finally { await pool.close(); }
});

test("steering rechecks quarantine after official refresh and preserves other accounts", async () => {
  const { pool, clients, hooksByAccount } = fixture();
  try {
    const primary = await start(pool, "primary");
    const secondary = await start(pool, "secondary");
    clients.get("secondary").beforeRefresh = () => hooksByAccount.get("secondary").quarantine();
    await assert.rejects(pool.steer(steer(secondary)), { code: "CODEX_ACCOUNT_CLEANUP_FAILED" });
    assert.equal(steerCalls(clients.get("secondary")).length, 0);
    assert.equal((await pool.steer(steer(primary, "healthy-steer"))).controlAcceptance, "accepted");
  } finally {
    await assert.rejects(pool.close(), { code: "CODEX_ACCOUNT_CLEANUP_FAILED" });
  }
});

test("steering obeys delegate control capacity without evicting replay records", async () => {
  const { pool, clients } = fixture({ maxControlBindings: 1 });
  try {
    const snapshot = await start(pool, "secondary");
    await pool.steer(steer(snapshot));
    await assert.rejects(pool.steer(steer(snapshot, "overflow")), { code: "CODEX_AGENT_CAPACITY" });
    assert.equal((await pool.steer(steer(snapshot))).duplicate, true);
    assert.equal(steerCalls(clients.get("secondary")).length, 1);
  } finally { await pool.close(); }
});

test("close drains in-flight account steering and prevents later dispatch", async () => {
  const { pool, clients } = fixture();
  const snapshot = await start(pool, "secondary");
  const client = clients.get("secondary");
  client.holdSteer = true;
  const pending = pool.steer(steer(snapshot));
  const rejected = assert.rejects(pending, /not open|closed/);
  await client.steerEntered.promise;
  await pool.close();
  await rejected;
  await assert.rejects(pool.steer(steer(snapshot, "after-close")), /closed/);
  assert.equal(client.running, false);
  assert.equal(steerCalls(client).length, 1);
});

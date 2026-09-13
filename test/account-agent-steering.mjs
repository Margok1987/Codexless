import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { CodexAccountAgentExecutor } from "../src/codex-account-agent-executor.mjs";
import { computeCodexAuthorityPolicyHash } from "../src/codex-authority-executor.mjs";
import { createAccountBoundFormalAgentAuthorityExecutor } from "../src/codexless-runtime.mjs";
import { createFormalAgentAccountContext } from "../src/formal-agent-account-context.mjs";
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

test("formal authority hash ignores presentation and unrelated project trust but preserves relevant trust", () => {
  const cwd = process.cwd();
  const unrelated = path.resolve(cwd, "..", "unrelated-authority-fixture");
  const common = {
    permissionRows: [{ id: ":read-only", allowed: true, sandboxMode: "readOnly", approvalPolicy: "never" }],
    authorityProfile: { permissionProfile: ":read-only", permissionCeiling: ":read-only" },
    started: { cwd, thread: { id: "probe", cwd }, activePermissionProfile: { id: ":read-only" } },
  };
  const first = {
    ...common,
    effectiveConfig: {
      desktop: { conversationDetailMode: "STEPS_COMMANDS" },
      projects: { [cwd]: { trust_level: "trusted" } },
    },
  };
  const harmless = {
    ...common,
    effectiveConfig: {
      desktop: { conversationDetailMode: "STEPS_PROSE" },
      projects: {
        [cwd]: { trust_level: "trusted" },
        [unrelated]: { trust_level: "trusted" },
      },
    },
  };
  assert.equal(computeCodexAuthorityPolicyHash(first), computeCodexAuthorityPolicyHash(harmless));
  const relevantDrift = structuredClone(harmless);
  relevantDrift.effectiveConfig.projects[cwd].trust_level = "untrusted";
  assert.notEqual(computeCodexAuthorityPolicyHash(first), computeCodexAuthorityPolicyHash(relevantDrift));
});

test("formal account context binds start and commit authority to the existing task account", async () => {
  const taskState = { taskRecords: new Map() };
  const accountExecutor = { resolveAccountId(account) { if (!account) throw new Error("account required"); return account; } };
  const context = createFormalAgentAccountContext({ agentPreviewState: taskState, agentExecutor: accountExecutor });
  const host = {
    async resolveAuthority() {
      return { effectiveCwd: process.cwd(), permissionProfile: ":read-only", permissionCeiling: ":read-only", policyHash: "a".repeat(64) };
    },
  };
  const preparedAccounts = [];
  const authority = createAccountBoundFormalAgentAuthorityExecutor({
    hostAuthorityExecutor: host,
    agentExecutor: {
      async prepareAuthority(input) {
        preparedAccounts.push(input.account);
        return {
          effectiveCwd: input.cwd,
          permissionProfile: input.permissionProfile,
          permissionCeiling: input.permissionCeiling,
          securityPolicyHash: "a".repeat(64),
          policyHash: "b".repeat(64),
        };
      },
    },
    accountProvider: () => context.currentAccount(),
  });
  const startHandler = context.wrapToolHandler("codex.agent_start", async () => authority.resolveAuthority({ cwd: process.cwd(), access: "inherit" }));
  assert.equal((await startHandler({ account: "secondary" })).policyHash, "b".repeat(64));
  taskState.taskRecords.set("task", { taskId: "C-BOUND", payload: { account: "primary" } });
  const commitHandler = context.wrapToolHandler("codex.agent_commit", async () => authority.resolveAuthority({ cwd: process.cwd(), access: "inherit" }));
  assert.equal((await commitHandler({ taskId: "C-BOUND" })).policyHash, "b".repeat(64));
  assert.deepEqual(preparedAccounts, ["secondary", "primary"]);
});

test("prepared authority lease is stale after account delegate recreation", async () => {
  const delegates = [];
  let startCalls = 0;
  const pool = new CodexAccountAgentExecutor({
    registry: { source: "registry", accounts: [{ id: "primary" }, { id: "secondary" }] },
    preStartAuthorityCheck: async () => {},
    factory: async () => {
      const delegate = {
        running: false,
        async open() { this.running = true; },
        async close() { this.running = false; },
        async prepareAuthority(input) {
          return { ...input, effectiveCwd: input.cwd, policyHash: "c".repeat(64) };
        },
        async start() { startCalls += 1; return { agentRef: `agent-${startCalls}`, turnId: "turn", status: "running" }; },
      };
      delegates.push(delegate);
      return delegate;
    },
  });
  await pool.open();
  try {
    const prepared = await pool.prepareAuthority({ account: "secondary", cwd: process.cwd(), permissionProfile: ":read-only", permissionCeiling: ":read-only" });
    delegates[0].running = false;
    await assert.rejects(
      pool.start({ account: "secondary", cwd: process.cwd(), task: "stale", clientRequestId: "stale-lease", permissionProfile: ":read-only", permissionCeiling: ":read-only", authorityPolicyHash: prepared.policyHash }),
      (error) => error.code === "CODEX_AGENT_PREPARED_DELEGATE_STALE"
    );
    assert.equal(startCalls, 0);
    assert.equal(delegates.length, 2);
  } finally { await pool.close(); }
});

test("final account start rechecks host authority and unwraps only the bound security hash", async () => {
  let drift = false;
  let observedPolicyHash = null;
  const pool = new CodexAccountAgentExecutor({
    registry: { source: "registry", accounts: [{ id: "secondary" }] },
    preStartAuthorityCheck: async () => {
      if (drift) {
        const error = new Error("host authority drift");
        error.code = "CODEX_AGENT_SECURITY_POLICY_CHANGED";
        throw error;
      }
    },
    factory: async () => ({
      running: false,
      async open() { this.running = true; },
      async close() { this.running = false; },
      async prepareAuthority(input) { return { ...input, effectiveCwd: input.cwd, policyHash: "d".repeat(64) }; },
      async start(input) {
        observedPolicyHash = input.authorityPolicyHash;
        return { agentRef: "agent-bound", turnId: "turn-bound", status: "running" };
      },
    }),
  });
  await pool.open();
  try {
    const prepared = await pool.prepareAuthority({ account: "secondary", cwd: process.cwd(), permissionProfile: ":read-only", permissionCeiling: ":read-only" });
    assert.notEqual(prepared.policyHash, "d".repeat(64));
    await pool.start({ account: "secondary", cwd: process.cwd(), task: "ok", clientRequestId: "lease-ok", permissionProfile: ":read-only", permissionCeiling: ":read-only", authorityPolicyHash: prepared.policyHash });
    assert.equal(observedPolicyHash, "d".repeat(64));
  } finally { await pool.close(); }

  let attempted = 0;
  const driftPool = new CodexAccountAgentExecutor({
    registry: { source: "registry", accounts: [{ id: "secondary" }] },
    preStartAuthorityCheck: async () => {
      const error = new Error("host authority drift");
      error.code = "CODEX_AGENT_SECURITY_POLICY_CHANGED";
      throw error;
    },
    factory: async () => ({
      running: false,
      async open() { this.running = true; },
      async close() { this.running = false; },
      async prepareAuthority(input) { return { ...input, effectiveCwd: input.cwd, policyHash: "e".repeat(64) }; },
      async start() { attempted += 1; return { agentRef: "unexpected", turnId: "unexpected", status: "running" }; },
    }),
  });
  await driftPool.open();
  try {
    const prepared = await driftPool.prepareAuthority({ account: "secondary", cwd: process.cwd(), permissionProfile: ":read-only", permissionCeiling: ":read-only" });
    await assert.rejects(
      driftPool.start({ account: "secondary", cwd: process.cwd(), task: "blocked", clientRequestId: "lease-drift", permissionProfile: ":read-only", permissionCeiling: ":read-only", authorityPolicyHash: prepared.policyHash }),
      (error) => error.code === "CODEX_AGENT_SECURITY_POLICY_CHANGED"
    );
    assert.equal(attempted, 0);
  } finally { await driftPool.close(); }
});

test("account authority preparation relies on ephemeral thread lifecycle without thread/delete", async () => {
  const requests = [];
  const cwd = process.cwd();
  const client = {
    running: false,
    async start() { this.running = true; return {}; },
    async close() { this.running = false; },
    onNotification() { return () => {}; },
    async request(method, params) {
      requests.push({ method, params: structuredClone(params) });
      if (method === "config/read") {
        return { config: { projects: { [cwd]: { trust_level: "trusted" } } } };
      }
      if (method === "permissionProfile/list") {
        return { data: [{ id: ":read-only", allowed: true, sandboxMode: "readOnly", approvalPolicy: "never" }] };
      }
      if (method === "thread/start") {
        return {
          cwd,
          thread: { id: "authority-probe", cwd, ephemeral: true },
          activePermissionProfile: { id: ":read-only" },
        };
      }
      if (method === "thread/delete") throw new Error("thread/delete must not be used for ephemeral authority probes");
      throw new Error(`unexpected fixture RPC ${method}`);
    },
  };
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client });
  await executor.open();
  try {
    const prepared = await executor.prepareAuthority({
      cwd,
      permissionProfile: ":read-only",
      permissionCeiling: ":read-only",
    });
    assert.match(prepared.policyHash, /^[0-9a-f]{64}$/);
    const probe = requests.find(({ method }) => method === "thread/start");
    assert.equal(probe?.params?.ephemeral, true);
    assert.equal(requests.some(({ method }) => method === "thread/delete"), false);
  } finally {
    await executor.close();
  }
});

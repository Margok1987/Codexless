import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, rm, link } from "node:fs/promises";
import { CodexAccountAgentExecutor } from "../src/codex-account-agent-executor.mjs";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";
import { computeCodexAuthorityPolicyHash } from "../src/codex-authority-executor.mjs";
import { loadCodexAccountRegistry, assertCodexAccountHome } from "../src/codex-account-registry.mjs";
import { MeteredConsentGate } from "../src/metered-consent.mjs";
import { registerAgentPreviewTools } from "../src/agent-tools.mjs";
import { readPreviewAccountPreflight } from "../src/codex-preview-account-preflight.mjs";
import { probeManagedRuntimeReadiness } from "../src/managed-runtime-readiness.mjs";
import { assertAccountProvisioningIdle, safeManagedLoginError } from "../scripts/managed-codex-login.mjs";

const cwd = path.resolve(import.meta.dirname, "..");
const registry = Object.freeze({ source: "registry", accounts: Object.freeze([
  Object.freeze({ id: "primary", codexHome: null }), Object.freeze({ id: "secondary", codexHome: null }),
]) });
function gate() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fakeDelegate(id, overrides = {}) {
  return {
    running: false,
    async open() { this.running = true; }, async close() { this.running = false; },
    async start(input) { return { agentRef: `${id}-${input.clientRequestId}`, turnId: "turn-1", status: "idle", canSend: true }; },
    async show(input) { return { agentRef: input.agentRef, status: "idle" }; },
    async send(input) { return { agentRef: input.agentRef, turnId: "turn-2", status: "idle" }; },
    async resolvePendingRequest(input) { return { agentRef: input.agentRef, status: "running" }; },
    ...overrides,
  };
}
class PausedClient {
  running = false; initializedResult = {}; requests = []; turnCount = 0;
  holdMethod = null; entered = gate(); release = gate(); threadId = "thread-security";
  async start() { this.running = true; return {}; }
  async close() { this.running = false; }
  onNotification() { return () => {}; }
  async request(method, params = {}) {
    this.requests.push({ method, params });
    if (method === this.holdMethod) { this.entered.resolve(); await this.release.promise; }
    if (method === "thread/start") return { thread: { id: this.threadId }, model: params.model ?? "fake-model" };
    if (method === "thread/turns/list") return { data: [{ id: `turn-${this.turnCount}`, status: "completed", items: [] }] };
    if (method === "thread/resume") return { thread: { id: this.threadId, canAcceptDirectInput: true }, model: "fake-model" };
    if (method === "turn/start") { this.turnCount += 1; return { turn: { id: `turn-${this.turnCount}`, status: "completed" } }; }
    throw new Error(`unexpected fake RPC ${method}`);
  }
}

test("explicit agent account fails closed without an account-aware executor", async () => {
  const tools = new Map(); let starts = 0;
  const executor = { async start() { starts += 1; return {}; }, async listModels() { return { models: [{ model: "fake-model", id: "fake-model", isDefault: true }], nextCursor: null }; } };
  registerAgentPreviewTools({ registerTool(name, definition, handler) { tools.set(name, handler); }, registerResource() {} }, {
    agentExecutor: executor, authorityExecutor: { async resolveAuthority() { return { effectiveCwd: cwd, permissionProfile: ":read-only" }; } },
    meteredConsentMode: "always", agentPortableCard: true,
  });
  const result = await tools.get("codex.agent_start")({ prompt: "account must not be ignored", account: "secondary", requestId: "non-aware-start", cwd });
  assert.equal(result.isError, true, "unknown account routing must fail before consent or dispatch");
  assert.match(result.structuredContent?.error ?? "", /account.*(unavailable|support)|CODEX_ACCOUNT_ROUTING_UNAVAILABLE/i);
  assert.equal(starts, 0);
});

test("failed account App Server open is always closed before a retry", async () => {
  let closes = 0;
  const router = new CodexAccountAgentExecutor({ registry, factory: async (account) => fakeDelegate(account.id, {
    async open() { this.running = true; throw new Error("fixture initialization failed"); },
    async close() { closes += 1; this.running = false; },
  }) });
  try { await assert.rejects(router.start({ account: "secondary", task: "x", clientRequestId: "failed-open" }), /initialization failed/); }
  finally { await router.close(); }
  assert.equal(closes, 1, "partially opened App Server must not be orphaned");
});

test("request IDs share one binding across starts and controls", async () => {
  let sends = 0;
  const router = new CodexAccountAgentExecutor({ registry, factory: async (account) => fakeDelegate(account.id, { async send(input) { sends += 1; return { agentRef: input.agentRef }; } }) });
  try {
    await router.start({ account: "primary", task: "x", clientRequestId: "global-id" });
    const secondary = await router.start({ account: "secondary", task: "x", clientRequestId: "secondary-new" });
    await assert.rejects(router.send({ agentRef: secondary.agentRef, message: "x", clientRequestId: "global-id" }), /already|bound|different/i);
    assert.equal(sends, 0);
  } finally { await router.close(); }
});

test("pending-request replay binds both exact target and response", async () => {
  const router = new CodexAccountAgentExecutor({ registry, factory: async (account) => fakeDelegate(account.id) });
  try {
    const agent = await router.start({ account: "secondary", task: "x", clientRequestId: "pending-start" });
    await router.resolvePendingRequest({ agentRef: agent.agentRef, requestId: "approval-one", result: { decision: "decline" }, clientRequestId: "pending-response" });
    await assert.rejects(router.resolvePendingRequest({ agentRef: agent.agentRef, requestId: "approval-two", result: { decision: "accept" }, clientRequestId: "pending-response" }), /different|bound/i);
  } finally { await router.close(); }
});

test("policy hash binds effective approvals reviewer and ignores thread identity", () => {
  const material = { effectiveConfig: {}, permissionRows: [], authorityProfile: { permissionProfile: ":read-only", permissionCeiling: ":read-only" }, started: { approvalsReviewer: "user", approvalPolicy: "on-request", thread: { id: "a" } } };
  assert.notEqual(computeCodexAuthorityPolicyHash(material), computeCodexAuthorityPolicyHash({ ...material, started: { ...material.started, approvalsReviewer: "auto_review" } }));
  assert.equal(computeCodexAuthorityPolicyHash(material), computeCodexAuthorityPolicyHash({ ...material, started: { ...material.started, thread: { id: "b" } } }));
});

test("closing during thread start prevents a later paid turn", async () => {
  const client = new PausedClient(); client.holdMethod = "thread/start";
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client });
  await executor.open();
  const starting = executor.start({ task: "must not dispatch after shutdown", clientRequestId: "shutdown-start" });
  const observed = starting.catch((error) => error);
  await client.entered.promise;
  const closing = executor.close();
  client.release.resolve();
  await Promise.allSettled([starting, closing]);
  await observed;
  assert.equal(client.turnCount, 0, "shutdown must block turn/start even when a prior RPC resolves late");
});

test("pool close drains an already in-flight start and leaves no account binding", async () => {
  const entered = gate(), release = gate(); let closeFinished = false;
  const router = new CodexAccountAgentExecutor({ registry, factory: async (account) => fakeDelegate(account.id, {
    async start() { entered.resolve(); await release.promise; return { agentRef: "late-agent", status: "idle" }; },
  }) });
  const starting = router.start({ account: "secondary", task: "x", clientRequestId: "late-start" });
  await entered.promise;
  const closing = router.close().then(() => { closeFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const premature = closeFinished;
  release.resolve();
  await Promise.allSettled([starting, closing]);
  assert.equal(premature, false, "close must not claim completion with an in-flight start");
  assert.equal(router.accountForAgent("late-agent"), null, "late resolution must not resurrect a binding");
});

test("delimiter-containing requests cannot collide in start idempotency", async () => {
  const client = new PausedClient();
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client });
  await executor.open();
  try {
    await executor.start({ task: "a\u0000b", model: "c", clientRequestId: "delimiter-start" });
    await assert.rejects(executor.start({ task: "a", model: "b\u0000c", clientRequestId: "delimiter-start" }), /different|invalid|model/i);
    assert.equal(client.turnCount, 1);
  } finally { await executor.close(); }
});

test("concurrent quota preparation cannot overwrite cross-account consent binding", async () => {
  const entered = gate(), release = gate(); let calls = 0;
  const consent = new MeteredConsentGate({ mode: "always", quotaProvider: async () => { calls += 1; if (calls === 1) { entered.resolve(); await release.promise; } return { status: "unavailable" }; } });
  const first = consent.authorize({ action: "start", requestId: "quota-race", payload: { account: "primary", prompt: "x" } });
  await entered.promise;
  const second = consent.authorize({ action: "start", requestId: "quota-race", payload: { account: "secondary", prompt: "x" } });
  const secondObserved = second.catch((error) => error);
  release.resolve();
  await first;
  assert.ok((await secondObserved) instanceof Error, "different account must fail before replacing a pending authorization");
  assert.equal(calls, 1);
});

test("malformed registry errors do not echo source contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-registry-errors-"));
  try {
    await writeFile(path.join(root, "codex-accounts.json"), "SENTRY");
    await assert.rejects(loadCodexAccountRegistry({ stateRoot: root }), (error) => error.code === "CODEX_ACCOUNT_REGISTRY_INVALID" && !error.message.includes("SENTRY"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { resolveCodexAccount } from "../src/codex-account-registry.mjs";
import { createAgentPreviewState } from "../src/agent-tools.mjs";

function toolHarness({ authorityExecutor = null, modelCatalogProvider = null, accountAware = false, previewState = null, startStatus = "idle", legacyAgentCardInternals = false } = {}) {
  const tools = new Map(), starts = [], sends = [], agents = new Map();
  const snapshot = (agentRef, turnId) => ({
    agentRef, turnId, status: "idle", canSend: true, events: [], nextSeq: 0,
    execution: { requestedModel: "fake-model", resolvedModel: "fake-model", modelProvider: "fake", reasoningEffort: null },
  });
  const executor = {
    async listModels() { return { models: [{ id: "fake-model", model: "fake-model", isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null }; },
    async start(input) {
      starts.push(structuredClone(input));
      const value = snapshot(`fixture-agent-${starts.length}`, "turn-1");
      value.status = startStatus; value.canSend = startStatus === "idle";
      if (accountAware) value.account = input.account;
      agents.set(value.agentRef, value); return structuredClone(value);
    },
    async show({ agentRef }) { if (!agents.has(agentRef)) throw new Error("unknown fixture agent"); return structuredClone(agents.get(agentRef)); },
    async send(input) {
      sends.push(structuredClone(input)); const value = { ...agents.get(input.agentRef), turnId: `turn-${sends.length + 1}` };
      agents.set(input.agentRef, value); return structuredClone(value);
    },
  };
  if (accountAware) {
    executor.resolveAccountId = (id) => resolveCodexAccount(registry, id).id;
    executor.accountForAgent = (agentRef) => agents.get(agentRef)?.account ?? null;
  }
  const authority = authorityExecutor ?? { async resolveAuthority() { return { effectiveCwd: cwd, permissionProfile: ":read-only", permissionCeiling: ":read-only" }; } };
  registerAgentPreviewTools({ registerTool(name, definition, handler) { tools.set(name, { definition, handler }); }, registerResource() {} }, {
    agentExecutor: executor, authorityExecutor: authority, modelCatalogProvider,
    agentPreviewState: previewState, meteredConsentMode: "always", agentPortableCard: true,
    legacyAgentCardInternals,
  });
  return { starts, sends, tools, async invoke(name, input) { return tools.get(name).handler(input); } };
}

const policyBase = {
  effectiveConfig: {}, permissionRows: [{ id: ":read-only", allowed: true }],
  authorityProfile: { permissionProfile: ":read-only", permissionCeiling: ":read-only" },
  started: { cwd, sandbox: { type: "readOnly" }, thread: { id: "fixture-thread" }, model: "fake-model", modelProvider: "openai" },
};
for (const key of ["tools", "features", "browser_use", "computer_use", "developer_instructions", "mcp_servers", "notify", "future_policy_field"]) {
  test(`policy hash binds config field ${key} rather than guessing from its name`, () => {
    const first = computeCodexAuthorityPolicyHash({ ...policyBase, effectiveConfig: { [key]: { enabled: false } } });
    const second = computeCodexAuthorityPolicyHash({ ...policyBase, effectiveConfig: { [key]: { enabled: true } } });
    assert.notEqual(first, second);
  });
}
for (const key of ["cwd", "instructionSources", "futurePolicyField"]) {
  test(`policy hash binds effective thread field ${key}`, () => {
    assert.notEqual(
      computeCodexAuthorityPolicyHash({ ...policyBase, started: { ...policyBase.started, [key]: "fixture-one" } }),
      computeCodexAuthorityPolicyHash({ ...policyBase, started: { ...policyBase.started, [key]: "fixture-two" } }),
    );
  });
}
test("policy hash excludes only independently bound model choice and account identity", () => {
  const first = { ...policyBase, effectiveConfig: { model: "fake-one", model_reasoning_effort: "medium", forced_chatgpt_workspace_id: "account-one" } };
  const second = { ...policyBase, effectiveConfig: { model: "fake-two", model_reasoning_effort: "high", forced_chatgpt_workspace_id: "account-two" } };
  assert.equal(computeCodexAuthorityPolicyHash(first), computeCodexAuthorityPolicyHash(second));
  assert.equal(computeCodexAuthorityPolicyHash(policyBase), computeCodexAuthorityPolicyHash({ ...policyBase, started: { ...policyBase.started, thread: { id: "another-thread" }, model: "another-model" } }));
});
test("policy hash retains prototype-named JSON keys and rejects excessive depth", () => {
  const configA = JSON.parse('{"sandbox":{"__proto__":{"allowed":false}}}');
  const configB = JSON.parse('{"sandbox":{"__proto__":{"allowed":true}}}');
  assert.notEqual(computeCodexAuthorityPolicyHash({ ...policyBase, effectiveConfig: configA }), computeCodexAuthorityPolicyHash({ ...policyBase, effectiveConfig: configB }));
  let deep = false; for (let i = 0; i < 40; i += 1) deep = { sandbox: deep };
  assert.throws(() => computeCodexAuthorityPolicyHash({ ...policyBase, effectiveConfig: deep }), /depth|complex|projection/i);
});

test("decline during the authority await prevents dispatch", { timeout: 2_000 }, async () => {
  const entered = gate(), release = gate(); let calls = 0;
  const harness = toolHarness({ authorityExecutor: { async resolveAuthority() {
    calls += 1; if (calls === 2) { entered.resolve(); await release.promise; }
    return { effectiveCwd: cwd, permissionProfile: ":read-only", permissionCeiling: ":read-only" };
  } } });
  const prepared = await harness.invoke("codex.agent_start", { prompt: "must respect decline", requestId: "decline-race", cwd });
  assert.equal(prepared.isError, false);
  const taskId = prepared.structuredContent.taskId;
  const commit = harness.invoke("codex.agent_commit", { taskId });
  await entered.promise;
  const declined = await harness.invoke("codex.agent_decline", { taskId });
  release.resolve();
  const committed = await commit;
  assert.equal(declined.structuredContent.status, "rejected");
  assert.equal(harness.starts.length, 0, "an accepted pre-dispatch decline must win");
  assert.equal(committed.structuredContent.status, "rejected");
});

test("permission ceiling drift is rejected even without an optional policy hash", async () => {
  let calls = 0;
  const harness = toolHarness({ authorityExecutor: { async resolveAuthority() {
    calls += 1; return { effectiveCwd: cwd, permissionProfile: ":read-only", permissionCeiling: calls === 1 ? ":read-only" : ":workspace" };
  } } });
  const prepared = await harness.invoke("codex.agent_start", { prompt: "ceiling must stay exact", requestId: "ceiling-race", cwd });
  const committed = await harness.invoke("codex.agent_commit", { taskId: prepared.structuredContent.taskId });
  assert.equal(committed.isError, true); assert.equal(harness.starts.length, 0);
});

test("a separate non-account-aware preparation catalog cannot ignore selected account", async () => {
  const harness = toolHarness({ accountAware: true, modelCatalogProvider: { async listModels() {
    return { models: [{ id: "fake-model", model: "fake-model", isDefault: true }], nextCursor: null };
  } } });
  const prepared = await harness.invoke("codex.agent_start", { prompt: "isolated catalog", requestId: "catalog-split", account: "secondary", cwd });
  assert.equal(prepared.isError, true); assert.match(prepared.structuredContent.error, /account|routing/i);
  assert.equal(harness.starts.length, 0);
});

test("fixed terminal receipt retains selected account", async () => {
  const harness = toolHarness({ accountAware: true });
  const prepared = await harness.invoke("codex.agent_start", { prompt: "account receipt", requestId: "receipt-account", account: "secondary", cwd });
  assert.match(prepared.content[0].text, /Account.*secondary/i);
  const committed = await harness.invoke("codex.agent_commit", { taskId: prepared.structuredContent.taskId });
  assert.equal(committed.isError, false); assert.match(committed.content[0].text, /Account.*secondary/i);
});

test("legacy start and follow-up approvals do not synthesize a named account", async () => {
  const harness = toolHarness();
  const prepared = await harness.invoke("codex.agent_start", { prompt: "legacy", requestId: "legacy-card", cwd });
  assert.doesNotMatch(prepared.content[0].text, /Account/);
  const committed = await harness.invoke("codex.agent_commit", { taskId: prepared.structuredContent.taskId });
  assert.equal(committed.isError, false); assert.equal(committed.structuredContent.account ?? null, null);
  const followup = await harness.invoke("codex.agent_send", { agentRef: committed.structuredContent.agentRef, message: "legacy next", requestId: "legacy-next" });
  assert.equal(followup.isError, false); assert.equal(followup.structuredContent.account ?? null, null);
  assert.doesNotMatch(followup.content[0].text, /Account/);
});

test("malformed explicit account IDs cannot silently select a single account", () => {
  const single = { source: "legacy", accounts: [{ id: "default", codexHome: null }] };
  for (const value of ["", " ", " default", "default ", 7, false, {}]) {
    assert.throws(() => resolveCodexAccount(single, value), /invalid|exact|account/i);
  }
  assert.equal(resolveCodexAccount(single, null).id, "default");
});

test("registry schema rejects unsupported routing or environment fields and excessive entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-registry-schema-"));
  try {
    for (const document of [
      { schemaVersion: 1, accounts: [{ id: "one", home: "home-one", env: { FIXTURE: "ignored" } }] },
      { schemaVersion: 1, defaultAccount: "one", accounts: [{ id: "one", home: "home-one" }] },
      { schemaVersion: 1, accounts: Array.from({ length: 33 }, (_, i) => ({ id: `fixture${i}`, home: `home${i}` })) },
    ]) {
      await writeFile(path.join(root, "codex-accounts.json"), JSON.stringify(document));
      await assert.rejects(loadCodexAccountRegistry({ stateRoot: root }), (error) => error.code === "CODEX_ACCOUNT_REGISTRY_INVALID");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pool capacity never evicts replay bindings and preserves cancellation headroom", async () => {
  let cancels = 0;
  const router = new CodexAccountAgentExecutor({ registry, maxRequests: 1, maxAgents: 1, factory: async (account) => fakeDelegate(account.id, {
    async cancel(input) { cancels += 1; return { agentRef: input.agentRef, status: "interrupted" }; },
  }) });
  try {
    const first = await router.start({ account: "secondary", task: "x", clientRequestId: "bounded-first" });
    await assert.rejects(router.start({ account: "secondary", task: "x", clientRequestId: "bounded-second" }), (error) => error.code === "CODEX_ACCOUNT_CAPACITY");
    assert.equal((await router.start({ account: "secondary", task: "x", clientRequestId: "bounded-first" })).duplicate, true);
    await router.cancel({ agentRef: first.agentRef, clientRequestId: "bounded-stop" });
    assert.equal(cancels, 1);
  } finally { await router.close(); }
});

test("failed cleanup quarantines account instead of spawning another App Server", async () => {
  let factories = 0;
  const router = new CodexAccountAgentExecutor({ registry, factory: async (account) => {
    factories += 1; return fakeDelegate(account.id, { async open() { throw new Error("fixture open failure"); }, async close() { throw new Error("fixture close failure"); } });
  } });
  await assert.rejects(router.start({ account: "secondary", task: "x", clientRequestId: "quarantine-first" }), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
  await assert.rejects(router.start({ account: "secondary", task: "x", clientRequestId: "quarantine-second" }), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
  await assert.rejects(router.close(), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
  assert.equal(factories, 1);
});

test("closing while a follow-up resume is pending cannot start a later turn", { timeout: 2_000 }, async () => {
  const client = new PausedClient(), executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client });
  await executor.open();
  const started = await executor.start({ task: "x", clientRequestId: "close-send-start" });
  client.holdMethod = "thread/resume";
  const sending = executor.send({ agentRef: started.agentRef, message: "next", clientRequestId: "close-send" });
  const observed = sending.catch((error) => error);
  await client.entered.promise;
  const closing = executor.close(); client.release.resolve();
  await Promise.allSettled([sending, closing]);
  assert.ok((await observed) instanceof Error); assert.equal(client.turnCount, 1);
});

test("unkeyed concurrent sends cannot bypass the per-agent send lock", { timeout: 2_000 }, async () => {
  const client = new PausedClient(), executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client });
  await executor.open();
  const started = await executor.start({ task: "x", clientRequestId: "unkeyed-send-start" });
  client.holdMethod = "thread/resume";
  const first = executor.send({ agentRef: started.agentRef, message: "first" });
  await client.entered.promise;
  try { await assert.rejects(executor.send({ agentRef: started.agentRef, message: "second" }), /in-flight send/i); }
  finally { client.release.resolve(); await first; await executor.close(); }
  assert.equal(client.turnCount, 2);
});

test("consent capacity retains old bindings and does not reread quota for an exact retry", async () => {
  let calls = 0;
  const consent = new MeteredConsentGate({ mode: "always", maxRecords: 1, quotaProvider: async () => { calls += 1; return { status: "unavailable" }; } });
  const input = { action: "start", requestId: "consent-bound", payload: { account: "secondary", prompt: "x" } };
  const first = await consent.authorize(input);
  await assert.rejects(consent.authorize({ ...input, requestId: "consent-overflow" }), (error) => error.code === "CODEX_CONSENT_CAPACITY");
  assert.equal((await consent.authorize(input)).consent.consentRef, first.consent.consentRef);
  assert.equal(calls, 1);
});

test("shared preview-state capacity bounds preparation without forgetting prior task IDs", async () => {
  const previewState = createAgentPreviewState({ meteredConsentMode: "always", maxLiveTasks: 1 });
  const firstHarness = toolHarness({ previewState }), secondHarness = toolHarness({ previewState });
  const first = await firstHarness.invoke("codex.agent_start", { prompt: "one", requestId: "shared-one", cwd });
  assert.equal(first.isError, false);
  const overflow = await secondHarness.invoke("codex.agent_start", { prompt: "two", requestId: "shared-two", cwd });
  assert.equal(overflow.isError, true); assert.match(overflow.structuredContent.error, /capacity/i);
  const retry = await secondHarness.invoke("codex.agent_start", { prompt: "one", requestId: "shared-one", cwd });
  assert.equal(retry.isError, false); assert.equal(retry.structuredContent.taskId, first.structuredContent.taskId);
  assert.equal(previewState.taskRecords.size, 1);
});

class FollowupPolicyClient extends PausedClient {
  config = { sandbox_mode: "read-only", approval_policy: "on-request", features: { fixture: false } };
  rows = [{ id: ":read-only", allowed: true }];
  projection = { cwd, modelProvider: "fake", activePermissionProfile: { id: ":read-only" }, sandbox: { type: "readOnly" } };
  accountType = "chatgpt";
  failRefresh = false;
  foreignTurn = false;
  deletedThreads = [];
  hash() {
    return computeCodexAuthorityPolicyHash({ effectiveConfig: this.config, permissionRows: this.rows,
      authorityProfile: { permissionProfile: ":read-only", permissionCeiling: ":read-only" }, started: this.projection });
  }
  async request(method, params = {}) {
    if (method === "account/read") { this.requests.push({ method, params }); return { account: this.accountType ? { type: this.accountType } : null }; }
    if (method === "config/read") return { config: structuredClone(this.config) };
    if (method === "permissionProfile/list") return { data: structuredClone(this.rows) };
    if (method === "thread/delete") { this.deletedThreads.push(params.threadId); return {}; }
    if (method === "thread/turns/list" && this.failRefresh) throw new Error("fixture official state unavailable");
    if (method === "thread/turns/list" && this.foreignTurn) return { data: [{ id: "foreign-new-turn", status: "completed" }, { id: `turn-${this.turnCount}`, status: "completed" }] };
    const value = await super.request(method, params);
    if (method === "thread/start") return { ...value, ...structuredClone(this.projection) };
    if (method === "thread/resume") return { ...value, ...structuredClone(this.projection), turnsBackwardsCursor: "fixture-cursor", itemsBackwardsCursor: null };
    return value;
  }
}
async function startedPolicyFixture() {
  const client = new FollowupPolicyClient();
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client, requireAuthorityPolicy: true, requireChatgptAuth: true });
  await executor.open();
  const started = await executor.start({ task: "policy-bound task", clientRequestId: "policy-fixture-start",
    permissionProfile: ":read-only", permissionCeiling: ":read-only", authorityPolicyHash: client.hash() });
  return { client, executor, started };
}

test("strict account executors cannot dispatch without a prepared authority policy", async () => {
  const client = new FollowupPolicyClient();
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client, requireAuthorityPolicy: true, requireChatgptAuth: true });
  await executor.open();
  try { await assert.rejects(executor.start({ task: "no unbound authority", clientRequestId: "missing-authority" }), /authority|policy/i); }
  finally { await executor.close(); }
  assert.equal(client.turnCount, 0);
});

for (const accountType of [null, "apiKey", "amazonBedrock"]) {
  test(`strict account executor rejects auth type ${accountType} before a paid turn`, async () => {
    const client = new FollowupPolicyClient(); client.accountType = accountType;
    const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client, requireAuthorityPolicy: true, requireChatgptAuth: true });
    await executor.open();
    try {
      await assert.rejects(executor.start({ task: "ChatGPT only", clientRequestId: "auth-fixture", permissionProfile: ":read-only", permissionCeiling: ":read-only", authorityPolicyHash: client.hash() }), /auth|ChatGPT/i);
    } finally { await executor.close(); }
    assert.equal(client.turnCount, 0);
  });
}

test("matching follow-up policy accepts pagination metadata without changing authority", async () => {
  const { client, executor, started } = await startedPolicyFixture();
  try {
    const sent = await executor.send({ agentRef: started.agentRef, message: "next", clientRequestId: "policy-followup-ok", expectedParentTurnId: started.turnId });
    assert.equal(sent.turnId, "turn-2"); assert.equal(client.turnCount, 2);
  } finally { await executor.close(); }
});

for (const change of ["config", "projection", "auth"]) {
  test(`follow-up rejects ${change} drift before its paid turn`, async () => {
    const { client, executor, started } = await startedPolicyFixture();
    if (change === "config") client.config.features.fixture = true;
    if (change === "projection") client.projection.sandbox = { type: "dangerFullAccess" };
    if (change === "auth") client.accountType = "apiKey";
    try { await assert.rejects(executor.send({ agentRef: started.agentRef, message: "must stop", clientRequestId: "policy-followup-drift", expectedParentTurnId: started.turnId }), /authority|policy|auth|ChatGPT/i); }
    finally { await executor.close(); }
    assert.equal(client.turnCount, 1);
  });
}

test("exact approved parent turn is checked at the executor, not only the card", async () => {
  const { client, executor, started } = await startedPolicyFixture();
  try { await assert.rejects(executor.send({ agentRef: started.agentRef, message: "stale", clientRequestId: "stale-parent", expectedParentTurnId: "older-turn" }), /parent|turn changed/i); }
  finally { await executor.close(); }
  assert.equal(client.turnCount, 1);
});

for (const condition of ["failRefresh", "foreignTurn"]) {
  test(`follow-up fails closed when official state has ${condition}`, async () => {
    const { client, executor, started } = await startedPolicyFixture();
    client[condition] = true;
    try { await assert.rejects(executor.send({ agentRef: started.agentRef, message: "must stop", clientRequestId: "stale-official", expectedParentTurnId: started.turnId }), /official|parent|turn|refresh/i); }
    finally { await executor.close(); }
    assert.equal(client.turnCount, 1);
  });
}

test("pool replay binds the approved parent turn as part of send intent", async () => {
  const router = new CodexAccountAgentExecutor({ registry, factory: async (account) => fakeDelegate(account.id) });
  try {
    const agent = await router.start({ account: "secondary", task: "x", clientRequestId: "parent-pool-start" });
    const input = { agentRef: agent.agentRef, message: "x", clientRequestId: "parent-pool-send", expectedParentTurnId: "parent-one" };
    await router.send(input);
    await assert.rejects(router.send({ ...input, expectedParentTurnId: "parent-two" }), (error) => error.code === "CODEX_REQUEST_CONFLICT");
  } finally { await router.close(); }
});

test("rejected pre-turn authority cleans up its exact newly created thread", async () => {
  const client = new FollowupPolicyClient(), expected = client.hash();
  client.config.features.fixture = true;
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client });
  await executor.open();
  try { await assert.rejects(executor.start({ task: "not permitted", clientRequestId: "cleanup-thread", permissionProfile: ":read-only", permissionCeiling: ":read-only", authorityPolicyHash: expected }), /AUTHORITY_MISMATCH/); }
  finally { await executor.close(); }
  assert.equal(client.turnCount, 0); assert.deepEqual(client.deletedThreads, [client.threadId]);
});

for (const startStatus of ["running", "idle"]) {
  test(`persisted ${startStatus} task recovery preserves account and never restores execution control`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexless-account-recovery-"));
    try {
      const taskStateFile = path.join(root, "task-state.json");
      const createState = () => createAgentPreviewState({ meteredConsentMode: "always", taskStateFile });
      const first = toolHarness({ accountAware: true, startStatus, previewState: createState(), legacyAgentCardInternals: true });
      const input = { prompt: "persisted account task", account: "secondary", requestId: "persisted-account", cwd };
      const prepared = await first.invoke("codex.agent_start", input);
      const taskId = prepared.structuredContent.taskId;
      const taskRef = prepared._meta.toolwireAgentState.taskRef;
      const original = await first.invoke("codex.agent_commit", { taskId });
      assert.equal(original.isError, false);
      assert.equal(original.structuredContent.status, startStatus === "idle" ? "completed" : "running");
      const restarted = toolHarness({ accountAware: true, previewState: createState(), legacyAgentCardInternals: true });
      const recovered = await restarted.invoke("codex.agent_card_state", { taskRef });
      assert.equal(recovered.isError, false);
      assert.equal(recovered.structuredContent.status, startStatus === "running" ? "lost" : "completed");
      assert.equal(recovered.structuredContent.account, "secondary");
      assert.equal(recovered.structuredContent.canSend, false);
      const retry = await restarted.invoke("codex.agent_start", input);
      assert.equal(retry.isError, false); assert.equal(retry.structuredContent.duplicate, true);
      const replay = await restarted.invoke("codex.agent_commit", { taskId });
      assert.equal(replay.isError, true);
      const otherAccount = await restarted.invoke("codex.agent_start", { ...input, account: "primary" });
      assert.equal(otherAccount.isError, true);
      assert.equal(restarted.starts.length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("pre-multi-account schema-v1 task state never acquires a named account or execution control", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-legacy-task-state-"));
  try {
    const taskStateFile = path.join(root, "task-state.json");
    const taskRef = "task_legacy_fixture";
    const requestId = "legacy-persisted-request";
    await writeFile(taskStateFile, JSON.stringify({
      version: 1,
      records: [{
        taskRef, requestId, action: "start", subjectRef: null, phase: "active",
        agentRef: "legacy-agent", turnId: "legacy-turn", updatedAt: Date.now(),
        taskCard: {
          kind: "codex_task", taskRef, taskId: taskRef, requestId, action: "start",
          title: "legacy task", summary: "legacy task", cwd, permissionProfile: ":read-only", quota: null,
        },
        terminalSnapshot: null,
      }],
    }));
    const restarted = toolHarness({
      accountAware: true,
      previewState: createAgentPreviewState({ taskStateFile, meteredConsentMode: "always" }),
      legacyAgentCardInternals: true,
    });
    const recovered = await restarted.invoke("codex.agent_card_state", { taskRef });
    assert.equal(recovered.isError, false);
    assert.equal(recovered.structuredContent.status, "lost");
    assert.equal(recovered.structuredContent.account ?? null, null, "legacy persisted state must not be assigned to a configured account");
    assert.equal(recovered.structuredContent.canSend, false, "legacy persisted state must never regain execution control");
    const replay = await restarted.invoke("codex.agent_start", {
      prompt: "legacy task", account: "secondary", requestId, cwd,
    });
    assert.equal(replay.isError, false);
    assert.equal(replay.structuredContent.duplicate, true);
    assert.equal(replay.structuredContent.status, "lost");
    assert.equal(replay.structuredContent.account ?? null, null, "explicit account selection must not rebind an old requestId");
    assert.equal(restarted.starts.length, 0, "old persisted state must never dispatch a new Codex turn during compatibility recovery");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persisted request namespace cannot be reused for another action after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-persisted-request-"));
  try {
    const taskStateFile = path.join(root, "task-state.json");
    const createState = () => createAgentPreviewState({ meteredConsentMode: "always", taskStateFile });
    const first = toolHarness({ accountAware: true, previewState: createState() });
    const prepared = await first.invoke("codex.agent_start", { prompt: "parent", account: "primary", requestId: "persisted-parent", cwd });
    const started = await first.invoke("codex.agent_commit", { taskId: prepared.structuredContent.taskId });
    const send = await first.invoke("codex.agent_send", { agentRef: started.structuredContent.agentRef, message: "child", requestId: "persisted-global-id" });
    assert.equal(send.isError, false);
    const restarted = toolHarness({ accountAware: true, previewState: createState() });
    const collision = await restarted.invoke("codex.agent_start", { prompt: "not the child", account: "secondary", requestId: "persisted-global-id", cwd });
    assert.equal(collision.isError, true); assert.match(collision.structuredContent.error, /requestId|bound|different/i);
    assert.equal(restarted.starts.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired persisted task detail retains a durable request tombstone and cannot replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-request-tombstone-ttl-"));
  try {
    const taskStateFile = path.join(root, "task-state.json");
    const input = { prompt: "retired request", account: "secondary", requestId: "retired-request-id", cwd };
    const first = toolHarness({ accountAware: true, previewState: createAgentPreviewState({ meteredConsentMode: "always", taskStateFile, taskStateTtlMs: 60_000 }) });
    const prepared = await first.invoke("codex.agent_start", input);
    assert.equal(prepared.isError, false);
    const persisted = JSON.parse(await readFile(taskStateFile, "utf8"));
    assert.equal(persisted.requestTombstones.length, 1);
    persisted.records[0].updatedAt = Date.now() - 120_000;
    await writeFile(taskStateFile, JSON.stringify(persisted), "utf8");
    const restarted = toolHarness({ accountAware: true, previewState: createAgentPreviewState({ meteredConsentMode: "always", taskStateFile, taskStateTtlMs: 60_000 }) });
    const exactRetry = await restarted.invoke("codex.agent_start", input);
    assert.equal(exactRetry.isError, true);
    assert.match(exactRetry.structuredContent.error, /already used|expired|replay/i);
    const crossAccountRetry = await restarted.invoke("codex.agent_start", { ...input, account: "primary" });
    assert.equal(crossAccountRetry.isError, true);
    assert.equal(restarted.starts.length, 0, "expired request IDs must never dispatch again");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("task-record eviction preserves request tombstones across restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-request-tombstone-cap-"));
  try {
    const taskStateFile = path.join(root, "task-state.json");
    const firstInput = { prompt: "eviction zero", account: "primary", requestId: "eviction-request-0", cwd };
    const first = toolHarness({ accountAware: true, previewState: createAgentPreviewState({ meteredConsentMode: "always", taskStateFile, taskStateMaxEntries: 10 }) });
    for (let index = 0; index < 11; index += 1) {
      const input = index === 0 ? firstInput : { prompt: "eviction " + index, account: "primary", requestId: "eviction-request-" + index, cwd };
      const prepared = await first.invoke("codex.agent_start", input);
      assert.equal(prepared.isError, false);
    }
    const persisted = JSON.parse(await readFile(taskStateFile, "utf8"));
    assert.equal(persisted.records.length, 10, "full task records remain bounded");
    assert.equal(persisted.requestTombstones.length, 11, "compact request bindings must outlive full-record eviction");
    const restarted = toolHarness({ accountAware: true, previewState: createAgentPreviewState({ meteredConsentMode: "always", taskStateFile, taskStateMaxEntries: 10 }) });
    const replay = await restarted.invoke("codex.agent_start", firstInput);
    assert.equal(replay.isError, true);
    assert.match(replay.structuredContent.error, /already used|expired|replay/i);
    assert.equal(restarted.starts.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("request tombstone capacity fails closed instead of forgetting old request IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-request-tombstone-full-"));
  try {
    const taskStateFile = path.join(root, "task-state.json");
    const harness = toolHarness({ accountAware: true, previewState: createAgentPreviewState({ meteredConsentMode: "always", taskStateFile, taskStateMaxEntries: 10, taskStateMaxRequestTombstones: 10 }) });
    for (let index = 0; index < 10; index += 1) {
      const prepared = await harness.invoke("codex.agent_start", { prompt: "capacity " + index, account: "primary", requestId: "capacity-request-" + index, cwd });
      assert.equal(prepared.isError, false);
    }
    const blocked = await harness.invoke("codex.agent_start", { prompt: "must block", account: "primary", requestId: "capacity-request-10", cwd });
    assert.equal(blocked.isError, true);
    assert.match(blocked.structuredContent.error, /tombstone capacity|blocked without forgetting/i);
    const persisted = JSON.parse(await readFile(taskStateFile, "utf8"));
    assert.equal(persisted.requestTombstones.length, 10);
    assert.equal(persisted.requestTombstones.some((entry) => entry.requestId === "capacity-request-0"), true);
    assert.equal(persisted.requestTombstones.some((entry) => entry.requestId === "capacity-request-10"), false);
    assert.equal(harness.starts.length, 0, "capacity failure happens during preparation before any model dispatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepared-task replay cannot change the caller execution directory", async () => {
  const harness = toolHarness({ accountAware: true });
  const input = { prompt: "exact directory", account: "secondary", requestId: "cwd-replay", cwd };
  const prepared = await harness.invoke("codex.agent_start", input);
  assert.equal(prepared.isError, false);
  const replay = await harness.invoke("codex.agent_start", { ...input, cwd: path.dirname(cwd) });
  assert.equal(replay.isError, true); assert.match(replay.structuredContent.error, /different Codex caller intent|requestId/i);
  assert.equal(harness.starts.length, 0);
});

test("simultaneous preparations share a single reserved slot across registrations", { timeout: 2_000 }, async () => {
  const entered = gate(), release = gate(); let authorities = 0;
  const authorityExecutor = { async resolveAuthority() {
    authorities += 1; entered.resolve(); await release.promise;
    return { effectiveCwd: cwd, permissionProfile: ":read-only", permissionCeiling: ":read-only" };
  } };
  const previewState = createAgentPreviewState({ meteredConsentMode: "always", maxLiveTasks: 1 });
  const first = toolHarness({ accountAware: true, authorityExecutor, previewState });
  const second = toolHarness({ accountAware: true, authorityExecutor, previewState });
  const input = { prompt: "one reservation", account: "secondary", requestId: "concurrent-prepare", cwd };
  const preparing = first.invoke("codex.agent_start", input);
  await entered.promise;
  const same = second.invoke("codex.agent_start", input);
  const other = await second.invoke("codex.agent_start", { ...input, requestId: "capacity-overflow" });
  const switched = await second.invoke("codex.agent_start", { ...input, account: "primary" });
  release.resolve();
  const [a, b] = await Promise.all([preparing, same]);
  assert.equal(a.isError, false); assert.equal(b.isError, false);
  assert.equal(a.structuredContent.taskId, b.structuredContent.taskId);
  assert.equal(other.isError, true); assert.equal(switched.isError, true);
  assert.equal(authorities, 1); assert.equal(previewState.taskRecords.size, 1);
});

test("named-account provisioning is blocked by active or unverifiable persisted task state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-provisioning-guard-"));
  try {
    const stateFile = path.join(root, "task-state.json");
    await writeFile(stateFile, JSON.stringify({ version: 1, records: [{
      taskRef: "task_active", phase: "active", taskCard: { account: "secondary" }, terminalSnapshot: null,
    }] }), "utf8");
    await assert.rejects(
      assertAccountProvisioningIdle({ taskStateFile: stateFile, accountId: "secondary" }),
      (error) => error.code === "CODEX_ACCOUNT_PROVISIONING_ACTIVE"
        && /blocked/i.test(safeManagedLoginError(error))
    );
    assert.deepEqual(
      await assertAccountProvisioningIdle({ taskStateFile: stateFile, accountId: "primary" }),
      { status: "clear", activeTasks: 0 },
      "active work for another account must not block the selected account"
    );
    await writeFile(stateFile, "SENTRY_CORRUPT_STATE", "utf8");
    await assert.rejects(
      assertAccountProvisioningIdle({ taskStateFile: stateFile, accountId: "secondary" }),
      (error) => error.code === "CODEX_ACCOUNT_TASK_STATE_UNSAFE"
        && !/SENTRY/.test(safeManagedLoginError(error))
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("named-account provisioning allows missing state and exact terminal task states", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-provisioning-terminal-"));
  try {
    const stateFile = path.join(root, "task-state.json");
    assert.deepEqual(
      await assertAccountProvisioningIdle({ taskStateFile: stateFile, accountId: "secondary" }),
      { status: "clear", activeTasks: 0 }
    );
    for (const status of ["idle", "completed", "failed", "interrupted", "rejected", "lost"]) {
      await writeFile(stateFile, JSON.stringify({ version: 1, records: [{
        taskRef: "task_" + status,
        phase: "terminal",
        taskCard: { account: "secondary" },
        terminalSnapshot: { status },
      }] }), "utf8");
      assert.deepEqual(
        await assertAccountProvisioningIdle({ taskStateFile: stateFile, accountId: "secondary" }),
        { status: "clear", activeTasks: 0 },
        "terminal status " + status + " must not block provisioning"
      );
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("login qualification accepts only ChatGPT for registry accounts without changing legacy auth", async () => {
  const { assertManagedLoginAccount } = await import("../scripts/managed-codex-login.mjs");
  assert.doesNotThrow(() => assertManagedLoginAccount({ account: { type: "chatgpt" } }));
  for (const type of [null, "apiKey", "amazonBedrock", "unknown"]) {
    const response = { account: type ? { type } : null };
    assert.throws(() => assertManagedLoginAccount(response), (error) => error.code === "CODEX_ACCOUNT_AUTH_REQUIRED");
    assert.doesNotThrow(() => assertManagedLoginAccount(response, { registryAccount: false }));
  }
});

test("login errors expose fixed diagnostics rather than upstream auth contents", async () => {
  const { safeManagedLoginError } = await import("../scripts/managed-codex-login.mjs");
  const hostile = Object.assign(new Error("SENTRY auth content"), { code: "SENTRY_UNKNOWN_CODE" });
  assert.doesNotMatch(safeManagedLoginError(hostile), /SENTRY/);
  assert.match(safeManagedLoginError({ code: "CODEX_ACCOUNT_AUTH_REQUIRED" }), /ChatGPT/);
  assert.doesNotMatch(safeManagedLoginError({ code: "__proto__" }), /SENTRY/);
});

test("public account preflight never exposes upstream account or quota diagnostics", async () => {
  const hostile = Object.assign(new Error("SENTRY_MESSAGE https://login.example/secret Bearer SENTRY_TOKEN"), {
    rpcError: { code: 401, message: "SENTRY_RPC" },
  });
  const client = {
    async start() {},
    async close() {},
    async request(method) {
      if (method === "account/read") throw hostile;
      if (method === "account/usage/read" || method === "account/rateLimits/read") throw hostile;
      throw new Error("unexpected fixture method");
    },
  };
  const result = await readPreviewAccountPreflight({
    codexBin: "fixture-codex",
    defaultCwd: cwd,
    clientFactory: () => client,
    now: () => 1_788_880_000_000,
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SENTRY|login.example|Bearer/i);
  assert.equal(result.account.error.rpcCode, 401);
  assert.equal(result.account.error.rpcMessage, null);
  assert.equal(result.quota.rateLimits.error.rpcCode, 401);
  assert.equal(result.quota.rateLimits.error.rpcMessage, null);
});

test("account preflight exposes only sanitized live quota windows needed for supervision", async () => {
  const client = {
    async start() {},
    async close() {},
    async request(method) {
      if (method === "account/read") return { account: { type: "chatgpt", planType: "team" }, requiresOpenaiAuth: true };
      if (method === "account/usage/read") return { rawSecret: "SENTRY_USAGE_RAW" };
      if (method === "account/rateLimits/read") return {
        rateLimitsByLimitId: {
          codex: {
            limitId: "SENTRY_LIMIT_ID",
            limitName: "SENTRY_LIMIT_NAME",
            planType: "SENTRY_PLAN",
            credits: { value: "SENTRY_CREDITS" },
            individualLimit: "SENTRY_INDIVIDUAL",
            primary: { usedPercent: 91, resetsAt: 1788898154, windowDurationMins: 300 },
            secondary: { usedPercent: 12, resetsAt: 1789436725, windowDurationMins: 10080 },
          },
        },
        rateLimitResetCredits: "SENTRY_RESET_CREDITS",
      };
      throw new Error("unexpected fixture method " + method);
    },
  };
  const result = await readPreviewAccountPreflight({
    codexBin: "fixture-codex",
    defaultCwd: cwd,
    clientFactory: () => client,
    now: () => 1_788_895_000_000,
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.quota.rateLimits.windows, [
    { limitKey: "codex", kind: "primary", remainingPercent: 9, resetsAt: 1788898154, windowDurationMins: 300 },
    { limitKey: "codex", kind: "secondary", remainingPercent: 88, resetsAt: 1789436725, windowDurationMins: 10080 },
  ]);
  assert.equal(result.quota.usage.value, undefined);
  assert.doesNotMatch(JSON.stringify(result), /SENTRY/);
});

test("telemetry cleanup failure quarantines the account and blocks queued provider recreation", async () => {
  const entered = gate();
  const release = gate();
  let quotaCalls = 0;
  let preflightCalls = 0;
  let factories = 0;
  const cleanupFailure = Object.assign(new Error("SENTRY_CLEANUP"), { code: "CODEX_ACCOUNT_CLEANUP_FAILED" });
  const router = new CodexAccountAgentExecutor({
    registry,
    factory: async (account) => { factories += 1; return fakeDelegate(account.id); },
    quotaProvider: async () => {
      quotaCalls += 1;
      entered.resolve();
      await release.promise;
      throw cleanupFailure;
    },
    preflightProvider: async () => { preflightCalls += 1; return { status: "ok" }; },
  });
  const first = router.quotaSnapshot({ account: "secondary" });
  await entered.promise;
  const queued = router.accountPreflight({ account: "secondary" });
  release.resolve();
  await assert.rejects(first, (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED" && !/SENTRY/.test(error.message));
  await assert.rejects(queued, (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED" && !/SENTRY/.test(error.message));
  await assert.rejects(router.start({ account: "secondary", task: "x", clientRequestId: "telemetry-quarantine-start" }),
    (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
  await assert.rejects(router.close(), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
  assert.equal(quotaCalls, 1);
  assert.equal(preflightCalls, 0, "queued preflight must not create another telemetry client after cleanup failure");
  assert.equal(factories, 0, "delegate creation must remain blocked for the quarantined account");
});

test("cleanup quarantine blocks late delegate publication before any dispatch", async () => {
  const opened = gate(), releaseOpen = gate();
  let starts = 0, closes = 0;
  const cleanupFailure = Object.assign(new Error("fixture cleanup"), { code: "CODEX_ACCOUNT_CLEANUP_FAILED" });
  const router = new CodexAccountAgentExecutor({
    registry,
    factory: async (account) => fakeDelegate(account.id, {
      async open() { opened.resolve(); await releaseOpen.promise; },
      async start() { starts += 1; return { agentRef: "late-quarantined", status: "idle" }; },
      async close() { closes += 1; },
    }),
    quotaProvider: async () => { throw cleanupFailure; },
  });
  const starting = router.start({ account: "secondary", task: "x", clientRequestId: "late-quarantine-start" });
  await opened.promise;
  await assert.rejects(router.quotaSnapshot({ account: "secondary" }), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
  releaseOpen.resolve();
  await assert.rejects(starting, (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
  assert.equal(starts, 0, "delegate must not dispatch after account quarantine wins the initialization race");
  assert.equal(closes, 1, "late initialized delegate must be closed instead of published");
  await assert.rejects(router.close(), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
});

test("quarantine preserves safety cancellation on an already existing delegate", async () => {
  let cancels = 0, factories = 0;
  const cleanupFailure = Object.assign(new Error("fixture cleanup"), { code: "CODEX_ACCOUNT_CLEANUP_FAILED" });
  const router = new CodexAccountAgentExecutor({
    registry,
    factory: async (account) => {
      factories += 1;
      return fakeDelegate(account.id, {
        async cancel(input) { cancels += 1; return { agentRef: input.agentRef, turnId: "turn-1", status: "interrupted" }; },
      });
    },
    quotaProvider: async () => { throw cleanupFailure; },
  });
  const started = await router.start({ account: "secondary", task: "x", clientRequestId: "quarantine-control-start" });
  await assert.rejects(router.quotaSnapshot({ agentRef: started.agentRef }), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
  await assert.rejects(router.start({ account: "secondary", task: "new", clientRequestId: "quarantine-control-new" }), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
  const cancelled = await router.cancel({ agentRef: started.agentRef, clientRequestId: "quarantine-control-cancel", expectedTurnId: "turn-1" });
  assert.equal(cancelled.status, "interrupted");
  assert.equal(cancels, 1);
  assert.equal(factories, 1, "safety control must use the existing delegate and never recreate a quarantined runtime");
  await assert.rejects(router.close(), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
});

test("terminal resource telemetry can traverse the same account quarantine contract", async () => {
  const client = new PausedClient();
  let router, quotaCalls = 0;
  router = new CodexAccountAgentExecutor({
    registry,
    factory: async (account) => new CodexAgentExecutor({
      defaultCwd: cwd,
      clientFactory: () => client,
      requireAuthorityPolicy: false,
      requireChatgptAuth: false,
      resourceSnapshotProvider: ({ agentRef }) => router.quotaSnapshot({ agentRef }),
    }),
    quotaProvider: async () => {
      quotaCalls += 1;
      if (quotaCalls === 1) throw Object.assign(new Error("fixture cleanup"), { code: "CODEX_ACCOUNT_CLEANUP_FAILED" });
      return { status: "ok", usage: { status: "ok" }, rateLimits: { status: "ok", value: { limits: [] } } };
    },
  });
  const started = await router.start({ account: "secondary", task: "x", clientRequestId: "receipt-pool-start" });
  const shown = await router.show({ agentRef: started.agentRef, clientRequestId: null });
  assert.equal(shown.status, "idle");
  assert.equal(quotaCalls, 1, "terminal receipt telemetry must use the pool exactly once");
  assert.equal(shown.resourceReceipt?.accountQuota?.status, "unavailable");
  await assert.rejects(router.quotaSnapshot({ agentRef: started.agentRef }), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
  assert.equal(quotaCalls, 1, "quarantine must prevent a second telemetry client after terminal receipt cleanup failure");
  await assert.rejects(router.close(), (error) => error.code === "CODEX_ACCOUNT_CLEANUP_FAILED");
});

test("multiple preview runtimes cannot overwrite each other's durable request tombstones", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-multi-runtime-tombstone-"));
  try {
    const taskStateFile = path.join(root, "task-state.json");
    // Construct both instances before either writes: this reproduces stale in-memory state.
    const firstState = createAgentPreviewState({ meteredConsentMode: "always", taskStateFile });
    const secondState = createAgentPreviewState({ meteredConsentMode: "always", taskStateFile });
    const first = toolHarness({ accountAware: true, previewState: firstState });
    const second = toolHarness({ accountAware: true, previewState: secondState });
    const a = { prompt: "runtime A", account: "primary", requestId: "multi-runtime-a", cwd };
    const b = { prompt: "runtime B", account: "secondary", requestId: "multi-runtime-b", cwd };
    assert.equal((await first.invoke("codex.agent_start", a)).isError, false);
    assert.equal((await second.invoke("codex.agent_start", b)).isError, false);
    const persisted = JSON.parse(await readFile(taskStateFile, "utf8"));
    const ids = new Set((persisted.requestTombstones ?? []).map((entry) => entry.requestId));
    assert.equal(ids.has("multi-runtime-a"), true, "runtime B must not erase runtime A tombstone");
    assert.equal(ids.has("multi-runtime-b"), true);
    const restarted = toolHarness({ accountAware: true, previewState: createAgentPreviewState({ meteredConsentMode: "always", taskStateFile }) });
    const replayA = await restarted.invoke("codex.agent_start", a);
    assert.equal(replayA.isError, false);
    assert.equal(replayA.structuredContent.status, "lost", "persisted pending work from another runtime must recover fail-closed rather than replay");
    assert.equal(restarted.starts.length, 0, "recovered requestId must never dispatch again");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a second preview runtime cannot prepare the same durable requestId again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-multi-runtime-duplicate-"));
  try {
    const taskStateFile = path.join(root, "task-state.json");
    const first = toolHarness({ accountAware: true, previewState: createAgentPreviewState({ meteredConsentMode: "always", taskStateFile }) });
    const second = toolHarness({ accountAware: true, previewState: createAgentPreviewState({ meteredConsentMode: "always", taskStateFile }) });
    const input = { prompt: "shared request", account: "secondary", requestId: "multi-runtime-shared", cwd };
    const prepared = await first.invoke("codex.agent_start", input);
    assert.equal(prepared.isError, false);
    assert.equal(prepared.structuredContent.status, "consent_required");
    const retry = await second.invoke("codex.agent_start", input);
    assert.equal(second.starts.length, 0, "second runtime must not dispatch or create replacement work for a durable requestId");
    assert.ok(retry.isError === true || retry.structuredContent?.status === "lost", "second runtime must fail closed or recover the existing task");
    const persisted = JSON.parse(await readFile(taskStateFile, "utf8"));
    assert.equal((persisted.requestTombstones ?? []).filter((entry) => entry.requestId === "multi-runtime-shared").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("task-state persistence reclaims a lock owned by a dead process before writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-task-lock-dead-"));
  try {
    const taskStateFile = path.join(root, "task-state.json");
    await writeFile(taskStateFile + ".lock", JSON.stringify({ version: 1, pid: 2147483647, createdAt: Date.now() - 60_000 }), "utf8");
    const harness = toolHarness({ accountAware: true, previewState: createAgentPreviewState({ meteredConsentMode: "always", taskStateFile }) });
    const prepared = await harness.invoke("codex.agent_start", { prompt: "dead lock recovery", account: "primary", requestId: "dead-lock-recovery", cwd });
    assert.equal(prepared.isError, false);
    assert.equal(prepared.structuredContent.status, "consent_required");
    const persisted = JSON.parse(await readFile(taskStateFile, "utf8"));
    assert.equal(persisted.requestTombstones.some((entry) => entry.requestId === "dead-lock-recovery"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("task-state persistence fails closed while a live runtime owns the lock", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-task-lock-live-"));
  try {
    const taskStateFile = path.join(root, "task-state.json");
    await writeFile(taskStateFile + ".lock", JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now() }), "utf8");
    const harness = toolHarness({ accountAware: true, previewState: createAgentPreviewState({ meteredConsentMode: "always", taskStateFile }) });
    const blocked = await harness.invoke("codex.agent_start", { prompt: "live lock must block", account: "primary", requestId: "live-lock-block", cwd });
    assert.equal(blocked.isError, true);
    assert.match(blocked.structuredContent.error, /durable task state|locked|recorded safely/i);
    assert.equal(harness.starts.length, 0);
    await assert.rejects(readFile(taskStateFile, "utf8"), (error) => error.code === "ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed readiness withholds upstream diagnostics and fails closed on cleanup failure", async () => {
  const hostile = new Error("SENTRY_READINESS https://example.invalid/secret Bearer SENTRY_TOKEN");
  const failedProbe = await probeManagedRuntimeReadiness({
    runtime: { lane: "managed", bin: "fixture", launchEnv: {} },
    cwd,
    clientFactory: () => ({
      async start() {},
      async request() { throw hostile; },
      async close() {},
    }),
  });
  assert.equal(failedProbe.status, "not_ready");
  assert.equal(failedProbe.reason, "managed_readiness_probe_failed");
  assert.doesNotMatch(JSON.stringify(failedProbe), /SENTRY|example.invalid|Bearer/i);

  const cleanupProbe = await probeManagedRuntimeReadiness({
    runtime: { lane: "managed", bin: "fixture", launchEnv: {} },
    cwd,
    clientFactory: () => ({
      async start() {},
      async request(method) {
        if (method === "account/read") return { account: { type: "chatgpt", planType: "team" } };
        if (method === "model/list") return { data: [{ id: "fixture" }] };
        if (method === "config/read") return { config: {} };
        throw new Error("unexpected fixture method");
      },
      async close() { throw new Error("SENTRY_CLOSE"); },
    }),
  });
  assert.equal(cleanupProbe.status, "not_ready");
  assert.equal(cleanupProbe.reason, "managed_readiness_cleanup_failed");
  assert.doesNotMatch(JSON.stringify(cleanupProbe), /SENTRY/i);
});

test("quota consent never repeats upstream error message or identity fragments", async () => {
  const upstream = { name: "SENTRY_NAME", message: "SENTRY_MESSAGE", rpcMessage: "SENTRY_RPC", rpcCode: 401 };
  const consent = new MeteredConsentGate({ mode: "always", quotaProvider: async () => ({
    status: "unavailable", usage: { status: "unavailable", error: upstream }, rateLimits: { status: "unavailable", error: upstream },
  }) });
  const result = await consent.authorize({ action: "start", requestId: "quota-error-leak", payload: { account: "secondary", prompt: "x" } });
  assert.equal(result.authorized, false);
  assert.doesNotMatch(JSON.stringify(result), /SENTRY/);
  assert.equal(result.consent.quota.rateLimits.error.rpcCode, 401);
});

test("completed account resource receipts do not expose thrown telemetry error contents", async () => {
  const client = new PausedClient();
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client,
    resourceSnapshotProvider: async () => { throw new Error("SENTRY_AUTH_CONTENT"); },
  });
  await executor.open();
  try {
    const started = await executor.start({ task: "x", clientRequestId: "receipt-error-start" });
    const result = await executor.show({ agentRef: started.agentRef });
    assert.equal(result.status, "idle"); assert.ok(result.resourceReceipt);
    assert.doesNotMatch(JSON.stringify(result.resourceReceipt), /SENTRY/);
  } finally { await executor.close(); }
});

test("auth files cannot physically alias across otherwise distinct account homes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-auth-alias-"));
  try {
    const firstHome = path.join(root, "home-one"), secondHome = path.join(root, "home-two");
    await mkdir(firstHome); await mkdir(secondHome);
    const first = { id: "primary", codexHome: firstHome }, second = { id: "secondary", codexHome: secondHome };
    const accounts = { source: "registry", accounts: [first, second] };
    await writeFile(path.join(firstHome, "auth.json"), "synthetic fixture, not credentials");
    await writeFile(path.join(secondHome, "auth.json"), "different synthetic fixture");
    await assertCodexAccountHome(first, { stateRoot: root, registry: accounts });
    await assertCodexAccountHome(second, { stateRoot: root, registry: accounts });
    await rm(path.join(secondHome, "auth.json"));
    await link(path.join(firstHome, "auth.json"), path.join(secondHome, "auth.json"));
    await assert.rejects(assertCodexAccountHome(second, { stateRoot: root, registry: accounts }), (error) => error.code === "CODEX_ACCOUNT_HOME_UNSAFE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registry error diagnostics do not echo invalid IDs or state-root paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-registry-diagnostics-"));
  try {
    await writeFile(path.join(root, "codex-accounts.json"), JSON.stringify({ schemaVersion: 1, accounts: [{ id: "SENTRY_INVALID_ID", home: "home" }] }));
    await assert.rejects(loadCodexAccountRegistry({ stateRoot: root }), (error) => error.code === "CODEX_ACCOUNT_REGISTRY_INVALID" && !error.message.includes("SENTRY"));
    const missingRoot = path.join(root, "SENTRY_MISSING_ROOT");
    await assert.rejects(assertCodexAccountHome({ id: "secondary", codexHome: path.join(missingRoot, "home") }, { stateRoot: missingRoot }), (error) => error.code === "CODEX_ACCOUNT_HOME_UNSAFE" && !error.message.includes("SENTRY"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt persisted-task diagnostics do not echo source fragments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-task-error-"));
  try {
    const taskStateFile = path.join(root, "task-state.json");
    await writeFile(taskStateFile, "SENTRY");
    const harness = toolHarness({ previewState: createAgentPreviewState({ taskStateFile, meteredConsentMode: "always" }) });
    const result = await harness.invoke("codex.agent_start", { prompt: "must stop", requestId: "corrupt-state", cwd });
    assert.equal(result.isError, true); assert.doesNotMatch(result.structuredContent.error, /SENTRY/);
    assert.equal(harness.starts.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("direct executor agent capacity never evicts an accepted start binding", async () => {
  const client = new PausedClient();
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client, maxAgents: 1 });
  await executor.open();
  try {
    const first = await executor.start({ task: "first", clientRequestId: "agent-cap-first" });
    await assert.rejects(
      executor.start({ task: "second", clientRequestId: "agent-cap-second" }),
      (error) => error.code === "CODEX_AGENT_CAPACITY",
    );
    const duplicate = await executor.start({ task: "first", clientRequestId: "agent-cap-first" });
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.agentRef, first.agentRef);
    assert.equal(client.requests.filter((entry) => entry.method === "thread/start").length, 1);
  } finally { await executor.close(); }
});

test("direct executor send capacity preserves exact replay tombstones", async () => {
  const client = new PausedClient();
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client, maxAgents: 1, maxRequestBindings: 1 });
  await executor.open();
  try {
    const started = await executor.start({ task: "first", clientRequestId: "send-cap-start" });
    const input = { agentRef: started.agentRef, message: "one", clientRequestId: "send-cap-first" };
    const first = await executor.send(input);
    await assert.rejects(
      executor.send({ agentRef: started.agentRef, message: "two", clientRequestId: "send-cap-second" }),
      (error) => error.code === "CODEX_AGENT_CAPACITY",
    );
    const duplicate = await executor.send(input);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.turnId, first.turnId);
    assert.equal(client.turnCount, 2);
  } finally { await executor.close(); }
});

class ControlCapacityClient extends PausedClient {
  async request(method, params = {}) {
    if (method === "turn/start") {
      this.requests.push({ method, params });
      this.turnCount += 1;
      return { turn: { id: `turn-${this.turnCount}`, status: "inProgress" } };
    }
    if (method === "thread/turns/list") {
      this.requests.push({ method, params });
      return { data: [{ id: `turn-${this.turnCount}`, status: "inProgress", items: [] }] };
    }
    if (method === "turn/interrupt") {
      this.requests.push({ method, params });
      return {};
    }
    return super.request(method, params);
  }
}

test("direct executor cancel replay preserves its bounded control binding", async () => {
  const client = new ControlCapacityClient();
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client, maxAgents: 1, maxControlBindings: 1 });
  await executor.open();
  try {
    const started = await executor.start({ task: "first", clientRequestId: "control-cap-start" });
    const input = { agentRef: started.agentRef, clientRequestId: "control-cap-stop", expectedTurnId: started.turnId };
    const cancelled = await executor.cancel(input);
    assert.equal(cancelled.controlAcceptance, "accepted");
    const duplicate = await executor.cancel(input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.controlAcceptance, "accepted");
    assert.equal(client.requests.filter((entry) => entry.method === "turn/interrupt").length, 1);
  } finally { await executor.close(); }
});

test("direct executor bounds ordinary in-flight operations without blocking shutdown", { timeout: 2_000 }, async () => {
  const client = new PausedClient(); client.holdMethod = "thread/start";
  const executor = new CodexAgentExecutor({ defaultCwd: cwd, clientFactory: () => client, maxInFlight: 1 });
  await executor.open();
  const first = executor.start({ task: "held", clientRequestId: "inflight-first" });
  await client.entered.promise;
  await assert.rejects(
    executor.start({ task: "blocked", clientRequestId: "inflight-second" }),
    (error) => error.code === "CODEX_AGENT_CAPACITY",
  );
  client.release.resolve();
  await first;
  await executor.close();
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { registerAgentPreviewTools } from "../src/agent-tools.mjs";

// Historical filename retained for suite compatibility. The product contract it
// now tests is the fixed-text prepared-task flow; Portable/Rich is not a normal surface.
const projectRoot = path.resolve(import.meta.dirname, "..");

function captureServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) { tools.set(name, { definition, handler }); },
    registerResource() {},
  };
}

function quotaSnapshot() {
  return {
    status: "ok",
    observedAt: "2026-08-18T10:00:00.000Z",
    usage: { status: "unavailable" },
    rateLimits: {
      status: "ok",
      value: {
        limits: [{
          key: "codex",
          limitId: "codex",
          limitName: "Codex",
          planType: "plus",
          rateLimitReachedType: null,
          spendControlReached: false,
          windows: [{ kind: "primary", usedPercent: 37, resetsAt: 1800000000, windowDurationMins: 300 }],
        }],
      },
    },
  };
}

function agentSnapshot({ agentRef, turnId, finalResult, model, reasoningEffort = null, requestedReasoningEffort = null }) {
  return {
    agentRef,
    turnId,
    status: "idle",
    canSend: true,
    pendingApproval: null,
    finalResult,
    resourceReceipt: {
      turnId,
      tokenUsage: { turn: { totalTokens: 12 }, threadTotal: { totalTokens: 31 } },
      accountQuota: {
        status: "ok",
        observedAt: "2026-08-18T10:01:00.000Z",
        usage: { status: "unavailable" },
        rateLimits: { status: "ok", limits: [{ key: "codex", limitName: "Codex", windows: [{ kind: "primary", remainingPercent: 63, resetsAt: 1800000000, windowDurationMins: 300 }] }] },
      },
    },
    timing: { startedAt: Date.now() - 10, endedAt: Date.now(), durationMs: 10 },
    execution: {
      requestedModel: model ?? null,
      ...(requestedReasoningEffort ? { requestedReasoningEffort } : {}),
      resolvedModel: model ?? "fake-default",
      modelProvider: "fake",
      serviceTier: null,
      reasoningEffort,
    },
    latestError: null,
    events: [],
    nextSeq: 0,
    duplicate: false,
  };
}

function createHarness({ agentReasoningEffort = true, quotaProvider = async () => quotaSnapshot(), authorityExecutor: authorityExecutorOverride = null, accounts = null } = {}) {
  const server = captureServer();
  const starts = [];
  const sends = [];
  const agents = new Map();
  const agentAccounts = new Map();
  const configuredAccounts = Array.isArray(accounts) ? [...accounts] : null;
  const resolveConfiguredAccount = (account = null) => {
    if (!configuredAccounts) return account;
    if (!account && configuredAccounts.length > 1) {
      const error = new Error("account is required when multiple Codex accounts are configured");
      error.code = "CODEX_ACCOUNT_REQUIRED";
      throw error;
    }
    const selected = account ?? configuredAccounts[0];
    if (!configuredAccounts.includes(selected)) {
      const error = new Error("unknown Codex account");
      error.code = "CODEX_ACCOUNT_UNKNOWN";
      throw error;
    }
    return selected;
  };
  let sequence = 0;
  const models = [
    {
      id: "fake-default", model: "fake-default", displayName: "Fake Default", hidden: false, isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "ultra", description: "Deep" }],
    },
    {
      id: "fake-fast", model: "fake-fast", displayName: "Fake Fast", hidden: false, isDefault: false,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
    },
  ];
  const authorityExecutor = authorityExecutorOverride ?? {
    async resolveAuthority({ cwd }) {
      return { effectiveCwd: path.resolve(cwd ?? projectRoot), permissionProfile: "prepared-test-authority", permissionCeiling: "prepared-test-authority", authoritySource: "test", trustedAncestor: projectRoot };
    },
  };
  const agentExecutor = {
    async listModels({ account = null } = {}) {
      if (configuredAccounts) resolveConfiguredAccount(account);
      return { models: structuredClone(models), nextCursor: null };
    },
    async start(args) {
      starts.push(structuredClone(args));
      sequence += 1;
      const snapshot = agentSnapshot({
        agentRef: `agent_prepared_${sequence}`,
        turnId: `turn_prepared_${sequence}`,
        finalResult: `STARTED:${args.task}`,
        model: args.model,
        requestedReasoningEffort: args.reasoningEffort ?? null,
        reasoningEffort: args.reasoningEffort ?? "medium",
      });
      if (args.task === "FAIL_TERMINAL") {
        snapshot.status = "failed";
        snapshot.canSend = false;
        snapshot.finalResult = null;
        snapshot.latestError = "FAKE_TERMINAL_FAILURE";
        snapshot.resourceReceipt = null;
        snapshot.execution.resolvedModel = null;
        snapshot.execution.reasoningEffort = null;
        snapshot.timing = { startedAt: Date.now() - 2500, endedAt: Date.now(), durationMs: 2500 };
      }
      if (args.account) {
        snapshot.account = args.account;
        agentAccounts.set(snapshot.agentRef, args.account);
      }
      agents.set(snapshot.agentRef, snapshot);
      return structuredClone(snapshot);
    },
    async show({ agentRef }) {
      const snapshot = agents.get(agentRef);
      if (!snapshot) throw new Error(`unknown fake agent ${agentRef}`);
      return structuredClone(snapshot);
    },
    async send(args) {
      sends.push(structuredClone(args));
      sequence += 1;
      const prior = agents.get(args.agentRef);
      const snapshot = agentSnapshot({
        agentRef: args.agentRef,
        turnId: `turn_prepared_${sequence}`,
        finalResult: `SENT:${args.message}`,
        model: args.model ?? prior?.execution?.resolvedModel,
        requestedReasoningEffort: args.reasoningEffort ?? null,
        reasoningEffort: prior?.execution?.reasoningEffort ?? null,
      });
      if (prior?.account) snapshot.account = prior.account;
      agents.set(snapshot.agentRef, snapshot);
      return structuredClone(snapshot);
    },
    async resolveApproval() { throw new Error("not used"); },
    async cancel() { throw new Error("not used"); },
  };
  if (configuredAccounts) {
    agentExecutor.resolveAccountId = (account = null) => resolveConfiguredAccount(account);
    agentExecutor.accountForAgent = (agentRef) => agentAccounts.get(agentRef) ?? null;
  }
  registerAgentPreviewTools(server, {
    agentExecutor,
    authorityExecutor,
    meteredConsentMode: "always",
    meteredQuotaProvider: quotaProvider,
    agentPortableCard: true,
    agentReasoningEffort,
  });
  async function invoke(name, args) {
    const entry = server.tools.get(name);
    assert.ok(entry, `missing tool ${name}`);
    return entry.handler(args);
  }
  return { server, starts, sends, agents, invoke };
}

function assertPreparedApproval(result, { task, modelLabel = "Fake Default", model = "fake-default", effort = "medium", account = null } = {}) {
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  const payload = result.structuredContent;
  const text = result.content?.[0]?.text ?? "";
  assert.equal(payload.status, "consent_required");
  assert.match(payload.taskId, /^C-[A-F0-9]{10}$/);
  assert.match(text, /^⚠️/);
  assert.match(text, /Call Codex\?/i);
  assert.match(text, new RegExp(task));
  assert.match(text, new RegExp(modelLabel));
  assert.match(text, new RegExp(effort));
  if (account) assert.match(text, new RegExp(`Account[：:]\\s*${account}`));
  assert.match(text, /63%/);
  assert.equal(text.includes(payload.taskId), true);
  assert.equal(text, payload.chatPresentation?.text, "Call Approval content must exactly equal the server-fixed presentation text");
  const delivery = payload.chatPresentation?.delivery;
  assert.equal(delivery?.mode, "verbatim_text");
  assert.equal(delivery?.mustPresentVerbatim, true);
  assert.equal(delivery?.noProseBeforeOrAfter, true);
  assert.equal(delivery?.allowSummary, false);
  assert.equal(delivery?.allowRewrite, false);
  assert.equal(delivery?.allowReorder, false);
  assert.equal(delivery?.allowTranslation, false);
  assert.equal(delivery?.textSha256, createHash("sha256").update(text, "utf8").digest("hex"));
  assert.deepEqual(delivery?.requiredFields, account
    ? ["task", "whyCodex", "model", "reasoningEffort", "quota", "taskId", "yesNo", "account"]
    : ["task", "whyCodex", "model", "reasoningEffort", "quota", "taskId", "yesNo"]);
  assert.deepEqual(payload.chatPresentation?.choices, ["Yes", "No"]);
  assert.equal(payload.chatPresentation?.binding?.approveTool, "codex.agent_commit");
  assert.equal(payload.chatPresentation?.binding?.declineTool, "codex.agent_decline");
  assert.equal(payload.chatPresentation?.modelSelection?.selectedModel, model);
  assert.equal(payload.chatPresentation?.modelSelection?.selectedReasoningEffort, effort);
  for (const hidden of ["taskRef", "shortTaskId", "taskCard", "cardRender", "manualFallback"]) {
    assert.equal(Object.hasOwn(payload, hidden), false, `normal approval leaked ${hidden}`);
  }
  assert.equal(Object.hasOwn(payload.meteredConsent ?? {}, "consentRef"), false);
  return payload.taskId;
}

test("fixed-text prepared approval resolves default and explicit model/effort without exposing historical card controls", async () => {
  const { invoke } = createHarness();
  const first = await invoke("codex.agent_start", { prompt: "PREPARED_DEFAULT", requestId: "prepared-default", cwd: projectRoot });
  assertPreparedApproval(first, { task: "PREPARED_DEFAULT" });
  assert.equal(first.structuredContent.execution.requestedModel, "fake-default");
  assert.equal(first.structuredContent.execution.requestedReasoningEffort, "medium");

  const explicit = await invoke("codex.agent_start", { prompt: "PREPARED_EXPLICIT", requestId: "prepared-explicit", cwd: projectRoot, model: "fake-default", reasoningEffort: "ultra" });
  assertPreparedApproval(explicit, { task: "PREPARED_EXPLICIT", modelLabel: "Fake Default", effort: "ultra" });
});

test("multi-account fixed approval visibly binds the selected account and follow-ups cannot switch it", async () => {
  const { server, starts, invoke } = createHarness({ accounts: ["dennis", "pia"] });
  const modelList = server.tools.get("codex.model_list")?.definition;
  const startDef = server.tools.get("codex.agent_start")?.definition;
  const sendDef = server.tools.get("codex.agent_send")?.definition;
  assert.equal(modelList.inputSchema.safeParse({ account: "pia" }).success, true);
  assert.equal(startDef.inputSchema.safeParse({ prompt: "x", account: "pia", requestId: "x" }).success, true);
  assert.equal(Object.hasOwn(sendDef.inputSchema.shape ?? {}, "account"), false);

  const missing = await invoke("codex.agent_start", { prompt: "ACCOUNT_REQUIRED", requestId: "account-required", cwd: projectRoot });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.errorCode, "CODEX_ACCOUNT_REQUIRED");

  const prepared = await invoke("codex.agent_start", { prompt: "ACCOUNT_PIA", account: "pia", requestId: "account-pia", cwd: projectRoot });
  const taskId = assertPreparedApproval(prepared, { task: "ACCOUNT_PIA", account: "pia" });
  assert.equal(prepared.structuredContent.account ?? null, null);
  const changedIntent = await invoke("codex.agent_start", { prompt: "ACCOUNT_PIA", account: "dennis", requestId: "account-pia", cwd: projectRoot });
  assert.equal(changedIntent.isError, true);
  assert.match(changedIntent.structuredContent.error, /different Codex caller intent/i);

  const committed = await invoke("codex.agent_commit", { taskId });
  assert.equal(committed.isError, false);
  assert.equal(committed.structuredContent.account, "pia");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].account, "pia");

  const follow = await invoke("codex.agent_send", { agentRef: committed.structuredContent.agentRef, message: "FOLLOW_PIA", requestId: "follow-pia" });
  assertPreparedApproval(follow, { task: "FOLLOW_PIA", account: "pia" });
});

test("fixed approval can prepare and dispatch a follow-up after an interrupted parent", async () => {
  const { starts, sends, agents, invoke } = createHarness();
  const prepared = await invoke("codex.agent_start", { prompt: "INTERRUPT_PARENT", requestId: "interrupt-parent", cwd: projectRoot });
  const startTaskId = assertPreparedApproval(prepared, { task: "INTERRUPT_PARENT" });
  const committed = await invoke("codex.agent_commit", { taskId: startTaskId });
  assert.equal(starts.length, 1);
  const agentRef = committed.structuredContent.agentRef;
  const interrupted = agents.get(agentRef);
  interrupted.status = "interrupted";
  interrupted.canSend = true;
  interrupted.finalResult = "PARTIAL_RESULT";

  const follow = await invoke("codex.agent_send", {
    agentRef,
    message: "CONTINUE_SAME_THREAD",
    requestId: "interrupt-follow",
  });
  const followTaskId = assertPreparedApproval(follow, { task: "CONTINUE_SAME_THREAD" });
  const sent = await invoke("codex.agent_commit", { taskId: followTaskId });
  assert.equal(sent.isError, false);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].agentRef, agentRef);
  assert.equal(sends[0].message, "CONTINUE_SAME_THREAD");
});

test("concurrent commits of one multi-account Task ID dispatch exactly once", async () => {
  const { starts, invoke } = createHarness({ accounts: ["dennis", "pia"] });
  const prepared = await invoke("codex.agent_start", { prompt: "ACCOUNT_CONCURRENT", account: "pia", requestId: "account-concurrent", cwd: projectRoot });
  const taskId = assertPreparedApproval(prepared, { task: "ACCOUNT_CONCURRENT", account: "pia" });
  const [left, right] = await Promise.all([
    invoke("codex.agent_commit", { taskId }),
    invoke("codex.agent_commit", { taskId }),
  ]);
  assert.equal(left.isError, false);
  assert.equal(right.isError, false);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].account, "pia");
  assert.equal(left.structuredContent.agentRef, right.structuredContent.agentRef);
});

test("neutral agent_commit is exact server-bound for start and send; duplicate exact Task ID never redispatches", async () => {
  const { server, starts, sends, invoke } = createHarness();
  const definition = server.tools.get("codex.agent_commit")?.definition;
  assert.equal(definition.inputSchema.safeParse({}).success, false);
  assert.equal(definition.inputSchema.safeParse({ taskId: "C-0000000000", prompt: "OVERRIDE" }).success, false);
  assert.equal(server.tools.has("codex.agent_portable_commit"), false);

  const prepared = await invoke("codex.agent_start", { prompt: "EXACT_START", requestId: "exact-start", cwd: projectRoot, model: "fake-default", reasoningEffort: "ultra" });
  const taskId = assertPreparedApproval(prepared, { task: "EXACT_START", effort: "ultra" });
  const committed = await invoke("codex.agent_commit", { taskId });
  assert.equal(committed.isError, false);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].task, "EXACT_START");
  assert.equal(starts[0].reasoningEffort, "ultra");
  assert.match(committed.content[0].text, /12 tokens/);
  assert.doesNotMatch(committed.content[0].text, /31 tokens/);

  const duplicate = await invoke("codex.agent_commit", { taskId });
  assert.equal(duplicate.structuredContent.duplicate, true);
  assert.equal(starts.length, 1);

  const follow = await invoke("codex.agent_send", { agentRef: committed.structuredContent.agentRef, message: "EXACT_SEND", requestId: "exact-send", model: "fake-fast", reasoningEffort: "low" });
  const sendTaskId = assertPreparedApproval(follow, { task: "EXACT_SEND", modelLabel: "Fake Fast", model: "fake-fast", effort: "low" });
  const sent = await invoke("codex.agent_commit", { taskId: sendTaskId });
  assert.equal(sent.isError, false);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].message, "EXACT_SEND");
  assert.equal(sends[0].model, "fake-fast");
  assert.equal(sends[0].reasoningEffort, "low");
});

test("unknown prepared Task ID fails closed and changed requestId intent never reuses approval", async () => {
  const { starts, invoke } = createHarness();
  const missing = await invoke("codex.agent_commit", { taskId: "C-0000000000" });
  assert.equal(missing.isError, true);
  assert.match(missing.structuredContent.error ?? "", /unknown|stale|ambiguous/i);

  await invoke("codex.agent_start", { prompt: "ORIGINAL", requestId: "same-id", cwd: projectRoot });
  const changed = await invoke("codex.agent_start", { prompt: "CHANGED", requestId: "same-id", cwd: projectRoot });
  assert.equal(changed.isError, true);
  assert.match(changed.structuredContent.error ?? "", /different Codex caller intent|different Codex task payload/i);
  assert.equal(starts.length, 0);
});

test("prepared start conservatively falls back to trusted read-only only for ambiguous inherited authority", async () => {
  const calls = [];
  const authorityExecutor = {
    async resolveAuthority({ cwd, access }) {
      calls.push(access);
      if (access === "inherit") throw new Error("authority resolver capability gate failed closed: activePermissionProfile is null and config/read provides no explicit default_permissions provenance");
      assert.equal(access, "readOnly");
      return { effectiveCwd: path.resolve(cwd ?? projectRoot), permissionProfile: ":read-only", permissionCeiling: ":read-only", authoritySource: "trusted-read-only-downscope", trustedAncestor: projectRoot };
    },
  };
  const { starts, invoke } = createHarness({ authorityExecutor });
  const prepared = await invoke("codex.agent_start", { prompt: "AMBIGUOUS_AUTHORITY", requestId: "ambiguous-authority", cwd: projectRoot });
  const taskId = assertPreparedApproval(prepared, { task: "AMBIGUOUS_AUTHORITY" });
  assert.deepEqual(calls, ["inherit", "readOnly"]);
  const committed = await invoke("codex.agent_commit", { taskId });
  assert.equal(committed.isError, false);
  assert.deepEqual(calls, ["inherit", "readOnly", "inherit", "readOnly"]);
  assert.equal(starts[0].permissionProfile, ":read-only");
});

test("terminal failure remains conspicuous and does not invent unavailable resource fields", async () => {
  const { invoke } = createHarness();
  const prepared = await invoke("codex.agent_start", { prompt: "FAIL_TERMINAL", requestId: "terminal-failure", cwd: projectRoot, model: "fake-fast", reasoningEffort: "low" });
  const taskId = assertPreparedApproval(prepared, { task: "FAIL_TERMINAL", modelLabel: "Fake Fast", model: "fake-fast", effort: "low" });
  const failed = await invoke("codex.agent_commit", { taskId });
  assert.equal(failed.structuredContent.status, "failed");
  assert.match(failed.content[0].text, /❌/);
  assert.match(failed.content[0].text, /FAKE_TERMINAL_FAILURE/);
  assert.match(failed.content[0].text, /2\.5 s/);
  assert.match(failed.content[0].text, /(Usage|用量|使用量).*(not provided|未提供|提供なし)/i);
});

test("reprepare with changed model/effort binds Yes only to the newly displayed Task ID", async () => {
  const { starts, invoke } = createHarness();
  const first = await invoke("codex.agent_start", { prompt: "REBIND", requestId: "rebind-default", cwd: projectRoot });
  const firstId = assertPreparedApproval(first, { task: "REBIND" });
  const changed = await invoke("codex.agent_start", { prompt: "REBIND", requestId: "rebind-fast", cwd: projectRoot, model: "fake-fast", reasoningEffort: "low" });
  const changedId = assertPreparedApproval(changed, { task: "REBIND", modelLabel: "Fake Fast", model: "fake-fast", effort: "low" });
  assert.notEqual(changedId, firstId);
  await invoke("codex.agent_commit", { taskId: changedId });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].model, "fake-fast");
});

test("prepared approval rejects unsupported effort before consent", async () => {
  const { starts, invoke } = createHarness();
  const rejected = await invoke("codex.agent_start", { prompt: "BAD_EFFORT", requestId: "bad-effort", cwd: projectRoot, model: "fake-fast", reasoningEffort: "ultra" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.structuredContent.error, /fake-fast.*ultra.*supported efforts: low/i);
  assert.equal(starts.length, 0);
});

test("fixed approval makes unavailable quota explicit instead of allowing omission", async () => {
  const harness = createHarness({ quotaProvider: null });
  const prepared = await harness.invoke("codex.agent_start", { prompt: "QUOTA_UNAVAILABLE", requestId: "quota-unavailable", cwd: projectRoot });
  const text = prepared.content[0].text;
  assert.equal(text, prepared.structuredContent.chatPresentation?.text);
  assert.match(text, /Codex quota/i);
  assert.match(text, /not provided/i);
  assert.equal(prepared.structuredContent.chatPresentation?.delivery?.mustPresentVerbatim, true);
  assert.equal(prepared.structuredContent.chatPresentation?.delivery?.requiredFields?.includes("quota"), true);
});

test("fixed approval preserves all authoritative quota windows without locking display format", async () => {
  const harness = createHarness({
    quotaProvider: async () => ({
      status: "ok", observedAt: "2026-08-19T12:00:00.000Z", usage: { status: "unavailable" },
      rateLimits: { status: "ok", value: { limits: [{ key: "codex", limitName: "Codex", windows: [
        { kind: "primary", usedPercent: 27, resetsAt: 1800000000, windowDurationMins: 300 },
        { kind: "secondary", usedPercent: 41, resetsAt: null, windowDurationMins: 10080 },
      ] }] } },
    }),
  });
  const prepared = await harness.invoke("codex.agent_start", { prompt: "QUOTA_WINDOWS", requestId: "quota", cwd: projectRoot });
  const text = prepared.content[0].text;
  assert.equal(text, prepared.structuredContent.chatPresentation?.text);
  assert.match(text, /Codex quota/i);
  const windows = prepared.structuredContent.chatPresentation?.quota?.windows ?? [];
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.kind), ["primary", "secondary"]);
  assert.deepEqual(windows.map((window) => window.remainingPercent), [73, 59]);
  assert.equal(prepared.structuredContent.chatPresentation?.delivery?.requiredFields?.includes("quota"), true);
});

test("neutral agent_decline seals exact prepared Task ID and later Yes cannot revive it", async () => {
  const { server, starts, invoke } = createHarness();
  assert.equal(server.tools.has("codex.agent_portable_decline"), false);
  const prepared = await invoke("codex.agent_start", { prompt: "DECLINE_EXACT", requestId: "decline-exact", cwd: projectRoot });
  const taskId = assertPreparedApproval(prepared, { task: "DECLINE_EXACT" });
  const declined = await invoke("codex.agent_decline", { taskId });
  assert.equal(declined.structuredContent.status, "rejected");
  assert.equal(declined.content[0].text.includes("Codex · Result"), false);
  const duplicateNo = await invoke("codex.agent_decline", { taskId });
  assert.equal(duplicateNo.structuredContent.duplicate, true);
  const staleYes = await invoke("codex.agent_commit", { taskId });
  assert.equal(staleYes.structuredContent.status, "rejected");
  assert.equal(staleYes.structuredContent.duplicate, true);
  assert.equal(starts.length, 0);
});

test("reasoningEffort remains opt-in and historical card/portable tools are absent on normal registration", () => {
  const { server } = createHarness({ agentReasoningEffort: false });
  const start = server.tools.get("codex.agent_start")?.definition;
  const send = server.tools.get("codex.agent_send")?.definition;
  for (const definition of [start, send]) {
    assert.match(definition?.description ?? "", /MUST equal the returned content\[0\]\.text \/ chatPresentation\.text verbatim/);
    assert.match(definition?.description ?? "", /no prose before or after/);
    assert.match(definition?.description ?? "", /no summary, rewrite, reordering, translation, or field omission/);
  }
  assert.equal(Object.hasOwn(start?.inputSchema?.shape ?? {}, "reasoningEffort"), false);
  assert.equal(Object.hasOwn(send?.inputSchema?.shape ?? {}, "reasoningEffort"), false);
  assert.equal(Object.hasOwn(start?.inputSchema?.shape ?? {}, "consentRef"), false);
  assert.equal(Object.hasOwn(send?.inputSchema?.shape ?? {}, "consentRef"), false);
  for (const name of ["codex.agent_card_render", "codex.agent_card_state", "codex.agent_portable_commit", "codex.agent_portable_decline"]) {
    assert.equal(server.tools.has(name), false, `${name} must not be discoverable`);
  }
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { registerAgentPreviewTools } from "../src/agent-tools.mjs";
import { AGENT_TASK_CARD_URI } from "../src/agent-card-ui.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

function captureServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
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
      tokenUsage: {
        turn: { totalTokens: 12 },
        threadTotal: { totalTokens: 31 },
      },
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

function createHarness({ agentReasoningEffort = true, quotaProvider = async () => quotaSnapshot(), authorityExecutor: authorityExecutorOverride = null } = {}) {
  const server = captureServer();
  const starts = [];
  const sends = [];
  const agents = new Map();
  let sequence = 0;
  const models = [
    {
      id: "fake-default",
      model: "fake-default",
      displayName: "Fake Default",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "ultra", description: "Deep" },
      ],
    },
    {
      id: "fake-fast",
      model: "fake-fast",
      displayName: "Fake Fast",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
    },
  ];
  const authorityExecutor = authorityExecutorOverride ?? { async resolveAuthority({ cwd }) { return { effectiveCwd: path.resolve(cwd ?? projectRoot), permissionProfile: "portable-test-authority", permissionCeiling: "portable-test-authority", authoritySource: "test", trustedAncestor: projectRoot }; } };
  const agentExecutor = {
    async listModels() { return { models: structuredClone(models), nextCursor: null }; },
    async start(args) {
      starts.push(structuredClone(args));
      sequence += 1;
      const snapshot = agentSnapshot({
        agentRef: `agent_portable_${sequence}`,
        turnId: `turn_portable_${sequence}`,
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
        snapshot.timing = { startedAt: Date.now() - 2_500, endedAt: Date.now(), durationMs: 2_500 };
      }
      agents.set(snapshot.agentRef, snapshot);
      return structuredClone(snapshot);
    },
    async show({ agentRef }) { const snapshot = agents.get(agentRef); if (!snapshot) throw new Error(`unknown fake agent ${agentRef}`); return structuredClone(snapshot); },
    async send(args) {
      sends.push(structuredClone(args));
      sequence += 1;
      const prior = agents.get(args.agentRef);
      const snapshot = agentSnapshot({
        agentRef: args.agentRef,
        turnId: `turn_portable_${sequence}`,
        finalResult: `SENT:${args.message}`,
        model: args.model ?? prior?.execution?.resolvedModel,
        requestedReasoningEffort: args.reasoningEffort ?? null,
        reasoningEffort: prior?.execution?.reasoningEffort ?? null,
      });
      agents.set(snapshot.agentRef, snapshot);
      return structuredClone(snapshot);
    },
    async resolveApproval() { throw new Error("not used"); },
    async cancel() { throw new Error("not used"); },
  };
  registerAgentPreviewTools(server, { agentExecutor, authorityExecutor, meteredConsentMode: "always", meteredQuotaProvider: quotaProvider, agentPortableCard: true, agentReasoningEffort });
  async function invoke(name, args) { const entry = server.tools.get(name); assert.ok(entry, `missing tool ${name}`); return entry.handler(args); }
  return { server, starts, sends, invoke };
}

function assertPortableCard(result, { task, model = "fake-default", reasoningEffort = "medium" } = {}) {
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  const text = result.content?.[0]?.text ?? "";
  const payload = result.structuredContent;
  assert.doesNotMatch(text, /[┌┐└┘│─]/, "Portable Card fallback should stay plain text inside the writing surface");
  assert.match(text, /⚠️/);
  assert.match(text, /Call Codex\?|调用 Codex？|Codexを呼び出しますか？/i);
  assert.doesNotMatch(text, /\[ Yes \]/);
  assert.doesNotMatch(text, /\[ No \]/);
  assert.match(text, new RegExp(task));
  assert.match(text, /63%/);
  assert.match(text, /reply|回复|返信/i);
  const selectedOption = payload.manualFallback?.modelSelection?.models?.find((option) => option?.model === model) ?? null;
  const expectedModelLabel = selectedOption?.displayName || model;
  assert.match(text, new RegExp(expectedModelLabel));
  if (selectedOption?.displayName && selectedOption.displayName !== model) {
    assert.doesNotMatch(text, new RegExp(`${selectedOption.displayName} \\(${model}\\)`));
  }
  assert.doesNotMatch(text, /Available models|可选模型|選択可能なモデル/);
  assert.doesNotMatch(text, model === "fake-fast" ? /fake-default/ : /fake-fast/);
  if (reasoningEffort) {
    assert.match(text, /Reasoning effort|推理强度|推論強度/);
    assert.match(text, new RegExp(reasoningEffort));
  }
  assert.doesNotMatch(text, /Available efforts|可选推理强度|選択可能な推論強度/);
  assert.doesNotMatch(text, /change the model|换模型|モデルや推論強度|重新准备|再準備|Yes .*only|Yes 只批准|Yes は/i);
  assert.doesNotMatch(text, /Task ID|C-[A-F0-9]{10}/);
  assert.doesNotMatch(text, /CWD:|Authority:|Risk:|server-bound/i);
  assert.doesNotMatch(text, /agent_portable_commit|agent_portable_decline/);
  assert.doesNotMatch(text, /consent_[0-9a-f-]+/i);
  assert.doesNotMatch(text, /task_[0-9a-f-]+/i);
  assert.equal(payload.manualFallback?.kind, "portable_card");
  assert.equal(payload.manualFallback?.portable, true);
  assert.deepEqual(payload.manualFallback?.choices, ["Yes", "No"]);
  assert.equal(payload.manualFallback?.modelSelection?.source, "codex.model_list");
  assert.equal(payload.manualFallback?.modelSelection?.selectedModel, model);
  assert.equal(payload.manualFallback?.modelSelection?.selectedReasoningEffort ?? null, reasoningEffort ?? null);
  assert.equal(payload.manualFallback?.rebind?.requiresNewRequestId, true);
  assert.match(payload.shortTaskId, /^C-[A-F0-9]{10}$/);
  assert.equal(payload.taskCard?.shortTaskId, payload.shortTaskId);
  assert.equal(payload.taskCard?.modelSelection?.selectedModel, model);
  return payload.shortTaskId;
}

test("Portable Card resolves and shows default model/effort, while explicit choices stay exact", async () => {
  const { invoke } = createHarness();
  const defaultPrepared = await invoke("codex.agent_start", { prompt: "PORTABLE_DEFAULT_TASK", requestId: "portable-default", cwd: projectRoot });
  const defaultId = assertPortableCard(defaultPrepared, { task: "PORTABLE_DEFAULT_TASK", model: "fake-default", reasoningEffort: "medium" });
  assert.equal(defaultPrepared.structuredContent.taskCard.requestedModel, null);
  assert.equal(defaultPrepared.structuredContent.taskCard.requestedReasoningEffort, "medium");
  assert.equal(defaultPrepared.structuredContent.taskCard.modelSelection.selectedModel, "fake-default");
  assert.equal(defaultPrepared.structuredContent.taskCard.modelSelection.selectedReasoningEffort, "medium");
  assert.equal(defaultPrepared.structuredContent.execution.requestedModel, "fake-default");
  assert.equal(defaultPrepared.structuredContent.execution.requestedReasoningEffort, "medium");
  const rendered = await invoke("codex.agent_card_render", { consentRef: defaultPrepared.structuredContent.meteredConsent.consentRef });
  assert.deepEqual(rendered.structuredContent.taskCard, defaultPrepared.structuredContent.taskCard, "Rich and Portable must consume the same prepared task/card fields");
  assert.equal(rendered.structuredContent.manualFallback.text, defaultPrepared.structuredContent.manualFallback.text);
  assert.equal(rendered.structuredContent.manualFallback.taskId, defaultPrepared.structuredContent.shortTaskId);

  const first = await invoke("codex.agent_start", { prompt: "PORTABLE_FIRST_TASK", requestId: "portable-first", cwd: projectRoot, model: "fake-default", reasoningEffort: "ultra" });
  const firstId = assertPortableCard(first, { task: "PORTABLE_FIRST_TASK", model: "fake-default", reasoningEffort: "ultra" });
  assert.equal(first.structuredContent.taskCard.requestedReasoningEffort, "ultra");
  const repeated = await invoke("codex.agent_start", { prompt: "PORTABLE_FIRST_TASK", requestId: "portable-first", cwd: projectRoot, model: "fake-default", reasoningEffort: "ultra" });
  assert.equal(repeated.structuredContent.shortTaskId, firstId);
  const conflict = await invoke("codex.agent_start", { prompt: "PORTABLE_FIRST_TASK", requestId: "portable-first", cwd: projectRoot, model: "fake-default", reasoningEffort: "medium" });
  assert.equal(conflict.isError, true);
  const second = await invoke("codex.agent_start", { prompt: "PORTABLE_SECOND_TASK", requestId: "portable-second", cwd: projectRoot });
  assert.notEqual(assertPortableCard(second, { task: "PORTABLE_SECOND_TASK" }), defaultId);
});

test("Portable approve is exact server-bound prepared start/send", async () => {
  const { server, starts, sends, invoke } = createHarness();
  const commitDefinition = server.tools.get("codex.agent_portable_commit")?.definition;
  assert.equal(commitDefinition.inputSchema.safeParse({}).success, false);
  assert.equal(commitDefinition.inputSchema.safeParse({ taskId: "C-0000000000", prompt: "OVERRIDE" }).success, false);
  const wrong = await invoke("codex.agent_portable_commit", { taskId: "C-0000000000" });
  assert.equal(wrong.isError, true);
  const prepared = await invoke("codex.agent_start", { prompt: "EXACT_BOUND_PROMPT", requestId: "portable-bound-start", cwd: projectRoot, model: "fake-default", reasoningEffort: "ultra" });
  assertPortableCard(prepared, { task: "EXACT_BOUND_PROMPT", model: "fake-default", reasoningEffort: "ultra" });
  const committed = await invoke("codex.agent_portable_commit", { taskId: prepared.structuredContent.shortTaskId });
  assert.equal(committed.isError, false);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].task, "EXACT_BOUND_PROMPT");
  assert.equal(starts[0].reasoningEffort, "ultra");
  const committedText = committed.content?.[0]?.text ?? "";
  assert.equal(committed.structuredContent.resourceReceipt.tokenUsage.turn.totalTokens, 12);
  assert.equal(committed.structuredContent.resourceReceipt.tokenUsage.threadTotal.totalTokens, 31);
  assert.notEqual(committed.structuredContent.resourceReceipt.tokenUsage.turn.totalTokens, committed.structuredContent.resourceReceipt.tokenUsage.threadTotal.totalTokens);
  assert.match(committedText, /✅/);
  assert.match(committedText, /STARTED:EXACT_BOUND_PROMPT/);
  assert.match(committedText, /31 tokens/, "Portable terminal Usage must show cumulative threadTotal tokens");
  assert.doesNotMatch(committedText, /12 tokens/, "Portable terminal Usage must not show current-turn tokens");
  assert.match(committedText, /63%/, "Portable terminal quota must remain visible independently from token Usage");
  assert.match(committedText, /(Reasoning effort|推理强度|推論強度).*ultra/);
  assert.match(committedText, /(Duration|耗时|所要時間)/);
  assert.match(committedText, /(before|调用前|呼び出し前)/);
  assert.match(committedText, /(after|调用后观测|呼び出し後の観測)/);
  assert.doesNotMatch(committedText, /reply.*Yes.*No|回复.*Yes.*No|返信.*Yes.*No/i);
  const sendPrepared = await invoke("codex.agent_send", { agentRef: committed.structuredContent.agentRef, message: "EXACT_BOUND_FOLLOWUP", requestId: "portable-bound-send", model: "fake-fast", reasoningEffort: "low" });
  assertPortableCard(sendPrepared, { task: "EXACT_BOUND_FOLLOWUP", model: "fake-fast", reasoningEffort: "low" });
  const sendCommitted = await invoke("codex.agent_portable_commit", { taskId: sendPrepared.structuredContent.shortTaskId });
  assert.equal(sendCommitted.isError, false);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].message, "EXACT_BOUND_FOLLOWUP");
  assert.equal(sends[0].model, "fake-fast");
  assert.equal(sends[0].reasoningEffort, "low");
  const sendCommittedText = sendCommitted.content?.[0]?.text ?? "";
  assert.equal(sendCommitted.structuredContent.resourceReceipt.tokenUsage.turn.totalTokens, 12);
  assert.equal(sendCommitted.structuredContent.resourceReceipt.tokenUsage.threadTotal.totalTokens, 31);
  assert.notEqual(sendCommitted.structuredContent.resourceReceipt.tokenUsage.turn.totalTokens, sendCommitted.structuredContent.resourceReceipt.tokenUsage.threadTotal.totalTokens);
  assert.match(sendCommittedText, /31 tokens/);
  assert.doesNotMatch(sendCommittedText, /12 tokens/);
  assert.match(sendCommittedText, /63%/);
  assert.match(sendCommittedText, /SENT:EXACT_BOUND_FOLLOWUP/);
  assert.match(sendCommittedText, /(Reasoning effort|推理强度|推論強度).*ultra/, "terminal receipt must show observed reasoning effort, not merely the requested follow-up effort");
  assert.doesNotMatch(sendCommittedText, /(Reasoning effort|推理强度|推論強度).*low/);
});

test("Portable start conservatively falls back to trusted read-only only for ambiguous inherited authority", async () => {
  const calls = [];
  const authorityExecutor = {
    async resolveAuthority({ cwd, access }) {
      calls.push(access);
      if (access === "inherit") {
        throw new Error("authority resolver capability gate failed closed: activePermissionProfile is null and config/read provides neither explicit default_permissions nor supported sandbox_mode/approval_policy provenance");
      }
      assert.equal(access, "readOnly");
      return {
        effectiveCwd: path.resolve(cwd ?? projectRoot),
        permissionProfile: ":read-only",
        permissionCeiling: ":read-only",
        authoritySource: "trusted-read-only-downscope",
        trustedAncestor: projectRoot,
      };
    },
  };
  const { starts, invoke } = createHarness({ authorityExecutor });
  const prepared = await invoke("codex.agent_start", {
    prompt: "AMBIGUOUS_AUTHORITY_PORTABLE",
    requestId: "portable-ambiguous-authority",
    cwd: projectRoot,
  });
  assertPortableCard(prepared, { task: "AMBIGUOUS_AUTHORITY_PORTABLE" });
  assert.deepEqual(calls, ["inherit", "readOnly"]);

  const committed = await invoke("codex.agent_portable_commit", { taskId: prepared.structuredContent.shortTaskId });
  assert.equal(committed.isError, false, JSON.stringify(committed.structuredContent));
  assert.deepEqual(calls, ["inherit", "readOnly", "inherit", "readOnly"]);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].permissionProfile, ":read-only");
});

test("Portable terminal failure receipt stays conspicuous and names unavailable authoritative fields", async () => {
  const { invoke } = createHarness();
  const prepared = await invoke("codex.agent_start", {
    prompt: "FAIL_TERMINAL",
    requestId: "portable-terminal-failure",
    cwd: projectRoot,
    model: "fake-fast",
    reasoningEffort: "low",
  });
  assertPortableCard(prepared, { task: "FAIL_TERMINAL", model: "fake-fast", reasoningEffort: "low" });
  const failed = await invoke("codex.agent_portable_commit", { taskId: prepared.structuredContent.shortTaskId });
  assert.equal(failed.isError, false);
  assert.equal(failed.structuredContent.status, "failed");
  const text = failed.content?.[0]?.text ?? "";
  assert.match(text, /❌/);
  assert.match(text, /FAKE_TERMINAL_FAILURE/);
  assert.match(text, /2\.5 s/);
  assert.match(text, /(Model|模型|モデル).*(not provided|未提供|提供なし)/i);
  assert.match(text, /(Reasoning effort|推理强度|推論強度).*(not provided|未提供|提供なし)/i);
  assert.match(text, /(Usage|用量|使用量).*(not provided|未提供|提供なし)/i);
  assert.match(text, /(before|调用前|呼び出し前)/);
  assert.match(text, /(after|调用后观测|呼び出し後の観測)/);
  assert.doesNotMatch(text, /12 tokens|31 tokens/);
});

test("Portable natural-language reprepare binds Yes only to the newly displayed selection", async () => {
  const { starts, invoke } = createHarness();
  const first = await invoke("codex.agent_start", { prompt: "REBIND_TASK", requestId: "portable-rebind-default", cwd: projectRoot });
  const firstId = assertPortableCard(first, { task: "REBIND_TASK", model: "fake-default", reasoningEffort: "medium" });
  const changed = await invoke("codex.agent_start", { prompt: "REBIND_TASK", requestId: "portable-rebind-fast", cwd: projectRoot, model: "fake-fast", reasoningEffort: "low" });
  const changedId = assertPortableCard(changed, { task: "REBIND_TASK", model: "fake-fast", reasoningEffort: "low" });
  assert.notEqual(changedId, firstId);
  const committed = await invoke("codex.agent_portable_commit", { taskId: changedId });
  assert.equal(committed.isError, false);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].model, "fake-fast");
  assert.equal(starts[0].reasoningEffort, "low");
});

test("Portable preparation rejects an effort unsupported by the selected model before consent", async () => {
  const { starts, invoke } = createHarness();
  const rejected = await invoke("codex.agent_start", { prompt: "BAD_EFFORT", requestId: "portable-bad-effort", cwd: projectRoot, model: "fake-fast", reasoningEffort: "ultra" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.structuredContent.error, /fake-fast.*ultra.*supported efforts: low/i);
  assert.equal(starts.length, 0);
});

test("Portable quota mirrors every returned window with duration, remaining, and reset availability", async () => {
  const withMultiple = createHarness({
    quotaProvider: async () => ({
      status: "ok",
      observedAt: "2026-08-19T12:00:00.000Z",
      usage: { status: "unavailable" },
      rateLimits: {
        status: "ok",
        value: {
          limits: [{
            key: "codex",
            limitName: "Codex",
            windows: [
              { kind: "primary", usedPercent: 27, resetsAt: 1800000000, windowDurationMins: 300 },
              { kind: "secondary", usedPercent: 41, resetsAt: null, windowDurationMins: 10_080 },
            ],
          }],
        },
      },
    }),
  });
  const prepared = await withMultiple.invoke("codex.agent_start", { prompt: "QUOTA_WINDOWS", requestId: "portable-quota", cwd: projectRoot });
  const text = prepared.content?.[0]?.text ?? "";
  assert.match(text, /5h/);
  assert.match(text, /73%/);
  assert.match(text, /7d/);
  assert.match(text, /59%/);
  assert.match(text, /reset|重置|リセット/i);
  assert.match(text, /unavailable|未提供|提供なし/i);
  assert.equal(prepared.structuredContent.manualFallback.modelSelection.selectedModel, "fake-default");
});

test("Portable decline seals exact prepared task", async () => {
  const { starts, invoke } = createHarness();
  const prepared = await invoke("codex.agent_start", { prompt: "DECLINE_EXACT_TASK", requestId: "portable-decline", cwd: projectRoot });
  const consentRef = prepared.structuredContent.meteredConsent.consentRef;
  const declined = await invoke("codex.agent_portable_decline", { taskId: prepared.structuredContent.shortTaskId });
  assert.equal(declined.structuredContent.status, "rejected");
  assert.equal(declined.structuredContent.suppressManualFallback, true);
  assert.equal(Object.hasOwn(declined.structuredContent, "manualFallback"), false, "user-authored conversational No must not produce a second terminal fallback block");
  const portableRevive = await invoke("codex.agent_portable_commit", { taskId: prepared.structuredContent.shortTaskId });
  assert.equal(portableRevive.structuredContent.status, "rejected");
  assert.equal(Object.hasOwn(portableRevive.structuredContent, "manualFallback"), false);
  const appRevive = await invoke("codex.agent_commit", { consentRef });
  assert.equal(appRevive.structuredContent.status, "rejected");
  assert.equal(Object.hasOwn(appRevive.structuredContent, "manualFallback"), false);
  assert.equal(starts.length, 0);
});

test("reasoningEffort remains opt-in on the shared Agent registration", () => {
  const { server } = createHarness({ agentReasoningEffort: false });
  const start = server.tools.get("codex.agent_start")?.definition;
  const send = server.tools.get("codex.agent_send")?.definition;
  assert.equal(Object.hasOwn(start?.inputSchema?.shape ?? {}, "reasoningEffort"), false);
  assert.equal(Object.hasOwn(send?.inputSchema?.shape ?? {}, "reasoningEffort"), false);
  assert.equal(start?.inputSchema.safeParse({ prompt: "x", requestId: "r", reasoningEffort: "ultra" }).success, false);
  assert.equal(send?.inputSchema.safeParse({ agentRef: "a", message: "x", requestId: "r", reasoningEffort: "ultra" }).success, false);
});

test("Rich Card v13 remains registered and Portable wrappers are model-callable", () => {
  const { server } = createHarness();
  const render = server.tools.get("codex.agent_card_render")?.definition;
  const appCommit = server.tools.get("codex.agent_commit")?.definition;
  const appDecline = server.tools.get("codex.agent_decline")?.definition;
  const portableCommit = server.tools.get("codex.agent_portable_commit")?.definition;
  const portableDecline = server.tools.get("codex.agent_portable_decline")?.definition;
  const start = server.tools.get("codex.agent_start")?.definition;
  const send = server.tools.get("codex.agent_send")?.definition;
  assert.equal(render?._meta?.ui?.resourceUri, AGENT_TASK_CARD_URI);
  assert.deepEqual(appCommit?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(appDecline?._meta?.ui?.visibility, ["app"]);
  assert.equal(portableCommit?._meta?.ui?.visibility, undefined);
  assert.equal(portableDecline?._meta?.ui?.visibility, undefined);
  assert.equal(start?.inputSchema.safeParse({ prompt: "x", requestId: "r", reasoningEffort: "ultra" }).success, true);
  assert.equal(send?.inputSchema.safeParse({ agentRef: "a", message: "x", requestId: "r", reasoningEffort: "ultra" }).success, true);
  assert.equal(start?.inputSchema.safeParse({ prompt: "x", requestId: "r", reasoningEffort: "x".repeat(129) }).success, false);
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAccountAgentExecutor } from "../src/codex-account-agent-executor.mjs";
import {
  assertCodexAccountHome,
  loadCodexAccountRegistry,
  resolveCodexAccount,
} from "../src/codex-account-registry.mjs";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";
import { computeCodexAuthorityPolicyHash } from "../src/codex-authority-executor.mjs";
import { registerWorkbenchPreviewTools } from "../src/workbench-tools.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "codexless-accounts-"));
try {
  const primaryHome = path.join(root, "managed-codex-home");
  const secondaryHome = path.join(root, "managed-codex-home-secondary");
  mkdirSync(primaryHome);
  mkdirSync(secondaryHome);

  const legacy = await loadCodexAccountRegistry({ stateRoot: root, filePath: path.join(root, "missing.json") });
  assert.equal(legacy.source, "legacy");
  assert.equal(resolveCodexAccount(legacy).id, "default");

  const legacyCalls = [];
  const legacyRouter = new CodexAccountAgentExecutor({
    registry: legacy,
    factory: async (account) => ({
      running: false,
      async open() { this.running = true; },
      async close() { this.running = false; },
      async listModels() { return { models: [{ id: account.id }], nextCursor: null }; },
      async start(input) { legacyCalls.push(input); return { agentRef: "legacy-agent", turnId: "legacy-turn", status: "idle", canSend: true }; },
      async show(input) { return { agentRef: input.agentRef, turnId: "legacy-turn", status: "idle", canSend: true }; },
    }),
  });
  await legacyRouter.open();
  assert.equal(legacyRouter.resolveAccountId(), null);
  assert.equal((await legacyRouter.listModels()).models[0].id, "default");
  const legacyStarted = await legacyRouter.start({ clientRequestId: "legacy-1", task: "legacy" });
  assert.equal(Object.hasOwn(legacyStarted, "account"), false, "legacy mode must not add an account field to public snapshots");
  assert.equal(legacyRouter.accountForAgent("legacy-agent"), null, "legacy metadata must not synthesize an account on follow-up cards");
  await legacyRouter.close();

  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "codexless-account-outside-"));
  try {
    const escapedHome = path.join(root, "managed-codex-home-escape");
    symlinkSync(outsideRoot, escapedHome, process.platform === "win32" ? "junction" : "dir");
    const escapedRegistryPath = path.join(root, "escaped-home.json");
    writeFileSync(escapedRegistryPath, JSON.stringify({
      schemaVersion: 1,
      accounts: [{ id: "escape", home: "managed-codex-home-escape" }],
    }));
    const escapedRegistry = await loadCodexAccountRegistry({ stateRoot: root, filePath: escapedRegistryPath });
    await assert.rejects(
      () => assertCodexAccountHome(resolveCodexAccount(escapedRegistry, "escape"), { stateRoot: root }),
      (error) => error?.code === "CODEX_ACCOUNT_HOME_UNSAFE"
    );
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }

  const aliasHome = path.join(root, "managed-codex-home-alias");
  symlinkSync(primaryHome, aliasHome, process.platform === "win32" ? "junction" : "dir");
  const aliasRegistryPath = path.join(root, "alias-home.json");
  writeFileSync(aliasRegistryPath, JSON.stringify({
    schemaVersion: 1,
    accounts: [
      { id: "primary", home: "managed-codex-home" },
      { id: "alias", home: "managed-codex-home-alias" },
    ],
  }));
  const aliasRegistry = await loadCodexAccountRegistry({ stateRoot: root, filePath: aliasRegistryPath });
  await assert.rejects(
    () => assertCodexAccountHome(resolveCodexAccount(aliasRegistry, "alias"), { stateRoot: root, registry: aliasRegistry }),
    (error) => error?.code === "CODEX_ACCOUNT_HOME_UNSAFE" && /real directory|junction|symlink/i.test(error.message)
  );
  await assert.rejects(
    () => assertCodexAccountHome({ id: "root", codexHome: root }, { stateRoot: root }),
    (error) => error?.code === "CODEX_ACCOUNT_HOME_UNSAFE" && /direct child/i.test(error.message)
  );
  await assert.rejects(
    () => assertCodexAccountHome({ id: "nested", codexHome: path.join(root, "nested", "home") }, { stateRoot: root }),
    (error) => error?.code === "CODEX_ACCOUNT_HOME_UNSAFE" && /direct child/i.test(error.message)
  );

  const duplicateHomeRegistry = path.join(root, "duplicate-home.json");
  writeFileSync(duplicateHomeRegistry, JSON.stringify({
    schemaVersion: 1,
    accounts: [
      { id: "primary", home: "managed-codex-home" },
      { id: "secondary", home: "managed-codex-home" },
    ],
  }));
  await assert.rejects(
    () => loadCodexAccountRegistry({ stateRoot: root, filePath: duplicateHomeRegistry }),
    (error) => error?.code === "CODEX_ACCOUNT_REGISTRY_INVALID" && /duplicate Codex account home/i.test(error.message)
  );

  const registryPath = path.join(root, "codex-accounts.json");
  writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 1,
    accounts: [
      { id: "primary", home: "managed-codex-home" },
      { id: "secondary", home: "managed-codex-home-secondary" },
    ],
  }));
  const registry = await loadCodexAccountRegistry({ stateRoot: root, filePath: registryPath });
  assert.deepEqual(registry.accounts.map((entry) => entry.id), ["primary", "secondary"]);
  assert.equal(Object.isFrozen(registry), true, "loaded registry must be immutable");
  assert.equal(Object.isFrozen(registry.accounts), true, "loaded account list must be immutable");
  assert.equal(Object.isFrozen(registry.accounts[0]), true, "loaded account entries must be immutable");
  assert.equal((await assertCodexAccountHome(resolveCodexAccount(registry, "primary"), { stateRoot: root, registry })).toLowerCase(), primaryHome.toLowerCase());
  assert.throws(() => resolveCodexAccount(registry), (error) => error?.code === "CODEX_ACCOUNT_REQUIRED");
  assert.throws(() => resolveCodexAccount(registry, "other"), (error) => error?.code === "CODEX_ACCOUNT_UNKNOWN");

  for (const home of [
    "../outside",
    "nested/home",
    "nested\\home",
    ".",
    "..",
    "C:\\outside",
    "CON",
    "nul.txt",
    "COM1",
    "trailing.",
    "trailing ",
  ]) {
    const bad = path.join(root, `bad-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(bad, JSON.stringify({ schemaVersion: 1, accounts: [{ id: "primary", home }] }));
    await assert.rejects(
      () => loadCodexAccountRegistry({ stateRoot: root, filePath: bad }),
      (error) => error?.code === "CODEX_ACCOUNT_REGISTRY_INVALID"
    );
  }

  const calls = [];
  class FakeDelegate {
    constructor(id) { this.id = id; this.running = false; }
    async open() { this.running = true; }
    async close() { this.running = false; }
    async listModels(input) { calls.push([this.id, "listModels", input]); return { models: [{ id: this.id }], nextCursor: null }; }
    async start(input) { calls.push([this.id, "start", input]); return { agentRef: `${this.id}-${input.clientRequestId}-agent`, turnId: `${this.id}-${input.clientRequestId}-turn`, status: "idle", canSend: true }; }
    async show(input) { calls.push([this.id, "show", input]); return { agentRef: input.agentRef, turnId: `${this.id}-turn`, status: "idle", canSend: true }; }
    async send(input) { calls.push([this.id, "send", input]); return { agentRef: input.agentRef, turnId: `${this.id}-turn-2`, status: "idle", canSend: true }; }
    async cancel(input) { calls.push([this.id, "cancel", input]); return { agentRef: input.agentRef, turnId: input.expectedTurnId ?? null, status: "interrupted", canSend: false }; }
    async resolveApproval(input) { calls.push([this.id, "resolveApproval", input]); return { agentRef: input.agentRef, status: "running" }; }
    async resolvePendingRequest(input) { calls.push([this.id, "resolvePendingRequest", input]); return { agentRef: input.agentRef, status: "running" }; }
    async rejectPendingRequest(input) { calls.push([this.id, "rejectPendingRequest", input]); return { agentRef: input.agentRef, status: "running" }; }
  }

  const quotaAccounts = [];
  const preflightAccounts = [];
  const factoryAccounts = [];
  const router = new CodexAccountAgentExecutor({
    registry,
    factory: async (account) => { factoryAccounts.push(account.id); return new FakeDelegate(account.id); },
    quotaProvider: async (account) => { quotaAccounts.push(account.id); return { status: "ok", account: account.id }; },
    preflightProvider: async (account) => { preflightAccounts.push(account.id); return { status: "ok", selectedAccount: account.id }; },
  });
  await router.open();
  await assert.rejects(() => router.listModels({}), (error) => error?.code === "CODEX_ACCOUNT_REQUIRED");
  await assert.rejects(() => router.accountPreflight({}), (error) => error?.code === "CODEX_ACCOUNT_REQUIRED");
  assert.equal((await router.listModels({ account: "secondary" })).models[0].id, "secondary");
  const started = await router.start({ account: "secondary", clientRequestId: "req-1", task: "x" });
  assert.equal(started.account, "secondary");
  assert.equal(router.accountForAgent(started.agentRef), "secondary");
  assert.equal((await router.show({ agentRef: started.agentRef })).account, "secondary");
  assert.equal((await router.send({ agentRef: started.agentRef, message: "next" })).account, "secondary");
  assert.equal((await router.quotaSnapshot({ agentRef: started.agentRef })).account, "secondary");
  assert.equal((await router.accountPreflight({ account: "primary" })).selectedAccount, "primary");
  assert.deepEqual(quotaAccounts, ["secondary"]);
  assert.deepEqual(preflightAccounts, ["primary"]);
  await assert.rejects(
    () => router.start({ account: "primary", clientRequestId: "req-1", task: "different account" }),
    (error) => error?.code === "CODEX_REQUEST_CONFLICT"
  );
  assert.equal(calls.some(([id, method]) => id === "primary" && method === "start"), false);
  const [parallelPrimary, parallelSecondary] = await Promise.all([
    router.start({ account: "primary", clientRequestId: "req-primary-parallel", task: "primary-parallel" }),
    router.start({ account: "secondary", clientRequestId: "req-secondary-parallel", task: "secondary-parallel" }),
  ]);
  assert.equal(parallelPrimary.account, "primary");
  assert.equal(parallelSecondary.account, "secondary");
  assert.notEqual(parallelPrimary.agentRef, parallelSecondary.agentRef);
  assert.deepEqual([...factoryAccounts].sort(), ["primary", "secondary"], "one delegate/App Server factory per configured account");

  const primarySend = await router.send({
    agentRef: parallelPrimary.agentRef,
    message: "PRIMARY_ONLY",
    clientRequestId: "cross-account-send",
  });
  assert.equal(primarySend.account, "primary");
  await assert.rejects(
    () => router.send({
      agentRef: parallelSecondary.agentRef,
      message: "SECONDARY_MUST_NOT_REUSE",
      clientRequestId: "cross-account-send",
    }),
    (error) => error?.code === "CODEX_REQUEST_CONFLICT"
  );
  const primaryCancel = await router.cancel({
    agentRef: parallelPrimary.agentRef,
    clientRequestId: "cross-account-control",
    expectedTurnId: parallelPrimary.turnId,
  });
  assert.equal(primaryCancel.account, "primary");
  await assert.rejects(
    () => router.cancel({
      agentRef: parallelSecondary.agentRef,
      clientRequestId: "cross-account-control",
      expectedTurnId: parallelSecondary.turnId,
    }),
    (error) => error?.code === "CODEX_REQUEST_CONFLICT"
  );

  await router.close();
  await assert.rejects(() => router.listModels({ account: "secondary" }), /closed/i);
  await assert.rejects(() => router.accountPreflight({ account: "secondary" }), /closed/i);
  await assert.rejects(() => router.quotaSnapshot({ account: "secondary" }), /closed/i);

  let releaseTelemetry;
  let telemetryEntered;
  const telemetryGate = new Promise((resolve) => { releaseTelemetry = resolve; });
  const telemetryStarted = new Promise((resolve) => { telemetryEntered = resolve; });
  const telemetryRouter = new CodexAccountAgentExecutor({
    registry,
    factory: async (account) => new FakeDelegate(account.id),
    preflightProvider: async (account) => {
      telemetryEntered();
      await telemetryGate;
      return { status: "ok", selectedAccount: account.id };
    },
  });
  await telemetryRouter.open();
  const telemetryCall = telemetryRouter.accountPreflight({ account: "primary" });
  await telemetryStarted;
  let closeSettled = false;
  const closing = telemetryRouter.close().then(() => { closeSettled = true; });
  await Promise.resolve();
  assert.equal(closeSettled, false, "close must wait for in-flight account telemetry");
  releaseTelemetry();
  assert.equal((await telemetryCall).selectedAccount, "primary");
  await closing;
  assert.equal(closeSettled, true);

  const preflightTools = new Map();
  const preflightServer = {
    registerTool(name, definition, handler) { preflightTools.set(name, { definition, handler }); },
  };
  const preflightCalls = [];
  registerWorkbenchPreviewTools(preflightServer, { async accountPreflight() { return { legacy: true }; } }, {
    accountPreflightProvider: async (input) => { preflightCalls.push(input); return { selectedAccount: input.account }; },
  });
  const preflightTool = preflightTools.get("codex.account_preflight");
  assert.equal(preflightTool.definition.inputSchema.safeParse({ account: "secondary" }).success, true);
  const preflightResult = await preflightTool.handler({ account: "secondary" });
  assert.equal(preflightResult.isError, false);
  assert.equal(preflightResult.structuredContent.selectedAccount, "secondary");
  assert.deepEqual(preflightCalls, [{ account: "secondary" }]);

  let capturedLaunchEnv = null;
  const executor = new CodexAgentExecutor({
    defaultCwd: root,
    launchEnv: { CODEX_HOME: secondaryHome },
    clientFactory: ({ launchEnv }) => {
      capturedLaunchEnv = launchEnv;
      return {
        running: false,
        initializedResult: null,
        async start() { this.running = true; return {}; },
        onNotification() { return () => {}; },
        async close() { this.running = false; },
      };
    },
  });
  await executor.open();
  assert.equal(capturedLaunchEnv.CODEX_HOME, secondaryHome);
  await executor.close();

  class RacePolicyClient {
    constructor({ effectiveConfig = {}, permissionRows = [], startedProjection = {}, resumeProjection = null, holdFirstThread = false, holdSecondTurn = false } = {}) {
      this.running = false;
      this.initializedResult = null;
      this.serverRequestMethods = [];
      this.requests = [];
      this.effectiveConfig = structuredClone(effectiveConfig);
      this.permissionRows = structuredClone(permissionRows);
      this.startedProjection = structuredClone(startedProjection);
      this.resumeProjection = structuredClone(resumeProjection ?? startedProjection);
      this.holdFirstThread = holdFirstThread;
      this.holdSecondTurn = holdSecondTurn;
      this.threadStartCount = 0;
      this.policyProbeCount = 0;
      this.turnStartCount = 0;
      this.currentThreadId = null;
      this.currentTurnId = null;
      this.currentTurnStatus = null;
      this.releaseFirstThread = null;
      this.releaseSecondTurn = null;
      this.firstThreadEntered = new Promise((resolve) => { this.signalFirstThread = resolve; });
      this.secondTurnEntered = new Promise((resolve) => { this.signalSecondTurn = resolve; });
      this.firstThreadGate = new Promise((resolve) => { this.releaseFirstThread = resolve; });
      this.secondTurnGate = new Promise((resolve) => { this.releaseSecondTurn = resolve; });
    }
    async start() { this.running = true; this.initializedResult = { ok: true }; return this.initializedResult; }
    onNotification() { return () => {}; }
    async close() { this.running = false; }
    async request(method, params = {}) {
      this.requests.push({ method, params: structuredClone(params) });
      if (method === "thread/start") {
        if (params.ephemeral === true) {
          this.policyProbeCount += 1;
          return {
            ...structuredClone(this.startedProjection),
            thread: { id: `thread-probe-${this.policyProbeCount}`, canAcceptDirectInput: true },
            model: "fake-model",
            modelProvider: "fake",
            serviceTier: null,
            reasoningEffort: null,
          };
        }
        this.threadStartCount += 1;
        if (this.holdFirstThread && this.threadStartCount === 1) {
          this.signalFirstThread();
          await this.firstThreadGate;
        }
        this.currentThreadId = `thread-race-${this.threadStartCount}`;
        return {
          ...structuredClone(this.startedProjection),
          thread: { id: this.currentThreadId, canAcceptDirectInput: true },
          model: "fake-model",
          modelProvider: "fake",
          serviceTier: null,
          reasoningEffort: null,
        };
      }
      if (method === "config/read") return { config: structuredClone(this.effectiveConfig) };
      if (method === "permissionProfile/list") return { data: structuredClone(this.permissionRows) };
      if (method === "model/list") {
        return {
          data: [{
            id: "fake-model",
            model: "fake-model",
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          }],
          nextCursor: null,
        };
      }
      if (method === "turn/start") {
        this.turnStartCount += 1;
        if (this.holdSecondTurn && this.turnStartCount === 2) {
          this.signalSecondTurn();
          await this.secondTurnGate;
        }
        this.currentTurnId = `turn-race-${this.turnStartCount}`;
        this.currentTurnStatus = "completed";
        return { turn: { id: this.currentTurnId, status: this.currentTurnStatus, items: [] } };
      }
      if (method === "thread/turns/list") {
        return {
          data: this.currentTurnId
            ? [{ id: this.currentTurnId, status: this.currentTurnStatus ?? "completed", items: [] }]
            : [],
        };
      }
      if (method === "thread/resume") {
        return {
          ...structuredClone(this.resumeProjection),
          thread: { id: this.currentThreadId, canAcceptDirectInput: true },
          model: "fake-model",
          modelProvider: "fake",
          serviceTier: null,
          reasoningEffort: null,
          turnsBackwardsCursor: null,
          itemsBackwardsCursor: null,
        };
      }
      if (method === "thread/delete") {
        if (typeof params.threadId === "string" && params.threadId.startsWith("thread-probe-")) return {};
        assert.equal(params.threadId, this.currentThreadId);
        return {};
      }
      throw new Error(`unexpected RacePolicyClient request: ${method}`);
    }
  }

  const startRaceClient = new RacePolicyClient({ holdFirstThread: true });
  const startRaceExecutor = new CodexAgentExecutor({
    defaultCwd: root,
    clientFactory: () => startRaceClient,
  });
  await startRaceExecutor.open();
  const firstStart = startRaceExecutor.start({ task: "same", clientRequestId: "same-start-race" });
  await startRaceClient.firstThreadEntered;
  const duplicateStart = startRaceExecutor.start({ task: "same", clientRequestId: "same-start-race" });
  startRaceClient.releaseFirstThread();
  const [firstStartResult, duplicateStartResult] = await Promise.all([firstStart, duplicateStart]);
  assert.equal(startRaceClient.threadStartCount, 1, "concurrent start retries must share one thread/start");
  assert.equal(startRaceClient.turnStartCount, 1, "concurrent start retries must dispatch one model turn");
  assert.equal(firstStartResult.agentRef, duplicateStartResult.agentRef);
  assert.equal(firstStartResult.turnId, duplicateStartResult.turnId);
  assert.equal(duplicateStartResult.duplicate, true);
  await startRaceExecutor.close();

  const permissionRows = [{
    id: "engineering",
    allowed: true,
    sandbox: { type: "workspaceWrite" },
    networkAccess: false,
  }];
  const startedProjection = {
    activePermissionProfile: { id: "engineering" },
    sandbox: { type: "workspaceWrite" },
    runtimeWorkspaceRoots: [root],
    cwd: root,
    modelProvider: "fake",
  };
  const canonicalConfig = {
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    network_access: false,
  };
  const authorityProfile = { permissionProfile: "engineering", permissionCeiling: "engineering" };
  const expectedPolicyHash = computeCodexAuthorityPolicyHash({
    effectiveConfig: canonicalConfig,
    permissionRows,
    authorityProfile,
    started: startedProjection,
  });

  const mismatchedPolicyClient = new RacePolicyClient({
    effectiveConfig: { ...canonicalConfig, network_access: true },
    permissionRows,
    startedProjection,
  });
  const mismatchedPolicyExecutor = new CodexAgentExecutor({
    defaultCwd: root,
    clientFactory: () => mismatchedPolicyClient,
  });
  await mismatchedPolicyExecutor.open();
  await assert.rejects(
    () => mismatchedPolicyExecutor.start({
      task: "must-not-turn",
      clientRequestId: "policy-mismatch",
      permissionProfile: "engineering",
      permissionCeiling: "engineering",
      authorityPolicyHash: expectedPolicyHash,
    }),
    /CODEX_AGENT_AUTHORITY_MISMATCH/
  );
  assert.equal(mismatchedPolicyClient.turnStartCount, 0, "authority mismatch must fail before turn/start");
  await mismatchedPolicyExecutor.close();

  const matchingPolicyClient = new RacePolicyClient({
    effectiveConfig: canonicalConfig,
    permissionRows,
    startedProjection,
    resumeProjection: { ...startedProjection, resumeOnlyDiagnostic: "different-shape" },
    holdSecondTurn: true,
  });
  const matchingPolicyExecutor = new CodexAgentExecutor({
    defaultCwd: root,
    clientFactory: () => matchingPolicyClient,
  });
  await matchingPolicyExecutor.open();
  const policyStarted = await matchingPolicyExecutor.start({
    task: "policy-match",
    clientRequestId: "policy-match",
    permissionProfile: "engineering",
    permissionCeiling: "engineering",
    authorityPolicyHash: expectedPolicyHash,
  });
  assert.equal(policyStarted.status, "idle");
  assert.equal(matchingPolicyClient.turnStartCount, 1);

  const firstSend = matchingPolicyExecutor.send({
    agentRef: policyStarted.agentRef,
    message: "same-send",
    clientRequestId: "same-send-race",
  });
  await matchingPolicyClient.secondTurnEntered;
  const duplicateSend = matchingPolicyExecutor.send({
    agentRef: policyStarted.agentRef,
    message: "same-send",
    clientRequestId: "same-send-race",
  });
  await assert.rejects(
    () => matchingPolicyExecutor.send({
      agentRef: policyStarted.agentRef,
      message: "different-concurrent-send",
      clientRequestId: "different-send-race",
    }),
    /already has an in-flight send/i
  );
  matchingPolicyClient.releaseSecondTurn();
  const [firstSendResult, duplicateSendResult] = await Promise.all([firstSend, duplicateSend]);
  assert.equal(matchingPolicyClient.turnStartCount, 2, "one initial turn plus one concurrent-safe follow-up turn expected");
  assert.equal(matchingPolicyClient.policyProbeCount, 1, "follow-up must revalidate authority with one fresh ephemeral policy probe");
  assert.equal(
    matchingPolicyClient.requests.some(({ method, params }) => method === "thread/delete" && String(params?.threadId ?? "").startsWith("thread-probe-")),
    false,
    "ephemeral follow-up policy probes must not be explicitly deleted"
  );
  assert.equal(firstSendResult.turnId, duplicateSendResult.turnId);
  assert.equal(duplicateSendResult.duplicate, true);

  matchingPolicyClient.effectiveConfig.network_access = true;
  await assert.rejects(
    () => matchingPolicyExecutor.send({
      agentRef: policyStarted.agentRef,
      message: "policy-drift-follow-up",
      clientRequestId: "policy-drift-follow-up",
    }),
    (error) => error?.code === "CODEX_AGENT_AUTHORITY_MISMATCH"
  );
  assert.equal(matchingPolicyClient.turnStartCount, 2, "follow-up policy drift must fail before a third model turn");
  assert.equal(matchingPolicyClient.policyProbeCount, 2, "drifted follow-up must still use a fresh policy probe before failing");
  await matchingPolicyExecutor.close();

  console.log("codex-account-routing: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
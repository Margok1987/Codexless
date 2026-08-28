import assert from "node:assert/strict";
import path from "node:path";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";
import { CodexRpcError } from "../src/codex-app-server-client.mjs";
import { registerAgentPreviewTools } from "../src/agent-tools.mjs";
import { LazyCodexAgentExecutor } from "../src/lazy-codex-agent-executor.mjs";

class FakeClient {
  constructor() {
    this.running = false;
    this.initializedResult = null;
    this.serverRequestMethods = [];
    this.requests = [];
    this.threadId = "thread-steer-1";
    this.currentTurnId = null;
    this.turnStatus = "inProgress";
    this.notificationHandler = null;
    this.steerMode = "accepted";
    this.refreshFails = false;
  }

  async start() {
    this.running = true;
    this.initializedResult = { ok: true };
    return this.initializedResult;
  }

  onNotification(handler) {
    this.notificationHandler = handler;
    return () => {
      if (this.notificationHandler === handler) this.notificationHandler = null;
    };
  }

  emit(method, params) {
    this.notificationHandler?.({ method, params: structuredClone(params) });
  }

  async close() { this.running = false; }

  async request(method, params = {}) {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "thread/start") {
      return {
        thread: { id: this.threadId, canAcceptDirectInput: true },
        model: "fake-model",
        modelProvider: "openai",
        serviceTier: null,
        reasoningEffort: "medium",
      };
    }
    if (method === "turn/start") {
      this.currentTurnId = "turn-steer-1";
      this.turnStatus = "inProgress";
      return { turn: { id: this.currentTurnId, status: this.turnStatus, items: [] } };
    }
    if (method === "thread/turns/list") {
      if (this.refreshFails) throw new Error("official refresh unavailable");
      return {
        data: this.currentTurnId
          ? [{ id: this.currentTurnId, status: this.turnStatus, items: [] }]
          : [],
      };
    }
    if (method === "turn/steer") {
      if (this.steerMode === "rpc-reject") {
        throw new CodexRpcError("turn/steer", { code: -32602, message: "turn is no longer active" });
      }
      if (this.steerMode === "transport-unknown") {
        throw new Error("transport closed before response");
      }
      return { turnId: this.currentTurnId };
    }
    if (method === "thread/resume") {
      return {
        thread: { id: this.threadId, canAcceptDirectInput: true },
        model: "fake-model",
        modelProvider: "openai",
        serviceTier: null,
        reasoningEffort: "medium",
      };
    }
    throw new Error(`unexpected fake request: ${method}`);
  }
}

function steerCount(fake) {
  return fake.requests.filter((entry) => entry.method === "turn/steer").length;
}

const fake = new FakeClient();
const executor = new CodexAgentExecutor({
  defaultCwd: path.resolve("."),
  clientFactory: () => fake,
});
await executor.open();

const started = await executor.start({
  task: "Inspect harmless local fixture and report progress",
  clientRequestId: "steer-progress-start",
});
assert.equal(started.status, "running");
assert.equal(started.turnId, "turn-steer-1");

fake.emit("turn/plan/updated", {
  threadId: fake.threadId,
  turnId: fake.currentTurnId,
  explanation: "Inventory is being processed in bounded phases.",
  plan: [
    { step: "Read infrastructure", status: "completed" },
    { step: "Read clients", status: "inProgress" },
    { step: "Consolidate report", status: "pending" },
  ],
});
fake.emit("item/started", {
  threadId: fake.threadId,
  turnId: fake.currentTurnId,
  item: { id: "msg-1", type: "agentMessage", phase: "commentary", status: "inProgress", text: "" },
});
fake.emit("item/agentMessage/delta", {
  threadId: fake.threadId,
  turnId: fake.currentTurnId,
  itemId: "msg-1",
  delta: "Infrastructure complete. ",
});
fake.emit("item/agentMessage/delta", {
  threadId: fake.threadId,
  turnId: fake.currentTurnId,
  itemId: "msg-1",
  delta: "Reading known clients now.",
});
fake.emit("item/completed", {
  threadId: fake.threadId,
  turnId: fake.currentTurnId,
  item: {
    id: "msg-1",
    type: "agentMessage",
    phase: "commentary",
    status: "completed",
    text: "Infrastructure complete. Reading known clients now.",
  },
});
fake.emit("item/started", {
  threadId: fake.threadId,
  turnId: fake.currentTurnId,
  item: {
    id: "cmd-1",
    type: "commandExecution",
    status: "inProgress",
    command: "SHOULD_NOT_APPEAR_IN_PUBLIC_PROGRESS --secret value",
  },
});

const progress = await executor.show({ agentRef: started.agentRef });
assert.equal(progress.progress.latestAgentMessage.phase, "commentary");
assert.equal(progress.progress.latestAgentMessage.status, "completed");
assert.equal(progress.progress.latestAgentMessage.text, "Infrastructure complete. Reading known clients now.");
assert.deepEqual(
  progress.progress.plan.plan.map((entry) => entry.status),
  ["completed", "inProgress", "pending"]
);
assert.deepEqual(progress.progress.activeItem, {
  id: "cmd-1",
  type: "commandExecution",
  status: "inProgress",
  updatedAt: progress.progress.activeItem.updatedAt,
});
assert.doesNotMatch(JSON.stringify(progress.progress), /SHOULD_NOT_APPEAR|--secret|value/);

const steerBefore = steerCount(fake);
const steered = await executor.steer({
  agentRef: started.agentRef,
  message: "Finish the current safe step, summarize the facts obtained, then end the turn.",
  clientRequestId: "steer-accepted-1",
  expectedTurnId: started.turnId,
});
assert.equal(steered.controlAcceptance, "accepted");
assert.equal(steerCount(fake), steerBefore + 1);
const nativeSteer = fake.requests.filter((entry) => entry.method === "turn/steer").at(-1);
assert.deepEqual(nativeSteer.params, {
  threadId: fake.threadId,
  clientUserMessageId: "steer-accepted-1",
  input: [{ type: "text", text: "Finish the current safe step, summarize the facts obtained, then end the turn." }],
  expectedTurnId: started.turnId,
});

const acceptedDuplicate = await executor.steer({
  agentRef: started.agentRef,
  message: "Finish the current safe step, summarize the facts obtained, then end the turn.",
  clientRequestId: "steer-accepted-1",
  expectedTurnId: started.turnId,
});
assert.equal(acceptedDuplicate.duplicate, true);
assert.equal(acceptedDuplicate.controlAcceptance, "accepted");
assert.equal(steerCount(fake), steerBefore + 1, "same requestId must not dispatch a second native steer");
await assert.rejects(
  () => executor.steer({
    agentRef: started.agentRef,
    message: "Different instruction must not reuse the same requestId.",
    clientRequestId: "steer-accepted-1",
    expectedTurnId: started.turnId,
  }),
  /different agent control action/
);
assert.equal(steerCount(fake), steerBefore + 1);

await assert.rejects(
  () => executor.steer({
    agentRef: started.agentRef,
    message: "This must fail before dispatch.",
    clientRequestId: "steer-stale-turn",
    expectedTurnId: "turn-old",
  }),
  /agent task turn changed/
);
assert.equal(steerCount(fake), steerBefore + 1, "stale expectedTurnId must fail before native steer");

fake.steerMode = "rpc-reject";
const beforeRpcReject = steerCount(fake);
await assert.rejects(
  () => executor.steer({
    agentRef: started.agentRef,
    message: "Explicitly rejected steer.",
    clientRequestId: "steer-rpc-reject",
    expectedTurnId: started.turnId,
  }),
  /turn is no longer active/
);
assert.equal(steerCount(fake), beforeRpcReject + 1);
await assert.rejects(
  () => executor.steer({
    agentRef: started.agentRef,
    message: "Explicitly rejected steer.",
    clientRequestId: "steer-rpc-reject",
    expectedTurnId: started.turnId,
  }),
  /turn is no longer active/
);
assert.equal(steerCount(fake), beforeRpcReject + 1, "confirmed RPC rejection must not be replayed under the same requestId");

fake.steerMode = "transport-unknown";
fake.refreshFails = true;
const beforeUnknown = steerCount(fake);
const unknown = await executor.steer({
  agentRef: started.agentRef,
  message: "Transport result becomes uncertain.",
  clientRequestId: "steer-transport-unknown",
  expectedTurnId: started.turnId,
});
assert.equal(unknown.controlAcceptance, "unknown");
assert.match(unknown.latestError, /acceptance unknown.*do not replay/i);
assert.match(unknown.latestError, /official refresh also failed/i);
assert.equal(steerCount(fake), beforeUnknown + 1);
const unknownDuplicate = await executor.steer({
  agentRef: started.agentRef,
  message: "Transport result becomes uncertain.",
  clientRequestId: "steer-transport-unknown",
  expectedTurnId: started.turnId,
});
assert.equal(unknownDuplicate.duplicate, true);
assert.equal(unknownDuplicate.controlAcceptance, "unknown");
assert.match(unknownDuplicate.latestError, /acceptance unknown.*do not replay/i);
assert.equal(steerCount(fake), beforeUnknown + 1, "uncertain steer must never auto-replay");

fake.refreshFails = false;
fake.steerMode = "accepted";
fake.turnStatus = "completed";
const terminal = await executor.show({ agentRef: started.agentRef });
assert.equal(terminal.status, "idle");
const beforeIdleSteer = steerCount(fake);
await assert.rejects(
  () => executor.steer({
    agentRef: started.agentRef,
    message: "No active turn remains.",
    clientRequestId: "steer-after-terminal",
    expectedTurnId: started.turnId,
  }),
  /no steerable active turn/
);
assert.equal(steerCount(fake), beforeIdleSteer);

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

const publicServer = captureServer();
const publicSteers = [];
const publicSnapshot = {
  agentRef: "agent-public-progress",
  turnId: "turn-public-progress",
  status: "running",
  canSend: false,
  pendingApproval: null,
  finalResult: null,
  progress: {
    latestAgentMessage: {
      itemId: "msg-public",
      phase: "commentary",
      text: "Infrastructure complete; client inventory is in progress.",
      truncated: false,
      status: "completed",
      updatedAt: 100,
      privateExtra: "DROP_ME",
    },
    plan: {
      explanation: "Bounded inventory",
      plan: [
        { step: "Infrastructure", status: "completed", privateExtra: "DROP_ME" },
        { step: "Clients", status: "inProgress" },
      ],
      truncated: false,
      updatedAt: 101,
      privateExtra: "DROP_ME",
    },
    activeItem: {
      id: "cmd-public",
      type: "commandExecution",
      status: "inProgress",
      updatedAt: 102,
      command: "SECRET_COMMAND_MUST_NOT_LEAK",
      output: "SECRET_OUTPUT_MUST_NOT_LEAK",
    },
    reasoning: "SECRET_REASONING_MUST_NOT_LEAK",
  },
  resourceReceipt: null,
  timing: { startedAt: 1, endedAt: null, durationMs: null },
  execution: {
    requestedModel: "fake-model",
    resolvedModel: "fake-model",
    modelProvider: "fake",
    serviceTier: null,
    reasoningEffort: "medium",
  },
  latestError: null,
  events: [],
  nextSeq: 0,
};
const publicExecutor = {
  async listModels() { return { models: [], nextCursor: null }; },
  async show({ agentRef }) {
    assert.equal(agentRef, publicSnapshot.agentRef);
    return structuredClone(publicSnapshot);
  },
  async steer(args) {
    publicSteers.push(structuredClone(args));
    return { ...structuredClone(publicSnapshot), controlAcceptance: "accepted", duplicate: false };
  },
};
registerAgentPreviewTools(publicServer, {
  agentExecutor: publicExecutor,
  authorityExecutor: {
    async resolveAuthority({ cwd }) {
      return {
        effectiveCwd: path.resolve(cwd ?? "."),
        permissionProfile: ":read-only",
        permissionCeiling: ":read-only",
        authoritySource: "test",
        trustedAncestor: path.resolve("."),
      };
    },
  },
  meteredConsentMode: "off",
});

const publicShow = await publicServer.tools.get("codex.agent_show").handler({
  agentRef: publicSnapshot.agentRef,
  afterSeq: 0,
});
assert.equal(publicShow.isError, false);
assert.equal(publicShow.structuredContent.progress.latestAgentMessage.text, "Infrastructure complete; client inventory is in progress.");
assert.deepEqual(publicShow.structuredContent.progress.plan.plan, [
  { step: "Infrastructure", status: "completed" },
  { step: "Clients", status: "inProgress" },
]);
assert.deepEqual(publicShow.structuredContent.progress.activeItem, {
  id: "cmd-public",
  type: "commandExecution",
  status: "inProgress",
  updatedAt: 102,
});
assert.doesNotMatch(
  JSON.stringify(publicShow.structuredContent.progress),
  /DROP_ME|SECRET_COMMAND|SECRET_OUTPUT|SECRET_REASONING/
);

const publicSteer = await publicServer.tools.get("codex.agent_steer").handler({
  agentRef: publicSnapshot.agentRef,
  message: "Summarize current progress and finish the turn.",
  expectedTurnId: publicSnapshot.turnId,
  requestId: "public-steer-1",
});
assert.equal(publicSteer.isError, false);
assert.equal(publicSteer.structuredContent.controlAcceptance, "accepted");
assert.deepEqual(publicSteers, [{
  agentRef: publicSnapshot.agentRef,
  message: "Summarize current progress and finish the turn.",
  expectedTurnId: publicSnapshot.turnId,
  clientRequestId: "public-steer-1",
}]);

const lazySteers = [];
let lazyOpenCount = 0;
const lazy = new LazyCodexAgentExecutor({
  factory: async () => ({
    running: true,
    async open() { lazyOpenCount += 1; },
    async close() {},
    async steer(input) {
      lazySteers.push(structuredClone(input));
      return { controlAcceptance: "accepted" };
    },
  }),
});
await lazy.open();
const lazyInput = {
  agentRef: "agent-lazy",
  message: "Steer through Existing runtime.",
  clientRequestId: "lazy-steer-1",
  expectedTurnId: "turn-lazy",
};
const lazyResult = await lazy.steer(lazyInput);
assert.equal(lazyResult.controlAcceptance, "accepted");
assert.equal(lazyOpenCount, 1, "lazy Existing-runtime delegate must be initialized exactly once");
assert.deepEqual(lazySteers, [lazyInput]);
await lazy.close();

await executor.close();
console.log("agent steering + bounded public progress PASS");

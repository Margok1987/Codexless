import assert from "node:assert/strict";
import path from "node:path";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";
import { registerAgentPreviewTools } from "../src/agent-tools.mjs";

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
      return {
        data: this.currentTurnId
          ? [{ id: this.currentTurnId, status: this.turnStatus, items: [] }]
          : [],
      };
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

await executor.close();
console.log("bounded native agent progress PASS");

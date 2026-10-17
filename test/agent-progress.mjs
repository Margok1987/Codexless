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
    this.threadId = "thread-progress-1";
    this.currentTurnId = null;
    this.turnStatus = null;
    this.turnCounter = 0;
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
    if (method === "turn/completed") this.turnStatus = params?.turn?.status ?? "completed";
    this.notificationHandler?.({ method, params: structuredClone(params) });
  }

  async close() {
    this.running = false;
  }

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
      this.turnCounter += 1;
      this.currentTurnId = `turn-progress-${this.turnCounter}`;
      this.turnStatus = "inProgress";
      this.beforeTurnResponse?.(this.currentTurnId);
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
  task: "Inspect harmless local fixture and report bounded progress",
  clientRequestId: "progress-start-1",
});
assert.equal(started.status, "running");
assert.deepEqual(started.progress, { latestAgentMessage: null, plan: null, activeItem: null });

const currentTurnId = started.turnId;
const hugeExplanation = `explain:${"e".repeat(9_000)}`;
const hugeMessage = `prefix-secret-${"m".repeat(9_000)}-VISIBLE_TAIL`;
const hugeStep = `step:${"s".repeat(3_000)}`;
const plan = Array.from({ length: 70 }, (_, index) => ({
  step: index === 0 ? hugeStep : `step-${index}`,
  status: index === 1 ? "inProgress" : "pending",
}));

fake.emit("turn/plan/updated", {
  threadId: fake.threadId,
  turnId: currentTurnId,
  explanation: hugeExplanation,
  plan,
});
fake.emit("item/started", {
  threadId: fake.threadId,
  turnId: currentTurnId,
  item: {
    id: "message-current",
    type: "agentMessage",
    phase: "commentary",
    status: "inProgress",
    text: hugeMessage,
  },
});
fake.emit("item/started", {
  threadId: fake.threadId,
  turnId: currentTurnId,
  item: {
    id: "command-current",
    type: "commandExecution",
    status: "inProgress",
    command: "SECRET_COMMAND_MUST_NOT_LEAK --token super-secret",
    aggregatedOutput: "SECRET_OUTPUT_MUST_NOT_LEAK",
  },
});

fake.emit("turn/plan/updated", {
  threadId: fake.threadId,
  turnId: "turn-stale",
  explanation: "STALE_PLAN_MUST_NOT_REPLACE_CURRENT",
  plan: [{ step: "stale", status: "inProgress" }],
});
fake.emit("item/agentMessage/delta", {
  threadId: fake.threadId,
  turnId: "turn-stale",
  itemId: "message-stale",
  delta: "STALE_MESSAGE_MUST_NOT_REPLACE_CURRENT",
});

// An event without a turn ID must not overwrite any visible running-turn progress.
fake.emit("turn/plan/updated", {
  threadId: fake.threadId,
  explanation: "UNBOUND_PLAN_MUST_NOT_REPLACE_CURRENT",
  plan: [{ step: "unbound", status: "inProgress" }],
});
fake.emit("item/agentMessage/delta", {
  threadId: fake.threadId,
  itemId: "message-unbound",
  delta: "UNBOUND_MESSAGE_MUST_NOT_REPLACE_CURRENT",
});
fake.emit("item/started", {
  threadId: fake.threadId,
  item: { id: "item-unbound", type: "agentMessage", text: "UNBOUND_STARTED_MUST_NOT_REPLACE_CURRENT" },
});
fake.emit("item/completed", {
  threadId: fake.threadId,
  item: { id: "command-current", type: "commandExecution" },
});


// An explicit foreign thread must never fall back to this agent's matching turn ID.
for (const [method, params] of [
  ["turn/plan/updated", { explanation: "FOREIGN_PLAN", plan: [{ step: "foreign", status: "pending" }] }],
  ["item/agentMessage/delta", { itemId: "message-current", delta: "FOREIGN_DELTA" }],
  ["item/started", { item: { id: "foreign-item", type: "agentMessage", text: "FOREIGN_ITEM" } }],
  ["item/completed", { item: { id: "command-current", type: "commandExecution" } }],
]) {
  fake.emit(method, { ...params, threadId: "thread-foreign", turnId: currentTurnId });
}

let progressSnapshot = await executor.show({ agentRef: started.agentRef });
assert.equal(progressSnapshot.progress.plan.plan.length, 64);
assert.equal(progressSnapshot.progress.plan.truncated, true);
assert.equal(progressSnapshot.progress.plan.explanation.length, 8_192);
assert.equal(progressSnapshot.progress.plan.plan[0].step.length, 2_048);
assert.equal(progressSnapshot.progress.latestAgentMessage.text.length, 8_192);
assert.equal(progressSnapshot.progress.latestAgentMessage.text.endsWith("VISIBLE_TAIL"), true);
assert.equal(progressSnapshot.progress.latestAgentMessage.truncated, true);
assert.deepEqual(
  {
    id: progressSnapshot.progress.activeItem.id,
    type: progressSnapshot.progress.activeItem.type,
    status: progressSnapshot.progress.activeItem.status,
  },
  { id: "command-current", type: "commandExecution", status: "inProgress" },
);
assert.doesNotMatch(JSON.stringify(progressSnapshot.progress), /SECRET_COMMAND|SECRET_OUTPUT|super-secret/);
assert.doesNotMatch(JSON.stringify(progressSnapshot.progress), /STALE_PLAN|STALE_MESSAGE|UNBOUND_|FOREIGN_/);
assert.equal(
  progressSnapshot.events.filter((event) => event.type === "unbound-progress-notification-ignored").length,
  4,
);
assert.equal(
  progressSnapshot.events.some((event) => event.type === "stale-turn-notification-ignored"),
  true,
);

fake.emit("turn/completed", {
  threadId: fake.threadId,
  turn: {
    id: currentTurnId,
    status: "completed",
    items: [{ id: "final", type: "agentMessage", text: "Final bounded result" }],
  },
});
progressSnapshot = await executor.show({ agentRef: started.agentRef });
assert.equal(progressSnapshot.status, "idle");
assert.equal(progressSnapshot.progress.activeItem, null);

const second = await executor.send({
  agentRef: started.agentRef,
  message: "Start a clean second turn",
  clientRequestId: "progress-send-2",
});
assert.equal(second.status, "running");
assert.notEqual(second.turnId, currentTurnId);
assert.deepEqual(second.progress, { latestAgentMessage: null, plan: null, activeItem: null });


// Bounds must cover labels and IDs, with truncation reported even below the step-count limit.
fake.emit("turn/plan/updated", {
  threadId: fake.threadId, turnId: second.turnId,
  explanation: "e".repeat(9_000),
  plan: [{ step: "s".repeat(3_000), status: "p".repeat(200) }],
});
fake.emit("item/started", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: "c".repeat(700), type: "t".repeat(200), status: "s".repeat(200) },
});
progressSnapshot = await executor.show({ agentRef: started.agentRef });
assert.equal(progressSnapshot.progress.plan.explanation.length, 8_192);
assert.equal(progressSnapshot.progress.plan.plan[0].step.length, 2_048);
assert.equal(progressSnapshot.progress.plan.plan[0].status.length, 128);
assert.equal(progressSnapshot.progress.plan.truncated, true);
assert.equal(progressSnapshot.progress.activeItem.id.length, 512);
assert.equal(progressSnapshot.progress.activeItem.type.length, 128);
assert.equal(progressSnapshot.progress.activeItem.status.length, 128);
assert.equal(progressSnapshot.progress.activeItem.truncated, true);
fake.emit("item/completed", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: "c".repeat(700), type: "t".repeat(200) },
});
assert.equal((await executor.show({ agentRef: started.agentRef })).progress.activeItem, null);
fake.emit("item/started", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: "m".repeat(700), type: "agentMessage", phase: "p".repeat(200), text: hugeMessage },
});
fake.emit("item/agentMessage/delta", {
  threadId: fake.threadId, turnId: second.turnId,
  itemId: "m".repeat(700), delta: "-DELTA_TAIL",
});
fake.emit("item/completed", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: "m".repeat(700), type: "agentMessage" },
});
progressSnapshot = await executor.show({ agentRef: started.agentRef });
assert.equal(progressSnapshot.progress.latestAgentMessage.itemId.length, 512);
assert.equal(progressSnapshot.progress.latestAgentMessage.phase.length, 128);
assert.equal(progressSnapshot.progress.latestAgentMessage.text.endsWith("-DELTA_TAIL"), true);
assert.equal(progressSnapshot.progress.latestAgentMessage.truncated, true);
assert.equal(progressSnapshot.progress.latestAgentMessage.status, "completed");
assert.equal(progressSnapshot.progress.activeItem, null);

// A bound may fall between UTF-16 surrogate halves; never corrupt valid UTF-8 text.
const unicodeId = "i".repeat(511) + "🦊";
fake.emit("turn/plan/updated", {
  threadId: fake.threadId, turnId: second.turnId,
  explanation: "e".repeat(8_191) + "🦊",
  plan: [{ step: "s".repeat(2_047) + "🦊", status: "p".repeat(127) + "🦊" }],
});
fake.emit("item/started", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: unicodeId, type: "agentMessage", phase: "p".repeat(127) + "🦊", text: "🦊" + "x".repeat(8_191) },
});
const unicodeProgress = (await executor.show({ agentRef: started.agentRef })).progress;
for (const [value, expected] of [
  [unicodeProgress.latestAgentMessage.itemId, "i".repeat(511)],
  [unicodeProgress.latestAgentMessage.phase, "p".repeat(127)],
  [unicodeProgress.latestAgentMessage.text, "x".repeat(8_191)],
  [unicodeProgress.plan.explanation, "e".repeat(8_191)],
  [unicodeProgress.plan.plan[0].step, "s".repeat(2_047)],
  [unicodeProgress.plan.plan[0].status, "p".repeat(127)],
]) {
  assert.equal(value, expected);
  assert.equal(value.isWellFormed(), true);
}
assert.equal(unicodeProgress.latestAgentMessage.truncated, true);
assert.equal(unicodeProgress.plan.truncated, true);

// Bounded display IDs may collide; internal message/item identity must stay exact.
const collisionPrefix = "i".repeat(512);
const firstCollisionId = collisionPrefix + "-first";
const secondCollisionId = collisionPrefix + "-second";
fake.emit("item/started", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: firstCollisionId, type: "agentMessage", text: "FIRST_MESSAGE_ONLY" },
});
fake.emit("item/agentMessage/delta", {
  threadId: fake.threadId, turnId: second.turnId,
  itemId: secondCollisionId, delta: "SECOND_MESSAGE_ONLY",
});
progressSnapshot = await executor.show({ agentRef: started.agentRef });
assert.equal(progressSnapshot.progress.latestAgentMessage.text, "SECOND_MESSAGE_ONLY");
fake.emit("item/completed", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: firstCollisionId, type: "agentMessage" },
});
progressSnapshot = await executor.show({ agentRef: started.agentRef });
assert.equal(progressSnapshot.progress.latestAgentMessage.text, "");
fake.emit("item/started", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: firstCollisionId, type: "commandExecution" },
});
fake.emit("item/completed", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: secondCollisionId, type: "commandExecution" },
});
progressSnapshot = await executor.show({ agentRef: started.agentRef });
assert.notEqual(progressSnapshot.progress.activeItem, null);
assert.equal(progressSnapshot.progress.activeItem.id, collisionPrefix);
fake.emit("item/completed", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: firstCollisionId, type: "commandExecution" },
});
assert.equal((await executor.show({ agentRef: started.agentRef })).progress.activeItem, null);

// JSON permits unpaired surrogate escapes. Their exact identities must not alias
// when a UTF-8 encoder would replace both with the same replacement character.
fake.emit("item/started", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: "\uD800", type: "agentMessage", text: "FIRST_SURROGATE_MESSAGE" },
});
fake.emit("item/agentMessage/delta", {
  threadId: fake.threadId, turnId: second.turnId, itemId: "\uD801", delta: "SECOND_SURROGATE_MESSAGE",
});
assert.equal((await executor.show({ agentRef: started.agentRef })).progress.latestAgentMessage.text, "SECOND_SURROGATE_MESSAGE");
fake.emit("item/completed", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: "\uD800", type: "agentMessage" },
});
assert.equal((await executor.show({ agentRef: started.agentRef })).progress.latestAgentMessage.text, "");

// Recover terminal state without a completion notification; stale active items must disappear.
fake.emit("item/started", {
  threadId: fake.threadId, turnId: second.turnId,
  item: { id: "terminal-refresh-item", type: "commandExecution" },
});
fake.turnStatus = "completed";
progressSnapshot = await executor.show({ agentRef: started.agentRef });
assert.equal(progressSnapshot.status, "idle");
assert.equal(progressSnapshot.progress.activeItem, null);

// Pre-response progress survives only when the returned official turn ID agrees.
fake.beforeTurnResponse = () => {
  fake.emit("turn/plan/updated", {
    threadId: fake.threadId, turnId: "unrelated-early-turn",
    plan: [{ step: "WRONG_EARLY_TURN", status: "pending" }],
  });
  fake.emit("item/started", {
    threadId: fake.threadId, turnId: "unrelated-early-turn",
    item: { id: "early-message", type: "agentMessage", text: "WRONG_EARLY_MESSAGE" },
  });
};
const third = await executor.send({
  agentRef: started.agentRef, message: "Reconcile the third turn", clientRequestId: "progress-send-3",
});
assert.deepEqual(third.progress, { latestAgentMessage: null, plan: null, activeItem: null });
fake.turnStatus = "completed";
await executor.show({ agentRef: started.agentRef });
fake.beforeTurnResponse = (turnId) => fake.emit("turn/plan/updated", {
  threadId: fake.threadId, turnId, plan: [{ step: "MATCHING_EARLY_TURN", status: "pending" }],
});
const fourth = await executor.send({
  agentRef: started.agentRef, message: "Keep matching early progress", clientRequestId: "progress-send-4",
});
assert.equal(fourth.progress.plan.plan[0].step, "MATCHING_EARLY_TURN");

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
const maliciousSnapshot = {
  agentRef: "agent-public-progress",
  turnId: "turn-public-progress",
  status: "running",
  canSend: false,
  pendingApproval: null,
  finalResult: null,
  progress: {
    latestAgentMessage: {
      itemId: "m".repeat(700),
      phase: "commentary",
      text: `hidden-prefix-${"x".repeat(9_000)}-PUBLIC_TAIL`,
      truncated: false,
      status: "inProgress",
      updatedAt: 100,
      rawReasoning: "SECRET_REASONING_MUST_NOT_LEAK",
    },
    plan: {
      explanation: `plan:${"p".repeat(9_000)}`,
      plan: Array.from({ length: 70 }, (_, index) => ({
        step: index === 0 ? "z".repeat(3_000) : `public-step-${index}`,
        status: "pending",
        privateExtra: "DROP_ME",
      })),
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
    transcript: "SECRET_TRANSCRIPT_MUST_NOT_LEAK",
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
    assert.equal(agentRef, maliciousSnapshot.agentRef);
    return structuredClone(maliciousSnapshot);
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

const showTool = publicServer.tools.get("codex.agent_show");
assert.match(showTool.definition.description, /bounded native progress/i);
assert.match(showTool.definition.description, /excludes raw reasoning, command output, file diffs\/patches, MCP payload\/output/i);
const publicShow = await showTool.handler({ agentRef: maliciousSnapshot.agentRef, afterSeq: 0 });
assert.equal(publicShow.isError, false);
assert.equal(publicShow.structuredContent.progress.latestAgentMessage.text.length, 8_192);
assert.equal(publicShow.structuredContent.progress.latestAgentMessage.text.endsWith("PUBLIC_TAIL"), true);
assert.equal(publicShow.structuredContent.progress.latestAgentMessage.itemId.length, 512);
assert.equal(publicShow.structuredContent.progress.plan.plan.length, 64);
assert.equal(publicShow.structuredContent.progress.plan.plan[0].step.length, 2_048);
assert.equal(publicShow.structuredContent.progress.plan.truncated, true);
assert.deepEqual(publicShow.structuredContent.progress.activeItem, {
  id: "cmd-public",
  type: "commandExecution",
  status: "inProgress",
  updatedAt: 102,
});
assert.doesNotMatch(
  JSON.stringify(publicShow.structuredContent.progress),
  /DROP_ME|SECRET_COMMAND|SECRET_OUTPUT|SECRET_REASONING|SECRET_TRANSCRIPT/,
);

// Field-level truncation must be reported even when the plan contains few steps.
maliciousSnapshot.progress.latestAgentMessage.phase = "p".repeat(200);
maliciousSnapshot.progress.latestAgentMessage.status = "s".repeat(200);
maliciousSnapshot.progress.plan.plan = [{ step: "s".repeat(3_000), status: "p".repeat(200) }];
maliciousSnapshot.progress.activeItem = {
  id: "i".repeat(700), type: "t".repeat(200), status: "s".repeat(200),
  updatedAt: 103, output: "SECRET_OUTPUT_MUST_NOT_LEAK",
};
const boundedShow = (await showTool.handler({ agentRef: maliciousSnapshot.agentRef, afterSeq: 0 })).structuredContent;
assert.equal(boundedShow.progress.latestAgentMessage.phase.length, 128);
assert.equal(boundedShow.progress.latestAgentMessage.status.length, 128);
assert.equal(boundedShow.progress.latestAgentMessage.truncated, true);
assert.equal(boundedShow.progress.plan.explanation.length, 8_192);
assert.equal(boundedShow.progress.plan.plan.length, 1);
assert.equal(boundedShow.progress.plan.plan[0].step.length, 2_048);
assert.equal(boundedShow.progress.plan.plan[0].status.length, 128);
assert.equal(boundedShow.progress.plan.truncated, true);
assert.deepEqual(Object.keys(boundedShow.progress.activeItem).sort(), ["id", "status", "type", "updatedAt"]);
assert.equal(boundedShow.progress.activeItem.id.length, 512);
assert.equal(boundedShow.progress.activeItem.type.length, 128);
assert.equal(boundedShow.progress.activeItem.status.length, 128);

maliciousSnapshot.progress.latestAgentMessage.itemId = unicodeId;
maliciousSnapshot.progress.latestAgentMessage.phase = "p".repeat(127) + "🦊";
maliciousSnapshot.progress.latestAgentMessage.text = "🦊" + "x".repeat(8_191);
maliciousSnapshot.progress.plan.explanation = "e".repeat(8_191) + "🦊";
maliciousSnapshot.progress.plan.plan = [{ step: "s".repeat(2_047) + "🦊", status: "p".repeat(127) + "🦊" }];
maliciousSnapshot.progress.activeItem.id = unicodeId;
const unicodePublic = (await showTool.handler({ agentRef: maliciousSnapshot.agentRef, afterSeq: 0 })).structuredContent.progress;
for (const value of [unicodePublic.latestAgentMessage.itemId, unicodePublic.latestAgentMessage.phase,
  unicodePublic.latestAgentMessage.text, unicodePublic.plan.explanation, unicodePublic.plan.plan[0].step,
  unicodePublic.plan.plan[0].status, unicodePublic.activeItem.id]) {
  assert.equal(value.isWellFormed(), true);
  assert.equal(Buffer.from(value, "utf8").toString("utf8"), value);
}
assert.equal(unicodePublic.latestAgentMessage.truncated, true);
assert.equal(unicodePublic.plan.truncated, true);

await executor.close();
console.log("bounded native agent progress PASS");

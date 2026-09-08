import assert from "node:assert/strict";
import test from "node:test";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";

function fakeClient() {
  let running = false;
  let turnIndex = 0;
  let currentTurn = null;
  let serverRequestHandler = null;
  const requests = [];
  return {
    get running() { return running; },
    initializedResult: { protocolVersion: "2" },
    serverRequestMethods: [],
    async start() { running = true; return this.initializedResult; },
    async close() { running = false; },
    onNotification() { return () => {}; },
    setServerRequestHandler(handler) { serverRequestHandler = handler; },
    emitApproval({ id, method, params }) {
      if (typeof serverRequestHandler !== "function") throw new Error("fixture serverRequestHandler is not bound");
      return new Promise((resolve, reject) => {
        serverRequestHandler({ id, method, params, resolve, reject });
      });
    },
    async request(method, params) {
      requests.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "thread_interrupt_recovery", canAcceptDirectInput: true }, model: "gpt-fixture", reasoningEffort: "high" };
      }
      if (method === "turn/start") {
        turnIndex += 1;
        currentTurn = { id: `turn_${turnIndex}`, status: "inProgress", items: [] };
        return { turn: { ...currentTurn } };
      }
      if (method === "thread/turns/list") return { data: currentTurn ? [{ ...currentTurn }] : [] };
      if (method === "thread/resume") {
        return { thread: { id: "thread_interrupt_recovery", canAcceptDirectInput: true }, model: "gpt-fixture", reasoningEffort: "high" };
      }
      if (method === "turn/interrupt") {
        assert.equal(params.turnId, currentTurn?.id);
        currentTurn = { ...currentTurn, status: "interrupted" };
        return {};
      }
      throw new Error("unexpected fixture RPC: " + method);
    },
    failCurrentTurn() { currentTurn = { ...currentTurn, status: "failed", error: { message: "fixture failure" } }; },
    get requests() { return requests.slice(); },
  };
}

test("interrupted formal turn remains bound and can continue in the same thread", async () => {
  const client = fakeClient();
  const executor = new CodexAgentExecutor({
    defaultCwd: process.cwd(),
    requireAuthorityPolicy: false,
    requireChatgptAuth: false,
    clientFactory: (options) => { client.setServerRequestHandler(options.serverRequestHandler); return client; },
  });
  try {
    await executor.open();
    const started = await executor.start({ task: "first turn", clientRequestId: "interrupt-recovery-start" });
    assert.equal(started.status, "running");
    assert.equal(started.turnId, "turn_1");
    const agentRef = started.agentRef;

    const cancelled = await executor.cancel({
      agentRef,
      clientRequestId: "interrupt-recovery-cancel",
      expectedTurnId: "turn_1",
    });
    assert.equal(cancelled.status, "interrupted");
    assert.equal(cancelled.canSend, true, "a confirmed interrupted turn must remain follow-up-ready");

    const observed = await executor.show({ agentRef, afterSeq: 0 });
    assert.equal(observed.status, "interrupted");
    assert.equal(observed.turnId, "turn_1");
    assert.equal(observed.canSend, true);

    const followUp = await executor.send({
      agentRef,
      message: "continue after interrupt",
      clientRequestId: "interrupt-recovery-send",
      expectedParentTurnId: "turn_1",
    });
    assert.equal(followUp.agentRef, agentRef, "follow-up must keep the same logical agent");
    assert.equal(followUp.threadId, "thread_interrupt_recovery", "follow-up must keep the same official thread");
    assert.equal(followUp.turnId, "turn_2");
    assert.equal(followUp.status, "running");
    assert.equal(client.requests.filter((entry) => entry.method === "thread/start").length, 1, "recovery must not create a replacement thread");
    assert.equal(client.requests.filter((entry) => entry.method === "turn/start").length, 2);
  } finally {
    await executor.close();
  }
});

test("command approval rejection resolves with decline and clears pending state", async () => {
  const client = fakeClient();
  const executor = new CodexAgentExecutor({
    defaultCwd: process.cwd(),
    requireAuthorityPolicy: false,
    requireChatgptAuth: false,
    clientFactory: (options) => { client.setServerRequestHandler(options.serverRequestHandler); return client; },
  });
  try {
    await executor.open();
    const started = await executor.start({ task: "approval fixture", clientRequestId: "approval-reject-start" });
    const responsePromise = client.emitApproval({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: started.threadId,
        turnId: started.turnId,
        command: "git status --short",
        availableDecisions: ["accept", "decline"],
      },
    });
    const pending = await executor.show({ agentRef: started.agentRef, afterSeq: 0 });
    assert.equal(pending.status, "awaitingApproval");
    assert.equal(String(pending.pendingApproval?.requestId), "approval-1");

    const rejected = await executor.resolveApproval({
      agentRef: started.agentRef,
      approvalRequestId: "approval-1",
      clientRequestId: "approval-reject-control",
      decision: "reject",
    });
    assert.deepEqual(await responsePromise, { decision: "decline" });
    assert.equal(rejected.pendingApproval, null);
    assert.equal(rejected.status, "running");
    assert.equal(rejected.canSend, false);
  } finally {
    await executor.close();
  }
});

test("failed formal turn remains non-sendable", async () => {
  const client = fakeClient();
  const executor = new CodexAgentExecutor({
    defaultCwd: process.cwd(),
    requireAuthorityPolicy: false,
    requireChatgptAuth: false,
    clientFactory: (options) => { client.setServerRequestHandler(options.serverRequestHandler); return client; },
  });
  try {
    await executor.open();
    const started = await executor.start({ task: "will fail", clientRequestId: "failed-parent-start" });
    client.failCurrentTurn();
    const failed = await executor.show({ agentRef: started.agentRef, afterSeq: 0 });
    assert.equal(failed.status, "failed");
    assert.equal(failed.canSend, false);
    await assert.rejects(
      executor.send({
        agentRef: started.agentRef,
        message: "must not continue",
        clientRequestId: "failed-parent-send",
        expectedParentTurnId: "turn_1",
      }),
      /official parent refresh failed|not ready for a follow-up: failed/i
    );
  } finally {
    await executor.close();
  }
});

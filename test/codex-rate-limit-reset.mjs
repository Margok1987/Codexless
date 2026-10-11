import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertResetChatgptAccount, verifyResetChatgptAccount, createCodexRateLimitResetCoordinator, registerCodexRateLimitResetTools } from "../src/codex-rate-limit-reset.mjs";

const START = Date.parse("2026-10-10T10:00:00Z");
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const roots = [];
function newRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reset-test-"));
  roots.push(root);
  return root;
}
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function fakeNative({ before = null, after = null, whenConsume = null } = {}) {
  const calls = [];
  let redeemed = false;
  const initial = before ?? {
    accountId: "pia-upstream-id",
    rateLimits: {
      primary: { usedPercent: 84, resetsAt: 1791634543 },
      secondary: { usedPercent: 100, resetsAt: 1791948913 },
    },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { id: "credit-a", status: "available", resetType: "codexRateLimits", expiresAt: 1791980000 },
        { id: "credit-b", status: "available", resetType: "codexRateLimits", expiresAt: 1791990000 },
      ],
    },
  };
  async function request(input) {
    calls.push(structuredClone(input));
    assert.equal(input.account, "pia", "never switch the bound account");
    if (input.method === "account/rateLimits/read") {
      if (!redeemed) return structuredClone(initial);
      if (after) return structuredClone(after);
      return {
        ...structuredClone(initial),
        rateLimits: {
          primary: { usedPercent: 0, resetsAt: 1791634555 },
          secondary: { usedPercent: 0, resetsAt: 1791948925 },
        },
        rateLimitResetCredits: {
          availableCount: initial.rateLimitResetCredits.availableCount - 1,
          credits: initial.rateLimitResetCredits.credits.filter((c) => c.id !== "credit-a"),
        },
      };
    }
    assert.equal(input.method, "account/rateLimitResetCredit/consume");
    assert.equal(input.params.creditId, "credit-a");
    assert.equal(input.params.idempotencyKey, UUID);
    if (whenConsume) return whenConsume();
    redeemed = true;
    return { outcome: "reset" };
  }
  return { request, calls, get redeemed() { return redeemed; } };
}

function coordinator(native, config = {}) {
  return createCodexRateLimitResetCoordinator({
    request: native.request,
    now: () => START,
    newId: () => UUID,
    lockRoot: newRoot(),
    ...config,
  });
}

test("auth-bound banked reset requires ChatGPT login, not an API key or missing identity", () => {
  assert.doesNotThrow(() => assertResetChatgptAccount({ account: { type: "chatgpt", planType: "team" } }));
  for (const state of [null, {}, { account: null }, { account: { type: "apiKey" } }]) {
    assert.throws(() => assertResetChatgptAccount(state), (error) => error.code === "CODEX_RESET_CHATGPT_AUTH_REQUIRED");
  }
});

test("reset account verification uses official account/read request params and rejects API-key login", async () => {
  const calls = [];
  await verifyResetChatgptAccount({ request: async (method, params) => {
    calls.push({ method, params });
    return { account: { type: "chatgpt", planType: "team" } };
  } });
  assert.deepEqual(calls, [{ method: "account/read", params: { refreshToken: false } }]);
  await assert.rejects(
    verifyResetChatgptAccount({ request: async () => ({ account: { type: "apiKey" } }) }),
    (error) => error.code === "CODEX_RESET_CHATGPT_AUTH_REQUIRED",
  );
});

test("prepare binds one account and native credit, without consuming anything", async () => {
  const n = fakeNative();
  const c = coordinator(n);
  const p = await c.prepare({ account: "pia" });
  assert.equal(p.status, "consent_required");
  assert.equal(p.credit.id, undefined, "private provider credit ID must not leave the coordinator");
  assert.equal(p.availableCount, 2);
  assert.match(p.chatPresentation.text, /Task ID: \*\*R-/);
  assert.deepEqual(n.calls.map((v) => v.method), ["account/rateLimits/read"]);
  assert.equal(n.redeemed, false);
  await assert.rejects(c.prepare({ account: "pia" }), /pending.*reset/i);
});

test("an exact commit consumes once; duplicate decisions never redispatch", async () => {
  const n = fakeNative();
  const c = coordinator(n);
  const p = await c.prepare({ account: "pia" });
  const done = await c.decide({ taskId: p.taskId, decision: "commit" });
  assert.equal(done.status, "verified");
  assert.equal(done.verification.creditCount, true);
  assert.equal(done.verification.quotaWindows, true);
  assert.deepEqual(n.calls.map((v) => v.method), [
    "account/rateLimits/read",
    "account/rateLimits/read",
    "account/rateLimitResetCredit/consume",
    "account/rateLimits/read",
  ]);
  assert.equal(n.redeemed, true);
  const second = await c.decide({ taskId: p.taskId, decision: "commit" });
  assert.equal(second.duplicate, true);
  assert.equal(n.calls.filter((v) => v.method.includes("consume")).length, 1);
});

test("decline and expired approvals never consume a credit", async () => {
  const n = fakeNative();
  const c = coordinator(n);
  const p = await c.prepare({ account: "pia" });
  assert.equal((await c.decide({ taskId: p.taskId, decision: "decline" })).status, "declined");
  assert.equal(n.calls.length, 1);
  assert.equal((await c.decide({ taskId: p.taskId, decision: "commit" })).status, "declined");
  let clock = START;
  const d = coordinator(fakeNative(), { now: () => clock });
  const prepared = await d.prepare({ account: "pia" });
  clock += 660000;
  assert.equal((await d.decide({ taskId: prepared.taskId, decision: "commit" })).status, "expired");
});

test("incomplete, expired, tied and invalid native credit details fail closed", async () => {
  const n = fakeNative();
  const baseline = await n.request({ account: "pia", method: "account/rateLimits/read", params: null });
  for (const variant of [
    { ...structuredClone(baseline), rateLimitResetCredits: { availableCount: 2, credits: null } },
    { ...structuredClone(baseline), rateLimitResetCredits: { availableCount: 3, credits: baseline.rateLimitResetCredits.credits } },
    { ...structuredClone(baseline), rateLimitResetCredits: { availableCount: 2, credits: [
      { ...baseline.rateLimitResetCredits.credits[0], expiresAt: null }, baseline.rateLimitResetCredits.credits[1],
    ] } },
    { ...structuredClone(baseline), rateLimitResetCredits: { availableCount: 2, credits: [
      baseline.rateLimitResetCredits.credits[0],
      { ...baseline.rateLimitResetCredits.credits[1], expiresAt: 1791980000 },
    ] } },
  ]) {
    const bad = coordinator(fakeNative({ before: variant }));
    await assert.rejects(bad.prepare({ account: "pia" }), /credit/i);
  }
});

test("a banked reset is not prepared while every quota window still has capacity", async () => {
  const n = fakeNative();
  const snapshot = await n.request({ account: "pia", method: "account/rateLimits/read", params: null });
  snapshot.rateLimits.primary.usedPercent = 27;
  snapshot.rateLimits.secondary.usedPercent = 49;
  await assert.rejects(coordinator(fakeNative({ before: snapshot })).prepare({ account: "pia" }), /exhausted.*quota/i);
});

test("provider failure after consume dispatch yields unknown_outcome and no automatic retry", async () => {
  const n = fakeNative({ whenConsume: () => { throw new Error("simulated late timeout"); } });
  const c = coordinator(n);
  const p = await c.prepare({ account: "pia" });
  assert.equal((await c.decide({ taskId: p.taskId, decision: "commit" })).status, "unknown_outcome");
  assert.equal((await c.decide({ taskId: p.taskId, decision: "commit" })).duplicate, true);
  assert.equal(n.calls.filter((x) => x.method.includes("consume")).length, 1);
  await assert.rejects(c.prepare({ account: "pia" }), /reconcile/i);
});

test("native state changes before confirmation block before consume", async () => {
  const n = fakeNative();
  let readCount = 0;
  const c = createCodexRateLimitResetCoordinator({
    request: async (input) => {
      const value = await n.request(input);
      if (input.method === "account/rateLimits/read" && ++readCount === 2) {
        value.rateLimitResetCredits.availableCount = 1;
      }
      return value;
    },
    now: () => START,
    newId: () => UUID,
    lockRoot: newRoot(),
  });
  const p = await c.prepare({ account: "pia" });
  const outcome = await c.decide({ taskId: p.taskId, decision: "commit" });
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.effect, "none");
  assert.equal(n.calls.filter((x) => x.method.includes("consume")).length, 0);
});

test("two concurrent commit messages cannot redeem the same credit twice", async () => {
  const n = fakeNative();
  const c = coordinator(n);
  const p = await c.prepare({ account: "pia" });
  const out = await Promise.all([
    c.decide({ taskId: p.taskId, decision: "commit" }),
    c.decide({ taskId: p.taskId, decision: "commit" }),
  ]);
  assert.ok(out.some((r) => r.status === "verified"));
  assert.equal(n.calls.filter((x) => x.method.includes("consume")).length, 1);
});

test("public tools expose only prepare and exact Task-ID decision", () => {
  const names = [];
  const schemaStub = {
    string: () => ({ min() { return this; }, max() { return this; } }),
    enum: () => ({}),
    object: () => ({ strict() { return this; }, safeParse() { return { success: false }; } }),
  };
  registerCodexRateLimitResetTools({
    registerTool(name, opts) {
      names.push(name);
      assert.equal(opts.inputSchema.safeParse({ token: "forbidden" }).success, false);
    },
  }, coordinator(fakeNative()), schemaStub);
  assert.deepEqual(names, ["codex.reset_credit_prepare", "codex.reset_credit_decide"]);
});

test("an unresolved persistent dispatch lock survives coordinator restart", async () => {
  const lockRoot = newRoot();
  const timeout = fakeNative({ whenConsume: () => { throw new Error("simulated uncertain result"); } });
  const original = coordinator(timeout, { lockRoot });
  const prepared = await original.prepare({ account: "pia" });
  assert.equal((await original.decide({ taskId: prepared.taskId, decision: "commit" })).status, "unknown_outcome");
  const recovered = coordinator(fakeNative(), { lockRoot });
  await assert.rejects(recovered.prepare({ account: "pia" }), /reconcile/i);
});

test("a provider-verified successful reset clears its durable guard", async () => {
  const lockRoot = newRoot();
  const native = fakeNative();
  const c = coordinator(native, { lockRoot });
  const p = await c.prepare({ account: "pia" });
  const done = await c.decide({ taskId: p.taskId, decision: "commit" });
  assert.equal(done.status, "verified");
  assert.equal(done.verification.persistentGuardCleared, true);
  const nextRuntime = coordinator(fakeNative(), { lockRoot });
  assert.equal((await nextRuntime.prepare({ account: "pia" })).status, "consent_required");
});

test("reset verifies legacy, by-limit-only, mixed and cross-format native snapshots", async () => {
  const before = await fakeNative().request({ account: "pia", method: "account/rateLimits/read", params: null });
  const reset = {
    primary: { usedPercent: 0, resetsAt: 1791634555 },
    secondary: { usedPercent: 0, resetsAt: 1791948925 },
  };
  const after = {
    ...structuredClone(before),
    rateLimits: reset,
    rateLimitResetCredits: { availableCount: 1, credits: [before.rateLimitResetCredits.credits[1]] },
  };
  function shape(snapshot, format) {
    const result = structuredClone(snapshot);
    if (format === "legacy") return result;
    if (format === "fractional") {
      for (const window of Object.values(result.rateLimits)) window.usedPercent = 0.5;
      return result;
    }
    result.rateLimitsByLimitId = { codex: result.rateLimits };
    if (format === "map") delete result.rateLimits;
    if (format === "mixed") result.rateLimits = { primary: { usedPercent: 100, resetsAt: 1 } };
    if (format === "null-map") result.rateLimitsByLimitId.codex = null;
    return result;
  }
  for (const [pre, post] of [
    ["legacy", "legacy"], ["map", "map"], ["legacy", "map"], ["map", "legacy"],
    ["mixed", "mixed"], ["null-map", "null-map"], ["legacy", "fractional"],
  ]) {
    const native = fakeNative({ before: shape(before, pre), after: shape(after, post) });
    const c = coordinator(native);
    const prepared = await c.prepare({ account: "pia" });
    const result = await c.decide({ taskId: prepared.taskId, decision: "commit" });
    assert.equal(result.status, "verified", pre + " -> " + post);
    assert.deepEqual(result.verification, {
      creditCount: true, quotaWindows: true, providerAccount: true, persistentGuardCleared: true,
    });
    assert.equal((await c.decide({ taskId: prepared.taskId, decision: "commit" })).duplicate, true);
    assert.equal((await c.decide({ taskId: prepared.taskId, decision: "decline" })).status, "verified");
    assert.equal(native.calls.filter((call) => call.method.includes("consume")).length, 1);
  }
});

test("incomplete, conflicting and malformed reset readbacks keep the durable no-replay lock", async () => {
  const before = await fakeNative().request({ account: "pia", method: "account/rateLimits/read", params: null });
  const good = {
    ...structuredClone(before),
    rateLimits: {
      primary: { usedPercent: 0, resetsAt: 1791634555 },
      secondary: { usedPercent: 0, resetsAt: 1791948925 },
    },
    rateLimitResetCredits: { availableCount: 1, credits: [before.rateLimitResetCredits.credits[1]] },
  };
  const mutations = [
    (v) => { delete v.rateLimits; },
    (v) => { v.rateLimitsByLimitId = { codex: {} }; },
    (v) => { v.rateLimitsByLimitId = { codex: before.rateLimits }; },
    (v) => { for (const w of Object.values(v.rateLimits)) delete w.usedPercent; },
    (v) => { for (const w of Object.values(v.rateLimits)) w.usedPercent = "0"; },
    (v) => { for (const w of Object.values(v.rateLimits)) w.usedPercent = -1; },
    (v) => { for (const w of Object.values(v.rateLimits)) w.usedPercent = Infinity; },
    (v) => { for (const w of Object.values(v.rateLimits)) delete w.resetsAt; },
    (v) => { for (const w of Object.values(v.rateLimits)) w.resetsAt += 0.5; },
    (v) => { v.rateLimits = before.rateLimits; },
    (v) => { delete v.rateLimitResetCredits; },
    (v) => { v.rateLimitResetCredits.credits = []; },
    (v) => { v.rateLimitResetCredits.credits = before.rateLimitResetCredits.credits; },
    (v) => { v.rateLimitResetCredits.availableCount = 2; },
    (v) => { v.accountId = "other-upstream-account"; },
    (v) => { delete v.accountId; },
  ];
  for (const mutate of mutations) {
    const after = structuredClone(good);
    mutate(after);
    const lockRoot = newRoot();
    const native = fakeNative({ before, after });
    const c = coordinator(native, { lockRoot });
    const prepared = await c.prepare({ account: "pia" });
    const result = await c.decide({ taskId: prepared.taskId, decision: "commit" });
    assert.equal(result.status, "unknown_outcome", mutate.toString());
    assert.equal(result.verification.persistentGuardCleared, false);
    assert.equal((await c.decide({ taskId: prepared.taskId, decision: "commit" })).duplicate, true);
    assert.equal(native.calls.filter((call) => call.method.includes("consume")).length, 1);
    assert.equal(fs.readdirSync(path.join(lockRoot, "banked-reset-guards")).length, 1);
    await assert.rejects(coordinator(fakeNative(), { lockRoot }).prepare({ account: "pia" }), /reconcile/i);
  }
});

test("missing provider identity on both snapshots cannot be reported as verified", async () => {
  const before = await fakeNative().request({ account: "pia", method: "account/rateLimits/read", params: null });
  delete before.accountId;
  const after = {
    ...structuredClone(before),
    rateLimits: { primary: { usedPercent: 0, resetsAt: 1791634555 }, secondary: { usedPercent: 0, resetsAt: 1791948925 } },
    rateLimitResetCredits: { availableCount: 1, credits: [before.rateLimitResetCredits.credits[1]] },
  };
  const native = fakeNative({ before, after });
  const c = coordinator(native);
  const prepared = await c.prepare({ account: "pia" });
  const result = await c.decide({ taskId: prepared.taskId, decision: "commit" });
  assert.equal(result.status, "unknown_outcome");
  assert.equal(result.verification.providerAccount, false);
  assert.equal(result.verification.persistentGuardCleared, false);
  assert.equal((await c.decide({ taskId: prepared.taskId, decision: "commit" })).duplicate, true);
  assert.equal(native.calls.filter((call) => call.method.includes("consume")).length, 1);
});

test("task IDs, preflight expiry and concurrent decline cannot change the bound reset action", async () => {
  let clock = START;
  const native = fakeNative();
  let reads = 0;
  const c = coordinator({ request: async (input) => {
    const value = await native.request(input);
    if (input.method === "account/rateLimits/read" && ++reads === 2) clock += 660000;
    return value;
  } }, { now: () => clock });
  const prepared = await c.prepare({ account: "pia" });
  await assert.rejects(c.decide({ taskId: "R-" + "0".repeat(32), decision: "commit" }), /unknown|missing/i);
  await assert.rejects(c.decide({ taskId: prepared.taskId, decision: "yes" }), /commit or decline/i);
  const [commit, decline] = await Promise.all([
    c.decide({ taskId: prepared.taskId, decision: "commit" }),
    c.decide({ taskId: prepared.taskId, decision: "decline" }),
  ]);
  assert.equal(commit.status, "expired");
  assert.equal(commit.effect, "none");
  assert.equal(decline.duplicate, true);
  assert.equal(native.calls.filter((call) => call.method.includes("consume")).length, 0);
});

import assert from "node:assert/strict";
import { MeteredConsentGate } from "../src/metered-consent.mjs";

const quota = {
  status: "ok",
  observedAt: "2026-08-13T00:00:00.000Z",
  usage: { status: "ok", value: {} },
  rateLimits: {
    status: "ok",
    value: {
      limits: [{
        key: "codex",
        limitId: "codex",
        limitName: "Codex",
        planType: "plus",
        windows: [{ kind: "primary", usedPercent: 37, resetsAt: 1800000000, windowDurationMins: 300 }],
      }],
    },
  },
};

const off = new MeteredConsentGate({ mode: "off" });
assert.equal((await off.authorize({ action: "start", requestId: "off-1", payload: { prompt: "x" } })).authorized, true);

let quotaCalls = 0;
const always = new MeteredConsentGate({ mode: "always", quotaProvider: async () => { quotaCalls += 1; return quota; } });
const first = await always.authorize({ action: "start", requestId: "req-1", payload: { prompt: "TASK", cwd: null } });
assert.equal(first.authorized, false);
assert.equal(first.consent.status, "required");
assert.match(first.consent.consentRef, /^consent_/);
assert.equal(first.consent.quota.rateLimits.limits[0].windows[0].remainingPercent, 63);
assert.equal(quotaCalls, 1);

const repeatedCard = await always.authorize({ action: "start", requestId: "req-1", payload: { prompt: "TASK", cwd: null } });
assert.equal(repeatedCard.authorized, false);
assert.equal(repeatedCard.duplicate, true);
assert.equal(repeatedCard.consent.consentRef, first.consent.consentRef);
assert.equal(quotaCalls, 1);

await assert.rejects(
  () => always.authorize({ action: "start", requestId: "req-1", payload: { prompt: "DIFFERENT", cwd: null } }),
  /different metered start request/
);
await assert.rejects(
  () => always.authorize({ action: "start", requestId: "req-new", payload: { prompt: "TASK", cwd: null }, consentRef: first.consent.consentRef }),
  /unknown or stale/
);

const approved = await always.authorize({
  action: "start",
  requestId: "req-1",
  payload: { prompt: "TASK", cwd: null },
  consentRef: first.consent.consentRef,
});
assert.equal(approved.authorized, true);
assert.equal(approved.duplicate, false);

const safeRetry = await always.authorize({
  action: "start",
  requestId: "req-1",
  payload: { prompt: "TASK", cwd: null },
  consentRef: first.consent.consentRef,
});
assert.equal(safeRetry.authorized, true);
assert.equal(safeRetry.duplicate, true);
assert.equal(quotaCalls, 1);

const missingRefAfterApproval = await always.authorize({ action: "start", requestId: "req-1", payload: { prompt: "TASK", cwd: null } });
assert.equal(missingRefAfterApproval.authorized, false);
assert.equal(missingRefAfterApproval.consent.consentRef, first.consent.consentRef);

const effortGate = new MeteredConsentGate({ mode: "always", quotaProvider: async () => quota });
const effortPayload = { prompt: "EFFORT_TASK", cwd: null, model: "fake-default", reasoningEffort: "ultra" };
const effortPrepared = await effortGate.authorize({ action: "start", requestId: "effort-1", payload: effortPayload });
assert.equal(effortPrepared.authorized, false);
await assert.rejects(
  () => effortGate.authorize({
    action: "start",
    requestId: "effort-1",
    payload: { ...effortPayload, reasoningEffort: "medium" },
  }),
  /different metered start request/
);
const effortApproved = await effortGate.authorize({
  action: "start",
  requestId: "effort-1",
  payload: effortPayload,
  consentRef: effortPrepared.consent.consentRef,
});
assert.equal(effortApproved.authorized, true);

console.log("metered-consent: ok");

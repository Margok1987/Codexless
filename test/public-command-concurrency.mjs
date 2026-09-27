import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicCommandConcurrencyGate,
  createPublicCommandBusyResult,
} from "../src/public-command-concurrency.mjs";

test("public command concurrency gate admits the configured isolated calls", () => {
  const gate = createPublicCommandConcurrencyGate(4);
  const releases = [
    gate.tryAcquire(),
    gate.tryAcquire(),
    gate.tryAcquire(),
    gate.tryAcquire(),
  ];
  assert.equal(releases.every((release) => typeof release === "function"), true);
  assert.deepEqual(gate.snapshot(), { inFlight: 4, maxConcurrent: 4 });
  assert.equal(gate.tryAcquire(), null);

  releases[0]();
  assert.deepEqual(gate.snapshot(), { inFlight: 3, maxConcurrent: 4 });
  assert.equal(typeof gate.tryAcquire(), "function");

  releases[0]();
  assert.equal(gate.snapshot().inFlight, 4, "release must be idempotent");
});

test("overflow is a non-error pre-dispatch retry signal", () => {
  const result = createPublicCommandBusyResult({ inFlight: 4, maxConcurrent: 4, surfaceVersion: "test-surface" });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.status, "busy");
  assert.equal(result.structuredContent.errorCode, "BRIDGE_BUSY_PRE_DISPATCH");
  assert.equal(result.structuredContent.retryable, true);
  assert.equal(result.structuredContent.dispatch, "not_started");
  assert.equal(result.structuredContent.effect, "none");
  assert.equal(result.structuredContent.maxConcurrent, 4);
  assert.equal(result.structuredContent.inFlight, 4);
  assert.equal(Number.isInteger(result.structuredContent.retryAfterMs), true);
  assert.equal(result.structuredContent.retryAfterMs > 0, true);
});

test("public command concurrency gate rejects unsupported limits", () => {
  for (const value of [0, 5, 1.5, null]) {
    assert.throws(() => createPublicCommandConcurrencyGate(value), /between 1 and 4/);
  }
});

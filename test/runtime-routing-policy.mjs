import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activateManagedRuntimeIfReady } from "../src/managed-runtime-readiness.mjs";
import {
  activateDualRuntimePolicy,
  DUAL_READY_ACTIVATION,
  effectiveRuntimeRouting,
  PENDING_MANAGED_ACTIVATION,
  readRuntimeRoutingState,
  writeRuntimeInstallPreference,
} from "../src/runtime-routing-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");
const managedRuntime = Object.freeze({
  lane: "managed",
  packageName: "@openai/codex",
  packageVersion: "0.147.0",
  platformPackageName: process.platform === "darwin" ? "@openai/codex-darwin-arm64" : "@openai/codex-win32-x64",
  platformPackageVersion: process.platform === "darwin" ? "0.147.0-darwin-arm64" : "0.147.0-win32-x64",
  binarySha256: "a".repeat(64),
});

function ready() {
  return {
    status: "ready",
    accountRead: true,
    modelList: true,
    configRead: true,
    account: { accountPresent: true, authMode: "chatgpt", planType: "test" },
  };
}

function notReady() {
  return {
    status: "not_ready",
    reason: "official_chatgpt_login_required",
    accountRead: true,
    modelList: false,
    configRead: false,
    account: { accountPresent: false, authMode: null, planType: null },
    nextAction: "Complete official ChatGPT login and retry readiness.",
    noFallbackPerformed: true,
  };
}

test("Recommended is readiness-gated: pre-activation readiness failure stays Existing-only pending", async (t) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-routing-pending-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));

  const before = await effectiveRuntimeRouting({ root, stateRoot, env: {} });
  assert.equal(before.installMode, "recommended");
  assert.equal(before.activation, PENDING_MANAGED_ACTIVATION);
  assert.equal(before.managedReady, false);
  assert.deepEqual(before.routes, { stableModelFree: "existing", browser: "existing", formalAgent: "existing" });

  const result = await activateManagedRuntimeIfReady({
    runtime: managedRuntime,
    stateRoot,
    probe: async () => notReady(),
  });
  assert.equal(result.activated, false);
  assert.equal(result.activation, PENDING_MANAGED_ACTIVATION);
  assert.equal(result.readinessStatus, "pending");
  assert.equal(result.stateUnchanged, true);
  assert.equal(result.noFallbackPerformed, true);

  const after = await readRuntimeRoutingState({ stateRoot });
  assert.equal(after.activation, PENDING_MANAGED_ACTIVATION);
  assert.equal(after.managedReady, false);
  assert.equal(after.persisted, false);
});

test("successful official Managed readiness atomically activates dual policy", async (t) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-routing-ready-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));

  const activated = await activateDualRuntimePolicy({
    stateRoot,
    managedRuntime,
    readiness: ready(),
    now: Date.UTC(2026, 7, 21, 9, 0, 0),
  });
  assert.equal(activated.activation, DUAL_READY_ACTIVATION);
  assert.equal(activated.managedReady, true);
  const disk = JSON.parse(await readFile(activated.statePath, "utf8"));
  assert.equal(disk.activation, DUAL_READY_ACTIVATION);
  assert.equal(disk.readiness.account.authMode, "chatgpt");

  const routing = await effectiveRuntimeRouting({ root, stateRoot, env: {} });
  assert.equal(routing.activation, DUAL_READY_ACTIVATION);
  assert.deepEqual(routing.routes, { stableModelFree: "managed", browser: "existing", formalAgent: "existing" });
  assert.equal(routing.noSilentFallback, true);
});

test("post-dual readiness failure remains dual-active/degraded and never rewrites or downgrades state", async (t) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-routing-degraded-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));

  const activated = await activateDualRuntimePolicy({
    stateRoot,
    managedRuntime,
    readiness: ready(),
    now: Date.UTC(2026, 7, 21, 9, 10, 0),
  });
  const beforeBytes = await readFile(activated.statePath, "utf8");

  const result = await activateManagedRuntimeIfReady({
    runtime: managedRuntime,
    stateRoot,
    probe: async () => notReady(),
  });
  assert.equal(result.activated, true);
  assert.equal(result.activation, DUAL_READY_ACTIVATION);
  assert.equal(result.readinessStatus, "degraded");
  assert.equal(result.stateUnchanged, true);
  assert.equal(result.noFallbackPerformed, true);
  assert.match(result.nextAction, /remains active/i);
  assert.match(result.nextAction, /do not route this call to Existing as fallback/i);

  const afterBytes = await readFile(activated.statePath, "utf8");
  assert.equal(afterBytes, beforeBytes, "failed post-dual readiness probe must not rewrite persisted dual-ready state");
  const routing = await effectiveRuntimeRouting({ root, stateRoot, env: {} });
  assert.equal(routing.activation, DUAL_READY_ACTIVATION);
  assert.equal(routing.routes.stableModelFree, "managed");
  assert.equal(routing.routes.browser, "existing");
  assert.equal(routing.routes.formalAgent, "existing");
});

test("Advanced Existing-only preference survives update/reinstall state and explicitly opts out even when dual readiness is persisted", async (t) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-routing-existing-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  await activateDualRuntimePolicy({ stateRoot, managedRuntime, readiness: ready() });
  const preference = await writeRuntimeInstallPreference({ stateRoot, mode: "existing" });
  assert.equal(preference.mode, "existing");

  const routing = await effectiveRuntimeRouting({ root, stateRoot, env: {} });
  assert.equal(routing.installMode, "existing");
  assert.equal(routing.activation, "existing_only_explicit");
  assert.deepEqual(routing.routes, { stableModelFree: "existing", browser: "existing", formalAgent: "existing" });
  assert.equal(routing.managedReady, true, "readiness state remains preserved for a later opt-in return");
  assert.equal(routing.preferenceSource, "user-state");

  await writeRuntimeInstallPreference({ stateRoot, mode: "recommended" });
  const returned = await effectiveRuntimeRouting({ root, stateRoot, env: {} });
  assert.equal(returned.activation, DUAL_READY_ACTIVATION);
  assert.equal(returned.routes.stableModelFree, "managed");
  assert.equal(returned.preferenceSource, "user-state");
});

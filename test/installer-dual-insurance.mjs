import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  activateDualRuntimePolicy,
  clearRuntimeInstallPreference,
  effectiveRuntimeRouting,
  readRuntimeInstallPreference,
  writeRuntimeInstallPreference,
} from "../src/runtime-routing-policy.mjs";
import { managedPlatformPackageSpec } from "../src/codex-runtime-provider.mjs";
import { redactHomePath } from "../src/codex-bin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(root, ...relative.split("/")), "utf8"));
}

function readyStateRuntime() {
  return {
    packageName: "@openai/codex",
    packageVersion: "0.147.0",
    platformPackageName: "@openai/codex-win32-x64",
    platformPackageVersion: "0.147.0-win32-x64",
    binarySha256: "b".repeat(64),
  };
}

function readyEvidence() {
  return {
    status: "ready",
    accountRead: true,
    modelList: true,
    configRead: true,
    account: { authMode: "chatgpt", planType: "test" },
  };
}

test("installer product policy is Recommended dual insurance with readiness-gated activation and no Managed-only UX", async () => {
  const policy = await readJson("config/runtime-routing-policy.json");
  assert.equal(policy.defaultInstallMode, "recommended");
  assert.deepEqual(policy.installerModes.recommended.provision, ["existing", "managed"]);
  assert.equal(policy.defaultActivationState, "existing_only_pending_managed");
  assert.equal(policy.dualReadyActivationState, "dual_ready");
  assert.equal(policy.activation.provisioningDoesNotActivateDualPolicy, true);
  assert.equal(policy.activation.pendingRoutesStableModelFreeTo, "existing");
  assert.equal(policy.activation.laterManagedFailureFallback, "forbidden");
  assert.equal(policy.managedOnlyInstallerOption, false);
  assert.equal(policy.noSilentFallback, true);
  assert.deepEqual(policy.installerModes.recommended.routes, {
    stableModelFree: "managed",
    browser: "existing",
    formalAgent: "existing",
  });
  assert.ok(policy.dualReadyMethodRoutes.managed.includes("codex.command_exec"));
  assert.ok(policy.dualReadyMethodRoutes.managed.includes("codex.read_many"));
  assert.ok(policy.dualReadyMethodRoutes.existing.includes("codex.skill_read"));
  assert.ok(policy.dualReadyMethodRoutes.existing.includes("codex.model_list"));
  assert.ok(policy.dualReadyMethodRoutes.existing.includes("codex.browser_*"));
  assert.ok(policy.dualReadyMethodRoutes.existing.includes("codex.agent_*"));
});

test("Windows and Mac release installers preserve entrypoints, expose only Advanced Existing-only/Recommended, provision Managed only for effective Recommended, and keep Browser Repair Existing-specific", async () => {
  const windowsText = await readFile(path.join(root, "scripts/install.ps1"), "utf8");
  const macText = await readFile(path.join(root, "scripts/install.sh"), "utf8");
  for (const [name, text] of [["windows", windowsText], ["mac", macText]]) {
    assert.match(text, /recommended/i, name);
    assert.match(text, /existing/i, name);
    assert.doesNotMatch(text, /\[switch\]\$ManagedOnly|--managed-only/i, name);
    assert.match(text, /runtime-install-state\.mjs/, name);
    assert.match(text, /verify-managed/, name);
    assert.match(text, /MANAGED_RUNTIME_PROVISION_FAILED/, name);
    assert.match(text, /managedOnboardingRequired/i, name);
    assert.match(text, /managedOnboardingCommand/i, name);
    assert.match(text, /managed-codex-login\.mjs/i, name);
    assert.match(text, /NEXT ACTION: Managed ChatGPT login is required before dual activation\./i, name);
    assert.match(text, /sync-codex-skills\.mjs/, name);
    assert.match(text, /target-lane/, name);
    assert.match(text, /existing/, name);
    assert.match(text, /rollback/i, name);
    assert.match(text, /finalize/i, name);
  }
  assert.match(windowsText, /\[switch\]\$ExistingOnly/);
  assert.match(windowsText, /\[switch\]\$Recommended/);
  assert.match(macText, /--existing-only/);
  assert.match(macText, /--recommended/);
});

test("Recommended pending doctor reports onboarding required with the exact official helper command; dual-ready remains ready/degraded rather than pending", async () => {
  const text = await readFile(path.join(root, "scripts/doctor.mjs"), "utf8");
  assert.match(text, /existing_only_pending_managed/);
  assert.match(text, /status: \"pending\"/);
  assert.match(text, /official_chatgpt_login_required/);
  assert.match(text, /managed-codex-login\.mjs/);
  assert.match(text, /Run: \$\{managedLoginCommand\}/);
  assert.match(text, /Run: \$\{managedLoginCommand\}`,[\s\S]*?false[\s\S]*?\);/);
  assert.match(text, /required: Boolean\(required\)/);
  assert.match(text, /check\.required \? \"FAIL\" : \"PENDING\"/);
  assert.doesNotMatch(text, /not_required/);
  assert.match(text, /managedProbe\.status === \"ready\"/);
  assert.match(text, /status: \"degraded\", probeStatus: managedProbe\.status/);
  assert.match(text, /Managed dual lane is degraded/);
  assert.match(text, /status: \"degraded\"/);
  assert.match(text, /Dual policy remains active/);
  assert.match(text, /allowUntrustedReadOnlyBootstrap: !requestedCwd/);
});

test("projected doctor compatibility keeps the public home-path redaction export available", () => {
  assert.equal(redactHomePath(os.homedir()), process.platform === "win32" ? "%USERPROFILE%" : "$HOME");
});

test("Managed package/native identities are exact for Windows x64 and Apple Silicon macOS", async () => {
  const pkg = await readJson("package.json");
  const lock = await readJson("npm-shrinkwrap.json");
  const pinnedVersion = pkg.dependencies["@openai/codex"];
  assert.match(pinnedVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(lock.packages[""].dependencies["@openai/codex"], pinnedVersion);
  assert.equal(lock.packages["node_modules/@openai/codex"].version, pinnedVersion);
  for (const expected of [
    {
      platform: "win32", arch: "x64", packageName: "@openai/codex-win32-x64",
      version: `${pinnedVersion}-win32-x64`, triple: "x86_64-pc-windows-msvc", executable: "codex.exe",
    },
    {
      platform: "darwin", arch: "arm64", packageName: "@openai/codex-darwin-arm64",
      version: `${pinnedVersion}-darwin-arm64`, triple: "aarch64-apple-darwin", executable: "codex",
    },
  ]) {
    const spec = managedPlatformPackageSpec(expected);
    assert.equal(spec.packageName, expected.packageName);
    assert.equal(spec.triple, expected.triple);
    assert.equal(spec.executable, expected.executable);
    const locked = lock.packages[`node_modules/${expected.packageName}`];
    assert.equal(locked.version, expected.version);
    assert.match(locked.integrity, /^sha512-/);
    assert.deepEqual(locked.os, [expected.platform]);
    assert.deepEqual(locked.cpu, [expected.arch]);
  }
});

test("runtime preference and dual readiness are external user state; Managed home/Profile sentinels survive preference changes and state reads", async (t) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-installer-state-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const managedHome = path.join(stateRoot, "managed-codex-home");
  const profile = path.join(stateRoot, "codex-call-profile.md");
  await mkdir(managedHome, { recursive: true });
  await writeFile(path.join(managedHome, "auth-sentinel.json"), "managed-user-state\n", "utf8");
  await writeFile(profile, "profile-user-state\n", "utf8");

  const initial = await effectiveRuntimeRouting({ root, stateRoot, env: {} });
  assert.equal(initial.activation, "existing_only_pending_managed");
  assert.equal(initial.routes.stableModelFree, "existing");

  await writeRuntimeInstallPreference({ stateRoot, mode: "existing" });
  assert.equal((await readRuntimeInstallPreference({ stateRoot })).mode, "existing");
  await activateDualRuntimePolicy({ stateRoot, managedRuntime: readyStateRuntime(), readiness: readyEvidence() });
  const optedOut = await effectiveRuntimeRouting({ root, stateRoot, env: {} });
  assert.equal(optedOut.activation, "existing_only_explicit");
  assert.equal(optedOut.managedReady, true);
  assert.equal(await readFile(path.join(managedHome, "auth-sentinel.json"), "utf8"), "managed-user-state\n");
  assert.equal(await readFile(profile, "utf8"), "profile-user-state\n");

  await writeRuntimeInstallPreference({ stateRoot, mode: "recommended" });
  const returned = await effectiveRuntimeRouting({ root, stateRoot, env: {} });
  assert.equal(returned.activation, "dual_ready");
  assert.equal(returned.routes.stableModelFree, "managed");
  assert.equal(returned.routes.browser, "existing");
  assert.equal(returned.routes.formalAgent, "existing");
  assert.equal(await readFile(path.join(managedHome, "auth-sentinel.json"), "utf8"), "managed-user-state\n");
  assert.equal(await readFile(profile, "utf8"), "profile-user-state\n");

  await clearRuntimeInstallPreference({ stateRoot });
  assert.equal((await readRuntimeInstallPreference({ stateRoot })).persisted, false);
  assert.equal(await readFile(path.join(managedHome, "auth-sentinel.json"), "utf8"), "managed-user-state\n");
  assert.equal(await readFile(profile, "utf8"), "profile-user-state\n");
});

test("public release manifest includes the installer/Managed/Skill sources with exact shipped bytes", async () => {
  // The public fork contains the assembled product, not its private export overlays.
  const manifest = await readJson("config/release-manifest.json");
  const targets = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  for (const target of [
    "config/runtime-install-mode.json",
    "config/runtime-routing-policy.json",
    "config/skill-lane-policy.json",
    "scripts/runtime-install-state.mjs",
    "scripts/managed-codex-login.mjs",
    "skills/codexless-browser-repair/SKILL.md",
    "src/codex-runtime-provider.mjs",
    "src/codexless-runtime.mjs",
    "src/lazy-codex-agent-executor.mjs",
    "src/lazy-codex-authority-executor.mjs",
    "src/managed-runtime-readiness.mjs",
    "src/runtime-routing-policy.mjs",
    "src/release-discovery.mjs",
    "src/lifecycle-contract.mjs",
    "src/platform-support.mjs",
    "scripts/install.ps1",
    "scripts/install.sh",
    "scripts/doctor.mjs",
  ]) {
    assert.equal(targets.has(target), true, target);
    const digest = createHash("sha256").update(await readFile(path.join(root, target))).digest("hex");
    assert.equal(targets.get(target), digest, `${target}: stale release payload`);
  }
  assert.equal(targets.has("test/installer-lifecycle-windows.mjs"), false, "tests are not installable runtime payload");
});

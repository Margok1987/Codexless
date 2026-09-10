import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import {
  assertCodexAccountHome,
  loadCodexAccountRegistry,
  resolveCodexAccount,
} from "../src/codex-account-registry.mjs";
import { createCodexRuntimeProvider, managedLaunchEnv } from "../src/codex-runtime-provider.mjs";
import { activateManagedRuntimeIfReady, probeManagedRuntimeReadiness } from "../src/managed-runtime-readiness.mjs";
import { defaultCodexlessStateRoot } from "../src/runtime-routing-policy.mjs";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  if (value !== value.trim()) throw new Error(`${name} must be exact without surrounding whitespace`);
  return value;
}

export async function runManagedCodexLogin() {
  const env = { ...process.env, CODEXLESS_CODEX_RUNTIME: "managed" };
  const stateRoot = path.resolve(defaultCodexlessStateRoot());
  const provider = await createCodexRuntimeProvider({ env, stateRoot });
  const baseRuntime = provider.modelFree;
  const requestedAccount = argumentValue("--account");
  const registry = await loadCodexAccountRegistry({
    stateRoot,
    legacyCodexHome: baseRuntime.codexHome,
  });
  const selectedAccount = resolveCodexAccount(registry, requestedAccount);
  if (registry.source !== "legacy") {
    const taskStateFile = path.resolve(process.env.CODEXLESS_AGENT_TASK_STATE_FILE || path.join(stateRoot, "agent-task-cards.json"));
    await assertAccountProvisioningIdle({ taskStateFile, accountId: selectedAccount.id });
  }
  let selectedCodexHome = registry.source === "legacy" ? baseRuntime.codexHome : selectedAccount.codexHome;
  if (registry.source !== "legacy" && selectedCodexHome) {
    selectedCodexHome = await assertCodexAccountHome(
      { ...selectedAccount, codexHome: selectedCodexHome },
      { stateRoot, registry, allowMissing: true }
    );
    await mkdir(selectedCodexHome, { recursive: true });
    selectedCodexHome = await assertCodexAccountHome(
      { ...selectedAccount, codexHome: selectedCodexHome },
      { stateRoot, registry }
    );
  }
  const primaryAccount = registry.source === "legacy";
  const runtime = primaryAccount
    ? baseRuntime
    : {
        ...baseRuntime,
        codexHome: selectedCodexHome,
        launchEnv: managedLaunchEnv(env, selectedCodexHome),
      };
  const cwd = path.resolve(process.env.CODEX_TOOLBOX_DEFAULT_CWD || process.cwd());
  const client = new CodexAppServerClient({
    cwd,
    launch: () => ({
      command: runtime.bin,
      args: ["app-server", "--stdio"],
      options: { cwd, env: runtime.launchEnv },
    }),
    requestTimeoutMs: 30_000,
    initializeCapabilities: { experimentalApi: true },
    stderrHandler: () => {},
    clientInfo: { name: "codexless_managed_login", title: "Codexless Managed Login", version: "2" },
  });

  function sanitizedAccount(response) {
    return {
      accountPresent: Boolean(response?.account),
      authMode: response?.account?.type ?? null,
      planType: response?.account?.planType ?? null,
      requiresOpenaiAuth: response?.requiresOpenaiAuth ?? null,
    };
  }

  function openOfficialLogin(url) {
    const spec = process.platform === "win32"
      ? { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
      : process.platform === "darwin"
        ? { command: "open", args: [url] }
        : { command: "xdg-open", args: [url] };
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, { stdio: "ignore", windowsHide: true, detached: true });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  function waitForLoginCompletion(loginId, timeoutMs = 300_000) {
    let timer = null, dispose = null, rejectWait = null, settled = false;
    function cleanup() { if (timer) clearTimeout(timer); dispose?.(); }
    const promise = new Promise((resolve, reject) => {
      rejectWait = reject;
      dispose = client.onNotification((message) => {
        if (message.method !== "account/login/completed" || message.params?.loginId !== loginId || settled) return;
        settled = true; cleanup(); resolve(message.params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup(); reject(new Error("official ChatGPT login did not complete before the local helper timeout"));
      }, timeoutMs);
      timer.unref?.();
    });
    // Browser startup can fail before the caller awaits completion.
    promise.catch(() => {});
    return { promise, cancel() {
      if (settled) return;
      settled = true; cleanup(); rejectWait(new Error("local login wait was cancelled"));
    } };
  }

  async function qualifySelectedRuntime() {
    if (primaryAccount) return activateManagedRuntimeIfReady({ runtime, cwd });
    const readiness = await probeManagedRuntimeReadiness({ runtime, cwd });
    return {
      activation: "account_ready_only",
      managedReady: readiness.status === "ready",
      readiness,
      globalRoutingChanged: false,
    };
  }

  function readinessPassed(qualification) {
    return qualification?.readiness?.status === "ready"
      || qualification?.managedReady === true
      || qualification?.activation === "dual_ready";
  }

  let loginId = null;
  let loginWait = null;
  try {
    await client.start();
    const before = await client.request("account/read", { refreshToken: false });
    if (before?.account) {
      assertManagedLoginAccount(before, { registryAccount: !primaryAccount });
      const qualification = await qualifySelectedRuntime();
      console.log(JSON.stringify({
        status: readinessPassed(qualification) ? "already_logged_in_ready" : "already_logged_in_not_ready",
        accountId: registry.source === "legacy" ? null : selectedAccount.id,
        runtime: runtime.version,
        managedCodexHome: runtime.codexHome,
        account: sanitizedAccount(before),
        qualification,
      }, null, 2));
      process.exitCode = readinessPassed(qualification) ? 0 : 1;
    } else {
      const started = await client.request("account/login/start", { type: "chatgpt" });
      loginId = started?.loginId ?? null;
      if (started?.type !== "chatgpt" || typeof started?.authUrl !== "string" || !started.authUrl || typeof loginId !== "string" || !loginId) {
        throw new Error("official Codex runtime did not return a usable ChatGPT login flow");
      }
      loginWait = waitForLoginCompletion(loginId);
      await openOfficialLogin(started.authUrl);
      console.log(JSON.stringify({
        status: "login_started",
        accountId: registry.source === "legacy" ? null : selectedAccount.id,
        runtime: runtime.version,
        managedCodexHome: runtime.codexHome,
        browserOpened: true,
        authUrlPrintedOrSaved: false,
        next: "Complete the official ChatGPT sign-in in the opened browser window.",
      }, null, 2));
      const completed = await loginWait.promise;
      if (completed?.success !== true) throw new Error("official ChatGPT login did not succeed");
      const after = await client.request("account/read", { refreshToken: false });
      assertManagedLoginAccount(after, { registryAccount: true });
      const qualification = await qualifySelectedRuntime();
      console.log(JSON.stringify({
        status: readinessPassed(qualification) ? "login_complete_ready" : "login_complete_not_ready",
        accountId: registry.source === "legacy" ? null : selectedAccount.id,
        runtime: runtime.version,
        managedCodexHome: runtime.codexHome,
        account: sanitizedAccount(after),
        qualification,
      }, null, 2));
      if (!readinessPassed(qualification)) process.exitCode = 1;
    }
  } catch (error) {
    if (loginId) await client.request("account/login/cancel", { loginId }).catch(() => {});
    console.error(JSON.stringify({
      status: "login_failed",
      accountId: registry.source === "legacy" ? null : selectedAccount.id,
      managedCodexHome: runtime.codexHome,
      message: safeManagedLoginError(error),
      credentialContentsReadByCodexless: false,
      authUrlPrintedOrSaved: false,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    loginWait?.cancel();
    try { await client.close(); }
    catch { console.error(JSON.stringify({ status: "login_cleanup_failed", message: "The local login App Server could not be closed" })); process.exitCode = 1; }
  }
}

export async function assertAccountProvisioningIdle({ taskStateFile, accountId } = {}) {
  if (typeof taskStateFile !== "string" || !taskStateFile) throw new TypeError("taskStateFile is required");
  if (typeof accountId !== "string" || !accountId) throw new TypeError("accountId is required");
  const configuredPath = path.resolve(taskStateFile);
  const v2Path = configuredPath + ".v2";
  const retiredPath = configuredPath + ".v1-retired";
  const unsafe = () => Object.assign(
    new Error("Selected account provisioning is blocked because persisted task state cannot be verified"),
    { code: "CODEX_ACCOUNT_TASK_STATE_UNSAFE" }
  );
  const kind = async (target) => {
    try {
      const info = await stat(target);
      return info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
    } catch (error) {
      if (error?.code === "ENOENT") return "missing";
      throw unsafe();
    }
  };
  let parsed;
  const v2Kind = await kind(v2Path);
  const configuredKind = await kind(configuredPath);
  const retiredKind = await kind(retiredPath);
  try {
    if (v2Kind === "file") {
      if (configuredKind !== "directory" || retiredKind !== "missing") throw unsafe();
      parsed = JSON.parse(await readFile(v2Path, "utf8"));
      if (parsed?.version !== 2) throw unsafe();
    } else if (v2Kind !== "missing") {
      throw unsafe();
    } else if (configuredKind === "file") {
      if (retiredKind !== "missing") throw unsafe();
      parsed = JSON.parse(await readFile(configuredPath, "utf8"));
      if (parsed?.version !== 1) throw unsafe();
    } else if (configuredKind === "directory") {
      if (retiredKind !== "missing") throw unsafe();
      return { status: "clear", activeTasks: 0 };
    } else if (configuredKind === "missing" && retiredKind === "missing") {
      return { status: "clear", activeTasks: 0 };
    } else {
      throw unsafe();
    }
  } catch (error) {
    if (error?.code === "CODEX_ACCOUNT_TASK_STATE_UNSAFE") throw error;
    throw unsafe();
  }
  if (!Array.isArray(parsed.records)) throw unsafe();
  const terminalStatuses = new Set(["idle", "completed", "failed", "interrupted", "rejected", "lost"]);
  let activeTasks = 0;
  for (const record of parsed.records) {
    if (record?.taskCard?.account !== accountId) continue;
    const terminalStatus = record?.terminalSnapshot?.status;
    const terminal = record?.phase === "terminal" && terminalStatuses.has(terminalStatus);
    if (!terminal) activeTasks += 1;
  }
  if (activeTasks) {
    throw Object.assign(
      new Error("Selected account has active or unresolved Codex tasks; login/re-provisioning is blocked"),
      { code: "CODEX_ACCOUNT_PROVISIONING_ACTIVE" }
    );
  }
  return { status: "clear", activeTasks: 0 };
}

export function assertManagedLoginAccount(response, { registryAccount = true } = {}) {
  if (!registryAccount) return;
  if (response?.account?.type !== "chatgpt") {
    throw Object.assign(new Error("Selected account requires its own official ChatGPT login; existing credentials are not changed automatically"), { code: "CODEX_ACCOUNT_AUTH_REQUIRED" });
  }
}

export function safeManagedLoginError(error) {
  const messages = {
    CODEX_ACCOUNT_AUTH_REQUIRED: "Selected account requires its own official ChatGPT login; no existing credentials were replaced",
    CODEX_ACCOUNT_HOME_UNSAFE: "Selected account home failed the local safety checks",
    CODEX_ACCOUNT_HOME_MISSING: "Selected account home is not provisioned",
    CODEX_ACCOUNT_REGISTRY_INVALID: "The local account registry is invalid",
    CODEX_ACCOUNT_REQUIRED: "Select an explicit configured account for login",
    CODEX_ACCOUNT_UNKNOWN: "The selected account is not configured",
    CODEX_ACCOUNT_INVALID: "The selected account ID is invalid",
    CODEX_ACCOUNT_PROVISIONING_ACTIVE: "Selected account has active or unresolved Codex tasks; login/re-provisioning is blocked",
    CODEX_ACCOUNT_TASK_STATE_UNSAFE: "Selected account provisioning is blocked because persisted task state cannot be verified",
  };
  return Object.hasOwn(messages, error?.code) ? messages[error.code]
    : "Official login or local readiness failed; credential contents and upstream diagnostics are withheld";
}

// Importing this module for deterministic tests never opens an App Server,
// reads an account, or starts a login flow.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runManagedCodexLogin(); }
  catch (error) {
    console.error(JSON.stringify({ status: "login_failed", message: safeManagedLoginError(error), credentialContentsReadByCodexless: false }));
    process.exitCode = 1;
  }
}

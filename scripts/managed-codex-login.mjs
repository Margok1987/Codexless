import { spawn } from "node:child_process";
import path from "node:path";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { createCodexRuntimeProvider } from "../src/codex-runtime-provider.mjs";
import { activateManagedRuntimeIfReady } from "../src/managed-runtime-readiness.mjs";

const env = { ...process.env, CODEXLESS_CODEX_RUNTIME: "managed" };
const provider = await createCodexRuntimeProvider({ env });
const runtime = provider.modelFree;
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
  clientInfo: { name: "codexless_managed_login", title: "Codexless Managed Login", version: "1" },
});

function safeErrorMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/https?:\/\/\S+/gi, "[official-login-url-redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

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
  return new Promise((resolve, reject) => {
    let settled = false;
    const dispose = client.onNotification((message) => {
      if (message.method !== "account/login/completed") return;
      if (message.params?.loginId && message.params.loginId !== loginId) return;
      settled = true;
      clearTimeout(timer);
      dispose();
      resolve(message.params ?? {});
    });
    const timer = setTimeout(() => {
      if (settled) return;
      dispose();
      reject(new Error("official ChatGPT login did not complete before the local helper timeout"));
    }, timeoutMs);
    timer.unref?.();
  });
}

let loginId = null;
try {
  await client.start();
  const before = await client.request("account/read", { refreshToken: false });
  if (before?.account) {
    const activation = await activateManagedRuntimeIfReady({ runtime, cwd });
    console.log(JSON.stringify({
      status: activation.readiness?.status === "ready" ? "already_logged_in_ready" : "already_logged_in_not_ready",
      runtime: runtime.version,
      managedCodexHome: runtime.codexHome,
      account: sanitizedAccount(before),
      routing: activation,
    }, null, 2));
    process.exitCode = activation.readiness?.status === "ready" || activation.activation === "dual_ready" ? 0 : 1;
  } else {
    const started = await client.request("account/login/start", { type: "chatgpt" });
    loginId = started?.loginId ?? null;
    if (started?.type !== "chatgpt" || typeof started?.authUrl !== "string" || !started.authUrl || typeof loginId !== "string" || !loginId) {
      throw new Error("official Codex runtime did not return a usable ChatGPT login flow");
    }
    const completion = waitForLoginCompletion(loginId);
    await openOfficialLogin(started.authUrl);
    console.log(JSON.stringify({
      status: "login_started",
      runtime: runtime.version,
      managedCodexHome: runtime.codexHome,
      browserOpened: true,
      authUrlPrintedOrSaved: false,
      next: "Complete the official ChatGPT sign-in in the opened browser window.",
    }, null, 2));
    const completed = await completion;
    if (completed?.success !== true) throw new Error(completed?.error || "official ChatGPT login did not succeed");
    const after = await client.request("account/read", { refreshToken: false });
    const activation = await activateManagedRuntimeIfReady({ runtime, cwd });
    console.log(JSON.stringify({
      status: activation.readiness?.status === "ready" ? "login_complete_ready" : "login_complete_not_ready",
      runtime: runtime.version,
      managedCodexHome: runtime.codexHome,
      account: sanitizedAccount(after),
      routing: activation,
    }, null, 2));
    if (activation.readiness?.status !== "ready" && activation.activation !== "dual_ready") process.exitCode = 1;
  }
} catch (error) {
  if (loginId) await client.request("account/login/cancel", { loginId }).catch(() => {});
  console.error(JSON.stringify({
    status: "login_failed",
    managedCodexHome: runtime.codexHome,
    message: safeErrorMessage(error),
    credentialContentsReadByCodexless: false,
    authUrlPrintedOrSaved: false,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}

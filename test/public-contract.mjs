import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";
import { AGENT_TASK_CARD_URI } from "../src/agent-card-ui.mjs";

const require = createRequire(import.meta.url);
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const projectRoot = path.resolve(import.meta.dirname, "..");
const codexBin = (await resolveCodexExecutable()).path;
const testCwd = process.env.CODEXLESS_TEST_CWD;
const contractStateRoot = mkdtempSync(path.join(os.tmpdir(), "codexless-public-contract-"));
const recentCallStateFile = path.join(contractStateRoot, "recent-calls.json");
const agentTaskStateFile = path.join(contractStateRoot, "agent-task-cards.json");
process.once("exit", () => rmSync(contractStateRoot, { recursive: true, force: true }));

function createIsolatedPublicTestEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_TOOLBOX_") || key.startsWith("CODEXLESS_")) delete env[key];
  }
  Object.assign(env, {
    CODEX_BIN: codexBin,
    // Poison legacy Toolwire variables deliberately. A clean Codexless runtime must ignore all of them.
    CODEX_TOOLBOX_DEFAULT_CWD: "Z:\\codexless-must-ignore",
    CODEX_TOOLBOX_PROFILE: "__codexless_must_ignore__",
    CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE: "Z:\\codexless-must-ignore.json",
    CODEX_TOOLBOX_AGENT_METERED_CONSENT: "__codexless_must_ignore__",
    CODEXLESS_RECENT_CALLS_STATE_FILE: recentCallStateFile,
    CODEXLESS_AGENT_TASK_STATE_FILE: agentTaskStateFile,
    ...(testCwd ? { CODEXLESS_DEFAULT_CWD: testCwd } : {}),
    ...extra,
  });
  return env;
}

assert.equal(PUBLIC_SURFACE_VERSION, "codexless-public-preview-v1");
assert.equal(PUBLIC_TOOL_NAMES.length, 39);
for (const relative of [
  "src/browser-tools.mjs",
  "src/codex-browser-executor.mjs",
  "src/construction-tools.mjs",
  "src/agent-tools.mjs",
  "src/public-context-tools.mjs",
  "src/public-server-factory.mjs",
]) {
  const text = readFileSync(path.join(projectRoot, relative), "utf8");
  assert.doesNotMatch(text, /Toolwire/, `public/model-facing source must not expose the internal Toolwire brand: ${relative}`);
}

const forbiddenNames = [
  "codex.fs_read",
  "codex.fs_mutate",
  "codex.process",
  "codex.process_receipt",
  "codex.catalog",
  "codex.mcp_call",
];

const client = new Client({ name: "codexless-public-contract", version: "0.1.0" });
if (process.env.MCP_TEST_NEGOTIATION === "modern") client.setVersionNegotiation({ mode: "auto" });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "mcp-stdio.mjs")],
  cwd: projectRoot,
  env: createIsolatedPublicTestEnv(),
  stderr: "pipe",
});
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => process.stderr.write(`[codexless] ${chunk}`));

await client.connect(transport);
try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.deepEqual([...names].sort(), [...PUBLIC_TOOL_NAMES].sort());
  assert.equal(names.length, 39);

  for (const name of forbiddenNames) {
    assert.equal(names.includes(name), false, `${name} must not be exposed by the public preview`);
  }
  assert.equal(names.some((name) => name.startsWith("computer.")), false);
  assert.deepEqual(
    names.filter((name) => name.startsWith("codex.browser_")),
    PUBLIC_TOOL_NAMES.filter((name) => name.startsWith("codex.browser_")),
    "runtime Browser registration order must match the canonical public surface contract"
  );

  const commandTool = tools.tools.find((tool) => tool.name === "codex.command_exec");
  const preciseEditTool = tools.tools.find((tool) => tool.name === "codex.precise_edit");
  const skillListTool = tools.tools.find((tool) => tool.name === "codex.skill_list");
  const appOnlyCardToolNames = ["codex.agent_card_state"];
  assert.equal(commandTool?.annotations?.destructiveHint, true);
  assert.match(commandTool?.description ?? "", /must not launch Codex CLI|refuses nested Codex/i);
  const nestedCodexCommand = await client.callTool({
    name: "codex.command_exec",
    arguments: { command: [codexBin, "--version"], access: "readOnly" },
  });
  assert.equal(nestedCodexCommand.isError, true, "public command_exec must refuse a nested Codex CLI launch before dispatch");
  assert.equal(nestedCodexCommand.structuredContent?.errorCode, "METERED_CODEX_REQUIRES_AGENT_CARD");
  assert.match(nestedCodexCommand.structuredContent?.error ?? nestedCodexCommand.content?.[0]?.text ?? "", /codex\.agent_start/i);
  assert.equal(preciseEditTool?.annotations?.destructiveHint, true);
  assert.deepEqual(Object.keys(skillListTool?.inputSchema?.properties ?? {}).sort(), ["cwd", "query"]);
  assert.equal(Object.hasOwn(skillListTool?.inputSchema?.properties ?? {}, "kind"), false);
  for (const name of appOnlyCardToolNames) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.deepEqual(tool?._meta?.ui?.visibility, ["app"], `${name} must remain app-only`);
  }
  for (const name of ["codex.agent_commit", "codex.agent_decline"]) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.equal(tool?._meta?.ui?.visibility, undefined, `${name} must remain model-callable for Portable Card fallback`);
  }

  const resources = await client.listResources();
  assert.equal(resources.resources.some((resource) => resource.uri === AGENT_TASK_CARD_URI), true);
  const taskCardResource = await client.readResource({ uri: AGENT_TASK_CARD_URI });
  assert.equal(taskCardResource.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
  assert.match(taskCardResource.contents?.[0]?.text ?? "", /codex\.agent_commit/);
  assert.match(taskCardResource.contents?.[0]?.text ?? "", /codexlessCommitToken/);
  assert.match(taskCardResource.contents?.[0]?.text ?? "", /commitToken/);

  const startTool = tools.tools.find((tool) => tool.name === "codex.agent_start");
  const sendTool = tools.tools.find((tool) => tool.name === "codex.agent_send");
  assert.match(startTool?.description ?? "", /consentRef identifies.*never proof of approval/i);
  assert.match(sendTool?.description ?? "", /consentRef identifies.*never proof of approval/i);
  assert.match(startTool?.inputSchema?.properties?.consentRef?.description ?? "", /never authorizes/i);
  assert.match(sendTool?.inputSchema?.properties?.consentRef?.description ?? "", /never authorizes/i);
  assert.match(startTool?.inputSchema?.properties?.reasoningEffort?.description ?? "", /model_list|per-model/i);
  assert.match(sendTool?.inputSchema?.properties?.reasoningEffort?.description ?? "", /model_list|per-model/i);
  assert.equal(startTool?.inputSchema?.properties?.reasoningEffort?.maxLength, 128);
  assert.equal(sendTool?.inputSchema?.properties?.reasoningEffort?.maxLength, 128);
  assert.match(taskCardResource.contents?.[0]?.text ?? "", /requestedReasoningEffort/);

  const requestId = `contract-consent-${randomUUID()}`;
  const prompt = "Codexless contract probe: prepare only; do not start Codex.";
  const prepared = await client.callTool({
    name: "codex.agent_start",
    arguments: { prompt, requestId },
  });
  assert.equal(prepared.isError, false);
  assert.equal(prepared.structuredContent?.status, "consent_required");
  assert.equal(prepared.structuredContent?.turnId, null);
  assert.equal(prepared.structuredContent?.agentRef, null);
  assert.equal(prepared.structuredContent?.manualFallback?.kind, "portable_card");
  assert.equal(prepared.structuredContent?.manualFallback?.requiresTaskCard, false);
  assert.equal(prepared.structuredContent?.manualFallback?.nextAction, "codex.agent_card_render");
  assert.deepEqual(prepared.structuredContent?.manualFallback?.choices, ["Yes", "No"]);
  assert.match(prepared.structuredContent?.manualFallback?.taskId ?? "", /^C-[A-F0-9]{10}$/);
  const consentRef = prepared.structuredContent?.meteredConsent?.consentRef;
  assert.match(consentRef ?? "", /^consent_/);

  const replay = await client.callTool({
    name: "codex.agent_start",
    arguments: { prompt, requestId, consentRef },
  });
  assert.equal(replay.isError, false);
  assert.equal(replay.structuredContent?.status, "consent_required", "public consentRef replay must stay pending");
  assert.equal(replay.structuredContent?.turnId, null, "public consentRef replay must not start a Codex turn");
  assert.equal(replay.structuredContent?.agentRef, null, "public consentRef replay must not create an agent");
  assert.equal(replay.structuredContent?.duplicate, true);

  const rendered = await client.callTool({
    name: "codex.agent_card_render",
    arguments: { consentRef },
  });
  assert.equal(rendered.isError, false);
  assert.equal(rendered.structuredContent?.status, "consent_required");
  assert.equal(rendered.structuredContent?.turnId, null);
  const commitToken = rendered._meta?.codexlessCommitToken;
  assert.match(commitToken ?? "", /^commit_/);
  assert.equal(JSON.stringify(rendered.structuredContent).includes(commitToken), false, "commit capability must not leak into model-visible structuredContent");
  assert.equal((rendered.content?.[0]?.text ?? "").includes(commitToken), false, "commit capability must not leak into model-visible text content");
  assert.doesNotMatch(rendered.content?.[0]?.text ?? "", /[┌┐└┘│─]/, "Portable Card fallback should be plain text so the host can provide visual framing");
  assert.match(rendered.content?.[0]?.text ?? "", /Call Codex\?|调用 Codex？|Codexを呼び出しますか？/i);
  assert.match(rendered.content?.[0]?.text ?? "", /Yes/);
  assert.match(rendered.content?.[0]?.text ?? "", /No/);
  assert.equal((rendered.content?.[0]?.text ?? "").includes(rendered.structuredContent?.manualFallback?.taskId ?? ""), false, "Portable Card short task ID stays hidden in structured content");

  const effortRequestId = `contract-effort-${randomUUID()}`;
  const effortPrepared = await client.callTool({
    name: "codex.agent_start",
    arguments: { prompt: "Codexless contract probe: display requested reasoning effort only.", requestId: effortRequestId, reasoningEffort: "ultra" },
  });
  assert.equal(effortPrepared.isError, false);
  assert.equal(effortPrepared.structuredContent?.status, "consent_required");
  assert.equal(effortPrepared.structuredContent?.taskCard?.requestedReasoningEffort, "ultra");
  assert.equal(effortPrepared.structuredContent?.execution?.requestedReasoningEffort, "ultra");
  const effortConsentRef = effortPrepared.structuredContent?.meteredConsent?.consentRef;
  const effortRendered = await client.callTool({
    name: "codex.agent_card_render",
    arguments: { consentRef: effortConsentRef },
  });
  assert.match(effortRendered.content?.[0]?.text ?? "", /Reasoning effort|推理强度|推論強度/i);
  assert.match(effortRendered.content?.[0]?.text ?? "", /ultra/i);
  const effortDeclined = await client.callTool({
    name: "codex.agent_decline",
    arguments: { consentRef: effortConsentRef },
  });
  assert.equal(effortDeclined.isError, false);
  assert.equal(effortDeclined.structuredContent?.status, "rejected");

  const missingCapability = await client.callTool({
    name: "codex.agent_commit",
    arguments: { consentRef },
  }).catch((error) => ({ isError: true, error }));
  assert.equal(missingCapability.isError, true, "commit without the Task Card capability must fail closed");

  const wrongCapability = await client.callTool({
    name: "codex.agent_commit",
    arguments: { consentRef, commitToken: `commit_wrong_${randomUUID()}` },
  });
  assert.equal(wrongCapability.isError, true, "commit with the wrong Task Card capability must fail closed");
  assert.match(wrongCapability.structuredContent?.error ?? wrongCapability.content?.[0]?.text ?? "", /capability.*missing|capability.*does not match/i);

  const declineRequestId = `contract-decline-${randomUUID()}`;
  const declinePrompt = "Codexless contract probe: prepare, decline, and stay terminal without starting Codex.";
  const declinePrepared = await client.callTool({
    name: "codex.agent_start",
    arguments: { prompt: declinePrompt, requestId: declineRequestId },
  });
  assert.equal(declinePrepared.isError, false);
  assert.equal(declinePrepared.structuredContent?.status, "consent_required");
  assert.equal(declinePrepared.structuredContent?.agentRef, null);
  assert.equal(declinePrepared.structuredContent?.turnId, null);
  const declineConsentRef = declinePrepared.structuredContent?.meteredConsent?.consentRef;
  const declineRendered = await client.callTool({
    name: "codex.agent_card_render",
    arguments: { consentRef: declineConsentRef },
  });
  const declineCommitToken = declineRendered._meta?.codexlessCommitToken;
  assert.match(declineCommitToken ?? "", /^commit_/);

  const declined = await client.callTool({
    name: "codex.agent_decline",
    arguments: { consentRef: declineConsentRef },
  });
  assert.equal(declined.isError, false);
  assert.equal(declined.structuredContent?.status, "rejected");
  assert.equal(declined.structuredContent?.terminal, true);
  assert.equal(declined.structuredContent?.agentRef, null);
  assert.equal(declined.structuredContent?.turnId, null);

  const cachedCommitAfterDecline = await client.callTool({
    name: "codex.agent_commit",
    arguments: { consentRef: declineConsentRef, commitToken: declineCommitToken },
  });
  assert.equal(cachedCommitAfterDecline.isError, false);
  assert.equal(cachedCommitAfterDecline.structuredContent?.status, "rejected");
  assert.equal(cachedCommitAfterDecline.structuredContent?.terminal, true);
  assert.equal(cachedCommitAfterDecline.structuredContent?.duplicate, true);
  assert.equal(cachedCommitAfterDecline.structuredContent?.agentRef, null);
  assert.equal(cachedCommitAfterDecline.structuredContent?.turnId, null);

  const replayAfterDecline = await client.callTool({
    name: "codex.agent_start",
    arguments: { prompt: declinePrompt, requestId: declineRequestId },
  });
  assert.equal(replayAfterDecline.isError, false);
  assert.equal(replayAfterDecline.structuredContent?.status, "rejected");
  assert.equal(replayAfterDecline.structuredContent?.terminal, true);
  assert.equal(replayAfterDecline.structuredContent?.agentRef, null);
  assert.equal(replayAfterDecline.structuredContent?.turnId, null);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

const stdioRecentCalls = JSON.parse(readFileSync(recentCallStateFile, "utf8"));
assert.equal(stdioRecentCalls.version, 1);
assert.equal(stdioRecentCalls.receipts.some((receipt) => receipt.tool_name === "codex.command_exec" && receipt.status === "returned"), true, "stdio runtime must persist recent-call metadata");
assert.equal(JSON.stringify(stdioRecentCalls).includes("Codexless contract probe: prepare only"), false, "recent-call persistence must not capture tool arguments/prompts");

const httpPort = 17691;
const baseUrl = `http://127.0.0.1:${httpPort}`;
const httpChild = spawn(process.execPath, [path.join(projectRoot, "src", "mcp-http.mjs")], {
  cwd: projectRoot,
  env: createIsolatedPublicTestEnv({
    CODEXLESS_HOST: "127.0.0.1",
    CODEXLESS_PORT: String(httpPort),
  }),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let httpStderr = "";
httpChild.stderr.setEncoding("utf8");
httpChild.stderr.on("data", (chunk) => { httpStderr += chunk; });

async function waitForHttpHealth() {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (httpChild.exitCode !== null) {
      throw new Error(`Codexless HTTP exited early (${httpChild.exitCode}): ${httpStderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Codexless HTTP did not become healthy: ${String(lastError ?? "timeout")}\n${httpStderr}`);
}

async function stopHttpChild() {
  if (httpChild.exitCode !== null) return;
  httpChild.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => httpChild.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (httpChild.exitCode === null) httpChild.kill("SIGKILL");
}

try {
  const health = await waitForHttpHealth();
  assert.equal(health.ok, true);
  assert.equal(health.service, "codexless-public-preview");
  assert.equal(health.surfaceVersion, PUBLIC_SURFACE_VERSION);
  assert.equal(health.toolCount, PUBLIC_TOOL_NAMES.length);
  assert.equal(health.health?.core?.status, "ok");
  assert.equal(health.health?.capabilities?.browserReader?.status, "not_checked", "core HTTP health must not imply Browser Reader is green without a real Browser connectivity probe");
  assert.equal(health.diagnostics?.recentCalls?.persistence?.enabled, true);
  assert.equal(Object.hasOwn(health, "defaultCwd"), false, "public health metadata must not expose local project paths");

  const recentResponse = await fetch(`${baseUrl}/internal/recent-calls?tool_name=codex.command_exec&limit=5`);
  assert.equal(recentResponse.status, 200);
  assert.equal(recentResponse.headers.get("cache-control"), "no-store");
  assert.equal(recentResponse.headers.get("pragma"), "no-cache");
  const recent = await recentResponse.json();
  assert.equal(recent.bounded, true);
  assert.equal(recent.receipts.some((receipt) => receipt.tool_name === "codex.command_exec"), true, "HTTP runtime restart must read the prior stdio durable receipt");
  assert.equal(JSON.stringify(recent).includes("Codexless contract probe: prepare only"), false);

  const invalidLimit = await fetch(`${baseUrl}/internal/recent-calls?limit=101`);
  assert.equal(invalidLimit.status, 400);
  assert.equal(invalidLimit.headers.get("cache-control"), "no-store");

  const rejectedOrigin = await fetch(`${baseUrl}/internal/recent-calls`, { headers: { origin: "https://not-loopback.invalid" } });
  assert.notEqual(rejectedOrigin.status, 200, "internal diagnostics must remain behind the existing loopback Origin filter");

  const httpClient = new Client({ name: "codexless-public-contract-http", version: "0.1.0" });
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  try {
    await httpClient.connect(httpTransport);
    const httpTools = await httpClient.listTools();
    const httpNames = httpTools.tools.map((tool) => tool.name);
    assert.equal(httpNames.length, 39);
    assert.deepEqual([...httpNames].sort(), [...PUBLIC_TOOL_NAMES].sort());
    for (const name of forbiddenNames) {
      assert.equal(httpNames.includes(name), false, `${name} must not be exposed by the public HTTP preview`);
    }
  } finally {
    await httpClient.close().catch(() => {});
  }
} finally {
  await stopHttpChild();
}

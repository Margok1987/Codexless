import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { managedLaunchEnv } from "../src/codex-runtime-provider.mjs";
import { CodexAuthorityExecutor } from "../src/codex-authority-executor.mjs";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";

// Integration tests use the real official binary for every authority RPC.
// The sole interception is BEFORE turn/start: a model turn can never be sent.
const permittedMethods = new Set([
  "config/read", "permissionProfile/list", "thread/start", "thread/delete",
  "thread/resume", "thread/turns/list",
]);

for (const changedPolicy of [false, true]) {
  test(`official account authority ${changedPolicy ? "rejects drift" : "matches identical isolated policy"} without a paid turn`, { timeout: 20_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexless-official-accounts-"));
    let executor = null;
    try {
      const workspace = path.join(root, "workspace");
      const authorityHome = path.join(root, "authority-home");
      const accountHome = path.join(root, "account-home");
      for (const directory of [workspace, authorityHome, accountHome]) await mkdir(directory);
      const baseConfig = `approval_policy = "on-request"\nsandbox_mode = "read-only"\ncli_auth_credentials_store = "file"\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`;
      await writeFile(path.join(authorityHome, "config.toml"), baseConfig);
      await writeFile(path.join(accountHome, "config.toml"), changedPolicy ? baseConfig.replace('"on-request"', '"never"') : baseConfig);
      const resolved = await resolveCodexExecutable({ env: { ...process.env, CODEX_BIN: "" } });
      const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
      assert.equal(resolved.version, pkg.dependencies["@openai/codex"], "test must use the exact pinned official Codex");
      const isolatedEnv = { ...process.env, HOME: root, USERPROFILE: root };
      const authority = new CodexAuthorityExecutor({
        codexBin: resolved.path, profileOverride: ":read-only",
        launchEnv: managedLaunchEnv(isolatedEnv, authorityHome),
      });
      await authority.validate();
      const prepared = await authority.resolveAuthority({ cwd: workspace, access: "readOnly", timeoutMs: 8_000 });
      assert.equal(prepared.permissionProfile, ":read-only");
      assert.match(prepared.policyHash, /^[a-f0-9]{64}$/);
      let interceptedTurns = 0;
      let officialClient;
      const observedMethods = [];
      executor = new CodexAgentExecutor({
        defaultCwd: workspace, requireAuthorityPolicy: true,
        // Authentication is independently tested with deterministic account/read
        // negatives. These fresh homes deliberately contain no credentials.
        requireChatgptAuth: false,
        clientFactory: (options) => {
          officialClient = new CodexAppServerClient({
            ...options, requestTimeoutMs: 8_000, stderrHandler: () => {},
            initializeCapabilities: { experimentalApi: true },
            launch: () => ({ command: resolved.path, args: ["app-server", "--stdio"],
              options: { cwd: workspace, env: managedLaunchEnv(isolatedEnv, accountHome) } }),
          });
          return {
            get running() { return officialClient.running; },
            get initializedResult() { return officialClient.initializedResult; },
            start: () => officialClient.start(), close: () => officialClient.close(),
            onNotification: (handler) => officialClient.onNotification(handler),
            request(method, params, options) {
              if (method === "turn/start") {
                interceptedTurns += 1;
                throw new Error("TEST_BOUNDARY_NO_MODEL_TURN_SENT");
              }
              assert.ok(permittedMethods.has(method), `integration harness prohibits RPC ${method}`);
              observedMethods.push(method);
              return officialClient.request(method, params, options);
            },
          };
        },
      });
      await executor.open();
      const accountPrepared = await executor.prepareAuthority({
        cwd: workspace,
        permissionProfile: ":read-only",
        permissionCeiling: ":read-only",
      });
      assert.match(accountPrepared.policyHash, /^[a-f0-9]{64}$/);
      assert.equal(
        observedMethods.filter((method) => method === "thread/delete").length,
        0,
        "ephemeral account authority preparation must not issue thread/delete"
      );
      const input = { cwd: workspace, task: "This fixture must never reach a model", clientRequestId: "official-policy-fixture",
        permissionProfile: prepared.permissionProfile, permissionCeiling: prepared.permissionCeiling, authorityPolicyHash: prepared.policyHash };
      if (changedPolicy) {
        await assert.rejects(executor.start(input), (error) => error.code === "CODEX_AGENT_AUTHORITY_MISMATCH");
        assert.equal(interceptedTurns, 0);
        assert.ok(observedMethods.includes("thread/delete"));
      } else {
        const snapshot = await executor.start(input);
        assert.equal(interceptedTurns, 1, "matching real policy must reach, but never cross, the no-model boundary");
        assert.match(snapshot.latestError ?? "", /TEST_BOUNDARY_NO_MODEL_TURN_SENT/);
      }
      assert.ok(observedMethods.includes("config/read"));
      assert.ok(observedMethods.includes("permissionProfile/list"));
      assert.equal(officialClient.notificationMethods.some((method) => method.startsWith("turn/") || method === "thread/tokenUsage/updated"), false);
    } finally {
      if (executor) await executor.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

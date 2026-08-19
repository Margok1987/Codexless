import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { browserMcpDisableOverrides, browserMcpIsolationOverride, buildBrowserConfigOverrides } from "../src/public-runtime.mjs";

const nodeReplConfig = {
  command: "C:\\Program Files\\Codex\\node_repl.exe",
  args: [],
  startup_timeout_sec: 120,
  env: {
    "NORMAL_KEY": "value",
    "key.with.dot": "special",
    "space key": "still-safe",
  },
};
const isolated = browserMcpIsolationOverride(nodeReplConfig);
assert.match(isolated, /^mcp_servers=\{/);
assert.match(isolated, /node_repl\s*=\s*\{/);
assert.match(isolated, /"key\.with\.dot"\s*=\s*"special"/);
assert.match(isolated, /"space key"\s*=\s*"still-safe"/);
assert.doesNotMatch(isolated, /slay-the-spire|name\.with\.dot|other-server/);

const configuredMcpServerNames = ["node_repl", "slay-the-spire", "name.with.dot", "other-server", "other-server"];
const disableOverrides = browserMcpDisableOverrides(configuredMcpServerNames, { keep: "node_repl" });
assert.deepEqual(disableOverrides, [
  "mcp_servers.slay-the-spire.enabled=false",
  "mcp_servers.\"name.with.dot\".enabled=false",
  "mcp_servers.other-server.enabled=false",
]);

const userCompatibilityOverride = "mcp_servers.node_repl.env.CODEX_CLI_PATH=\"user-value\"";
const enforcedCompatibilityOverride = "mcp_servers.node_repl.env.CODEX_CLI_PATH=\"resolved-value\"";
const merged = buildBrowserConfigOverrides({
  configOverrides: [userCompatibilityOverride, "features.apps=true"],
  compatibilityOverrides: [enforcedCompatibilityOverride],
  nodeReplConfig,
  configuredMcpServerNames,
  browserAvailable: true,
});
assert.equal(merged[0], userCompatibilityOverride, "user overrides are applied before Browser isolation/compatibility");
assert.match(merged[2], /^mcp_servers=\{/);
assert.deepEqual(merged.slice(3, -1), disableOverrides, "Browser child must explicitly disable every configured non-node_repl MCP server");
assert.equal(merged.at(-1), enforcedCompatibilityOverride, "trusted compatibility override must win over a conflicting user override");

const degraded = buildBrowserConfigOverrides({
  configOverrides: ["features.apps=true"],
  compatibilityOverrides: [enforcedCompatibilityOverride],
  nodeReplConfig,
  configuredMcpServerNames,
  browserAvailable: false,
});
assert.equal(degraded[1], "mcp_servers={  }", "degraded Browser child must start with no MCP transports rather than malformed node_repl state");
assert.deepEqual(degraded.slice(2), [
  "mcp_servers.node_repl.enabled=false",
  "mcp_servers.slay-the-spire.enabled=false",
  "mcp_servers.\"name.with.dot\".enabled=false",
  "mcp_servers.other-server.enabled=false",
], "degraded Browser child must disable every configured MCP server");
assert.equal(degraded.includes(enforcedCompatibilityOverride), false, "compatibility env must not be injected when the Browser transport is unavailable");

const runtimeSource = await readFile(path.resolve(import.meta.dirname, "../src/public-runtime.mjs"), "utf8");
assert.doesNotMatch(runtimeSource, /await\s+browserContext\.start\s*\(/, "Browser child must remain lazy so Browser failure cannot kill core startup");
assert.match(runtimeSource, /new CodexPublicContextExecutor\([\s\S]*defaultCwd:\s*browserRuntimeCwd/);

console.log("Public runtime Browser guardrails PASS");

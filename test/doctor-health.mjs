import assert from "node:assert/strict";
import path from "node:path";
import { CodexBrowserReaderExecutor } from "../src/browser-reader-executor.mjs";
import { buildDoctorHealth, normalizeBrowserReaderHealth } from "../src/doctor-health.mjs";

const cwd = path.resolve("C:\\codexless-doctor-health-fixture");

const disconnectedReader = new CodexBrowserReaderExecutor({
  context: fakeContext({ backends: [] }),
  defaultCwd: cwd,
});
const disconnectedRaw = await disconnectedReader.status({ cwd });
assert.equal(disconnectedRaw.status, "unavailable");
assert.equal(disconnectedRaw.reason, "chrome_not_connected");
const disconnected = normalizeBrowserReaderHealth(disconnectedRaw);
assert.equal(disconnected.status, "unavailable", "Skill + node_repl without a connected Chrome backend must not report green");
assert.equal(disconnected.prerequisites.chromeSkill, "ok");
assert.equal(disconnected.prerequisites.nodeRepl, "ok");
assert.equal(disconnected.backend.status, "disconnected");
assert.equal(disconnected.connection.verified, false);

const connectedReader = new CodexBrowserReaderExecutor({
  context: fakeContext({ backends: [{ name: "Chrome", family: "chrome", type: "extension" }] }),
  defaultCwd: cwd,
});
const connected = normalizeBrowserReaderHealth(await connectedReader.status({ cwd }));
assert.equal(connected.status, "available", "Browser Reader must report green only after real backend connectivity succeeds");
assert.equal(connected.connection.status, "connected");
assert.equal(connected.connection.verified, true);
assert.equal(connected.backend.family, "chrome");
assert.equal(connected.backend.type, "extension");

const missingSkillReader = new CodexBrowserReaderExecutor({
  context: fakeContext({ prerequisite: { status: "unavailable", reason: "chrome_skill_unavailable", chromeSkillPath: null, nodeRepl: false } }),
  defaultCwd: cwd,
});
const missingSkill = normalizeBrowserReaderHealth(await missingSkillReader.status({ cwd }));
assert.equal(missingSkill.status, "unavailable");
assert.equal(missingSkill.prerequisites.chromeSkill, "missing");
assert.equal(missingSkill.connection.status, "unavailable");

const health = buildDoctorHealth({
  checks: [
    { name: "platform", required: true, ok: true },
    { name: "node", required: true, ok: true },
    { name: "codex-app-server", required: true, ok: true },
  ],
  browserReader: disconnected,
  optionalWarnings: [{ kind: "configured-mcp", message: "optional MCP is down" }],
});
assert.equal(health.core.status, "ok", "optional MCP and Browser capability failures must not contaminate core health");
assert.equal(health.capabilities.status, "degraded");
assert.deepEqual(health.capabilities.issues, ["browser-reader"]);
assert.equal(health.optionalDependencies.status, "warning");

const coreError = buildDoctorHealth({
  checks: [{ name: "codex-app-server", required: true, ok: false }],
  browserReader: connected,
});
assert.equal(coreError.core.status, "error");
assert.equal(coreError.capabilities.status, "ok");

console.log("Doctor Browser/core/optional health regression PASS");

function fakeContext({ prerequisite = null, backends = [] } = {}) {
  return {
    generation: 1,
    async browserPrerequisites() {
      return prerequisite ?? {
        status: "ok",
        chromeSkillPath: path.join(cwd, "skills", "chrome", "SKILL.md"),
        nodeRepl: true,
      };
    },
    async nodeReplCall(request) {
      if (request?.arguments?.title !== "Check connected browser backends") throw new Error(`unexpected Browser probe: ${request?.arguments?.title}`);
      return { isError: false, text: JSON.stringify(backends) };
    },
  };
}

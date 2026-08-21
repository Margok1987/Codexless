import assert from "node:assert/strict";
import test from "node:test";
import { CodexPublicContextExecutor } from "../src/public-context-executor.mjs";

function makeClient(calls) {
  return {
    running: false,
    initializedResult: { ok: true },
    async start() { this.running = true; return this.initializedResult; },
    async close() { this.running = false; },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "skills/list") {
        return { data: [{ skills: [{ name: "codexless-browser-repair", description: "repair", path: "C:/skill/SKILL.md", enabled: true }] }] };
      }
      if (method === "fs/readFile") {
        return { dataBase64: Buffer.from("---\nname: codexless-browser-repair\ndescription: repair\n---\n", "utf8").toString("base64") };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

test("public skill_list and skill_read force refresh so a newly installed Skill is immediately visible", async () => {
  const calls = [];
  const context = new CodexPublicContextExecutor({
    codexBin: "codex",
    defaultCwd: process.cwd(),
    configOverrides: [],
    runtimeKind: "public",
    clientFactory: () => makeClient(calls),
    promptInputRunner: async () => ({ status: "unavailable" }),
  });
  try {
    const list = await context.skillList({ query: "codexless-browser-repair" });
    assert.equal(list.skills.length, 1);
    const read = await context.skillRead({ name: "codexless-browser-repair" });
    assert.equal(read.status, "ok");
    const skillCalls = calls.filter((call) => call.method === "skills/list");
    assert.equal(skillCalls.length, 2);
    assert.equal(skillCalls.every((call) => call.params.forceReload === true), true);
  } finally {
    await context.close();
  }
});

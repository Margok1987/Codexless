import assert from "node:assert/strict";
import test from "node:test";
import { listAllMcpServerStatus } from "../src/mcp-status-pagination.mjs";

test("MCP status discovery follows App Server cursors so node_repl after the first 50 servers remains discoverable", async () => {
  const servers = Array.from({ length: 64 }, (_, index) => ({
    name: `fixture_${String(index).padStart(2, "0")}`,
    tools: {},
    authStatus: "unsupported",
  }));
  servers.push({
    name: "node_repl",
    tools: { js: { name: "js", inputSchema: {} } },
    authStatus: "unsupported",
  });
  const calls = [];
  const result = await listAllMcpServerStatus(async (params) => {
    calls.push(structuredClone(params));
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    const data = servers.slice(offset, offset + params.limit);
    const next = offset + data.length;
    return { data, nextCursor: next < servers.length ? String(next) : null };
  });

  assert.equal(result.data.length, 65);
  assert.equal(result.data.at(-1).name, "node_repl");
  assert.equal(result.data.at(-1).tools.js.name, "js");
  assert.deepEqual(calls, [
    { detail: "toolsAndAuthOnly", limit: 50 },
    { detail: "toolsAndAuthOnly", limit: 50, cursor: "50" },
  ]);
});

test("MCP status pagination fails closed on repeated cursors", async () => {
  await assert.rejects(
    () => listAllMcpServerStatus(async () => ({ data: [], nextCursor: "same" })),
    /repeated a pagination cursor/i
  );
});

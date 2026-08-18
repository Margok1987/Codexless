import assert from "node:assert/strict";
import { createRecentCallDiagnostics } from "../src/recent-call-diagnostics.mjs";
import { handleRecentCallHttpRequest } from "../src/recent-call-http.mjs";

let clock = Date.parse("2026-08-18T01:00:00.000Z");
const diagnostics = createRecentCallDiagnostics({ filePath: null, ttlMs: 60_000, maxEntries: 10, queryLimit: 5, now: () => clock });
const first = diagnostics.arrive("test.http");
diagnostics.handlerStarted(first);
diagnostics.returned(first);
clock += 5;
const second = diagnostics.arrive("test.other");
diagnostics.handlerStarted(second);

const filtered = invoke("GET", "/internal/recent-calls?tool_name=test.http&limit=1");
assert.equal(filtered.handled, true);
assert.equal(filtered.statusCode, 200);
assert.equal(filtered.headers["cache-control"], "no-store");
assert.equal(filtered.headers.pragma, "no-cache");
assert.equal(filtered.json.count, 1);
assert.equal(filtered.json.receipts[0].tool_name, "test.http");
assert.equal(filtered.json.limit, 1);
assert.equal(filtered.json.bounded, true);

const incomplete = invoke("GET", "/internal/recent-calls?status=handler_started");
assert.equal(incomplete.statusCode, 200);
assert.equal(incomplete.json.count, 1);
assert.equal(incomplete.json.receipts[0].receipt_id, second);
assert.equal(incomplete.json.receipts[0].result_returned_at, null);

for (const target of [
  "/internal/recent-calls?limit=101",
  "/internal/recent-calls?since=not-a-date",
  "/internal/recent-calls?unknown=1",
]) {
  const invalid = invoke("GET", target);
  assert.equal(invalid.statusCode, 400, target);
  assert.equal(invalid.headers["cache-control"], "no-store");
  assert.equal(invalid.json.error, "invalid_query");
}

const post = invoke("POST", "/internal/recent-calls");
assert.equal(post.statusCode, 405);
assert.equal(post.headers.allow, "GET");
assert.equal(post.headers["cache-control"], "no-store");

const otherPath = invoke("GET", "/mcp");
assert.equal(otherPath.handled, false);

console.log("Recent-call HTTP filter/limit/no-cache regression PASS");

function invoke(method, target) {
  const state = { handled: null, statusCode: null, headers: {}, body: "" };
  const req = { method };
  const res = {
    writeHead(statusCode, headers) {
      state.statusCode = statusCode;
      state.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    },
    end(body = "") {
      state.body = String(body);
    },
  };
  state.handled = handleRecentCallHttpRequest({
    req,
    res,
    url: new URL(target, "http://127.0.0.1"),
    diagnostics,
  });
  state.json = state.body ? JSON.parse(state.body) : null;
  return state;
}

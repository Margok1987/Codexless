import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createRecentCallDiagnostics,
  installRecentCallToolInstrumentation,
  RECENT_CALL_STORE_VERSION,
} from "../src/recent-call-diagnostics.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "codexless-recent-call-"));
try {
  const stateFile = path.join(root, "recent-calls.json");
  let clock = Date.parse("2026-08-18T00:00:00.000Z");
  const diagnostics = createRecentCallDiagnostics({
    filePath: stateFile,
    ttlMs: 60_000,
    maxEntries: 10,
    queryLimit: 10,
    now: () => clock,
  });

  const forbidden = "SECRET_TOKEN prompt-message C:\\private\\body.txt https://example.invalid/body?token=SECRET stdout-body stderr-body";
  const success = diagnostics.wrapHandler("test.success", async (args) => ({
    content: [{ type: "text", text: args.payload }],
    structuredContent: { echoed: args.payload },
    isError: false,
  }));
  const toolError = diagnostics.wrapHandler("test.tool-error", async () => ({
    content: [{ type: "text", text: forbidden }],
    structuredContent: { error: forbidden },
    isError: true,
  }));
  const throwing = diagnostics.wrapHandler("test.throw", async () => {
    throw new Error(forbidden);
  });

  await success({ payload: forbidden });
  clock += 10;
  await toolError({ prompt: forbidden });
  clock += 10;
  await assert.rejects(() => throwing({ secret: forbidden }), /SECRET_TOKEN/);

  const rows = diagnostics.query({ limit: 10 }).receipts;
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.tool_name === "test.success")?.result_class, "success");
  assert.equal(rows.find((row) => row.tool_name === "test.tool-error")?.result_class, "tool_error");
  const thrown = rows.find((row) => row.tool_name === "test.throw");
  assert.equal(thrown?.status, "handler_error");
  assert.equal(thrown?.result_returned_at, null, "a thrown handler has terminal error evidence but no returned tool result");
  assert.equal(thrown?.error_stage, "handler");
  assert.equal(thrown?.error_class, "Error");
  assert.equal(Object.keys(thrown).sort().join(","), [
    "arrived_at",
    "duration_ms",
    "error_class",
    "error_stage",
    "handler_started_at",
    "receipt_id",
    "result_class",
    "result_returned_at",
    "status",
    "tool_name",
  ].sort().join(","));

  const persistedText = readFileSync(stateFile, "utf8");
  assert.equal(JSON.parse(persistedText).version, RECENT_CALL_STORE_VERSION);
  for (const token of ["SECRET_TOKEN", "prompt-message", "private\\body.txt", "example.invalid/body", "stdout-body", "stderr-body"]) {
    assert.equal(persistedText.includes(token), false, `durable receipt store must not contain ${token}`);
  }

  const restarted = createRecentCallDiagnostics({ filePath: stateFile, ttlMs: 60_000, maxEntries: 10, queryLimit: 10, now: () => clock });
  assert.equal(restarted.query({ toolName: "test.success" }).receipts[0]?.status, "returned", "terminal receipt must survive restart");

  const incompleteFile = path.join(root, "incomplete.json");
  const incompleteA = createRecentCallDiagnostics({ filePath: incompleteFile, ttlMs: 60_000, maxEntries: 10, now: () => clock });
  const incompleteId = incompleteA.arrive("test.incomplete");
  clock += 5;
  incompleteA.handlerStarted(incompleteId);
  const incompleteB = createRecentCallDiagnostics({ filePath: incompleteFile, ttlMs: 60_000, maxEntries: 10, now: () => clock });
  const incomplete = incompleteB.query({ receiptId: incompleteId }).receipts[0];
  assert.equal(incomplete.status, "handler_started");
  assert.equal(incomplete.result_returned_at, null);
  assert.equal(incomplete.result_class, null);
  assert.equal(incompleteB.query({ receiptId: incompleteId }).incomplete_count, 1, "restart must preserve incomplete evidence without inventing a terminal result");

  const boundedFile = path.join(root, "bounded.json");
  let boundedClock = clock;
  const bounded = createRecentCallDiagnostics({ filePath: boundedFile, ttlMs: 100, maxEntries: 2, queryLimit: 2, now: () => boundedClock });
  for (const name of ["test.one", "test.two", "test.three"]) {
    const id = bounded.arrive(name);
    bounded.handlerStarted(id);
    bounded.returned(id);
    boundedClock += 10;
  }
  assert.deepEqual(bounded.query().receipts.map((row) => row.tool_name), ["test.three", "test.two"], "capacity must retain only newest receipts");
  boundedClock += 200;
  const expired = bounded.query();
  assert.equal(expired.count, 0, "TTL must prune old receipts");
  assert.equal(expired.evidence, "no_server_arrival_found_in_bounded_evidence");
  assert.match(expired.no_match_meaning, /does not prove the Host did not send/i);

  const corruptFile = path.join(root, "corrupt.json");
  const corruptBody = "{ definitely-not-json SECRET_CORRUPT_BODY";
  writeFileSync(corruptFile, corruptBody, "utf8");
  const corrupt = createRecentCallDiagnostics({ filePath: corruptFile, ttlMs: 60_000, maxEntries: 10, now: () => clock });
  assert.equal(corrupt.persistenceHealth().status, "corrupt");
  assert.equal(corrupt.query().evidence, "durable_evidence_unavailable", "corrupt persistence must not masquerade as an ordinary empty bounded window");
  const corruptSuccess = corrupt.wrapHandler("test.after-corrupt", async () => ({ isError: false }));
  await corruptSuccess({ secret: forbidden });
  assert.equal(corrupt.query({ toolName: "test.after-corrupt" }).count, 1, "memory diagnostics must remain usable after corrupt durable state");
  assert.equal(readFileSync(corruptFile, "utf8"), corruptBody, "corrupt durable state must not be overwritten or deleted automatically");

  const unsupportedFile = path.join(root, "unsupported.json");
  const unsupportedBody = JSON.stringify({ version: 999, receipts: [] });
  writeFileSync(unsupportedFile, unsupportedBody, "utf8");
  const unsupported = createRecentCallDiagnostics({ filePath: unsupportedFile, ttlMs: 60_000, maxEntries: 10, now: () => clock });
  assert.equal(unsupported.persistenceHealth().status, "unsupported_schema");
  assert.equal(unsupported.query().evidence, "durable_evidence_unavailable");
  const unsupportedSuccess = unsupported.wrapHandler("test.after-unsupported", async () => ({ isError: false }));
  await unsupportedSuccess();
  assert.equal(readFileSync(unsupportedFile, "utf8"), unsupportedBody, "unsupported schema must remain fail-visible and must not be overwritten");

  const parentAsFile = path.join(root, "not-a-directory");
  writeFileSync(parentAsFile, "block mkdir", "utf8");
  const writeFailed = createRecentCallDiagnostics({ filePath: path.join(parentAsFile, "recent.json"), ttlMs: 60_000, maxEntries: 10, now: () => clock });
  const unaffectedBusiness = writeFailed.wrapHandler("test.write-failure", async () => ({ isError: false, structuredContent: { ok: true } }));
  assert.equal((await unaffectedBusiness()).structuredContent.ok, true, "diagnostic persistence failure must not rewrite business success");
  assert.equal(writeFailed.persistenceHealth().status, "write_failed");
  assert.equal(writeFailed.query({ toolName: "test.never-arrived" }).evidence, "durable_evidence_degraded");

  const fakeServer = {
    handlers: new Map(),
    registerTool(name, _config, handler) {
      this.handlers.set(name, handler);
      return { name };
    },
  };
  const instrumentedFile = path.join(root, "instrumented.json");
  const instrumentedDiagnostics = createRecentCallDiagnostics({ filePath: instrumentedFile, ttlMs: 60_000, maxEntries: 10, now: () => clock });
  installRecentCallToolInstrumentation(fakeServer, instrumentedDiagnostics);
  fakeServer.registerTool("test.registered", {}, async () => ({ isError: false }));
  await fakeServer.handlers.get("test.registered")({ prompt: forbidden });
  assert.equal(instrumentedDiagnostics.query({ toolName: "test.registered" }).receipts[0]?.result_class, "success", "registerTool instrumentation must wrap registered handlers uniformly");

  console.log("Recent-call durable diagnostics regression PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";

const fixtureScript = `
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.argv[1], String(process.pid) + '\\n');
const timer = setInterval(() => {}, 1000);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'exit-now') process.exit(0);
  if (process.argv[2] === 'peer-id' && request.method === 'initialize') { process.stdout.write(JSON.stringify({ id: request.id, method: 'peer/check', params: {} }) + '\\n'); return; }
  if (process.argv[2] === 'peer-id' && request.result) { process.stdout.write(JSON.stringify({ id: request.id, result: { pid: process.pid } }) + '\\n'); return; }
  if (request.method === 'emit-approval') { process.stdout.write(JSON.stringify({ id: 'approval', method: 'peer/approval', params: {} }) + '\\n'); return; }
  if (!request.method) return;
  if (process.argv[2] === 'stall') return;
  if (process.argv[2] === 'invalid') { process.stdout.write('SENTRY_NOT_JSON\\n'); return; }
  if (process.argv[2] === 'null') { process.stdout.write('null\\n'); return; }
  if (process.argv[2] === 'oversize') { process.stdout.write('X'.repeat(1024)); return; }
  if (process.argv[2] === 'missing-result' && request.id !== undefined) { process.stdout.write(JSON.stringify({ id: request.id }) + '\\n'); return; }
  if (process.argv[2] === 'invalid-method' && request.id !== undefined) { process.stdout.write(JSON.stringify({ id: request.id, method: '', result: {} }) + '\\n'); return; }
  if (process.argv[2] === 'invalid-error' && request.id !== undefined) { process.stdout.write(JSON.stringify({ id: request.id, error: {} }) + '\\n'); return; }
  if (process.argv[2] === 'invalid-version' && request.id !== undefined) { process.stdout.write(JSON.stringify({ jsonrpc: '1.0', id: request.id, result: {} }) + '\\n'); return; }
  if (process.argv[2] === 'array-id' && request.id !== undefined) { process.stdout.write(JSON.stringify({ id: [request.id], result: { pid: process.pid } }) + '\\n'); return; }
  if (process.argv[2] === 'init-then-invalid' && request.id !== undefined) { process.stdout.write(JSON.stringify({ id: request.id, result: { pid: process.pid } }) + '\\nSENTRY_NOT_JSON\\n'); return; }
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result: { pid: process.pid } }) + '\\n');
});
`;
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-owned-child-"));
  const pidFile = path.join(root, "owned-pids.txt");
  const spec = { command: process.execPath, args: ["-e", fixtureScript, pidFile], options: { cwd: root } };
  let client;
  try { await run({ root, pidFile, spec, setClient(value) { client = value; } }); }
  finally {
    await client?.close().catch(() => {});
    // Cleanup is confined to exact PIDs emitted by this test's own Node fixture.
    const pids = await readFile(pidFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    for (const pid of pids.trim().split(/\s+/).filter(Boolean).map(Number)) {
      if (alive(pid)) { try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("concurrent official-client initialization creates exactly one owned process", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    const release = gate(); let launches = 0;
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {}, launch: async () => {
      launches += 1; await release.promise; return spec;
    } });
    setClient(client);
    const first = client.start(), second = client.start();
    release.resolve();
    const results = await Promise.all([first, second]);
    await client.close();
    assert.equal(launches, 1);
    assert.equal(results[0].pid, results[1].pid);
  });
});

test("close waits for OS process exit before running state cleanup", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    let pid = null, aliveDuringCleanup = null, cleanups = 0;
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {}, launch: () => ({
      ...spec, cleanup: () => { cleanups += 1; aliveDuringCleanup = alive(pid); },
    }) });
    setClient(client); pid = (await client.start()).pid;
    await client.close();
    assert.equal(aliveDuringCleanup, false, "cleanup must not race a still-running account process");
    assert.equal(alive(pid), false); assert.equal(cleanups, 1);
  });
});

test("close during asynchronous launch prevents any later child creation", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, pidFile, spec, setClient }) => {
    const entered = gate(), release = gate(); let cleanups = 0;
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {}, launch: async () => {
      entered.resolve(); await release.promise; return { ...spec, cleanup: () => { cleanups += 1; } };
    } });
    setClient(client);
    const starting = client.start(), observed = starting.catch(error => error);
    await entered.promise;
    const closing = client.close();
    release.resolve();
    await Promise.allSettled([starting, closing]);
    const result = await observed;
    const pids = await readFile(pidFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    assert.ok(result instanceof Error, "late start must be rejected");
    assert.equal(pids, ""); assert.equal(client.running, false); assert.equal(cleanups, 1);
  });
});

test("all concurrent close callers observe completion rather than an early no-child success", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    const entered = gate(), release = gate(); let cleanupComplete = false;
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {}, launch: () => ({
      ...spec, cleanup: async () => { entered.resolve(); await release.promise; cleanupComplete = true; },
    }) });
    setClient(client); await client.start();
    const first = client.close(); await entered.promise;
    let secondFinished = false;
    const second = client.close().then(() => { secondFinished = true; });
    await new Promise(resolve => setImmediate(resolve));
    const premature = secondFinished; release.resolve();
    await Promise.all([first, second]);
    assert.equal(premature, false); assert.equal(cleanupComplete, true);
  });
});

test("malformed App Server output is rejected without echoing protocol contents", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {},
      launch: () => ({ ...spec, args: [...spec.args, "invalid"] }),
    });
    setClient(client);
    await assert.rejects(client.start(), error => /Invalid.*JSON/i.test(error.message) && !error.message.includes("SENTRY"));
    assert.equal(client.running, false);
  });
});

test("valid JSON with an invalid protocol envelope is rejected and closes the owned process", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {},
      launch: () => ({ ...spec, args: [...spec.args, "null"] }),
    });
    setClient(client);
    await assert.rejects(client.start(), error => /Invalid.*envelope/i.test(error.message) && !error.message.includes("null"));
    assert.equal(client.running, false);
  });
});

test("response envelopes require exactly one result or error field", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {},
      launch: () => ({ ...spec, args: [...spec.args, "missing-result"] }),
    });
    setClient(client);
    await assert.rejects(client.start(), /Invalid.*envelope/i);
    assert.equal(client.running, false);
  });
});

test("array response IDs cannot alias numeric pending request IDs", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {},
      launch: () => ({ ...spec, args: [...spec.args, "array-id"] }),
    });
    setClient(client);
    await assert.rejects(client.start(), /Invalid.*id/i);
    assert.equal(client.running, false);
  });
});

test("malformed data after initialize in the same stdout chunk still fails start closed", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {},
      launch: () => ({ ...spec, args: [...spec.args, "init-then-invalid"] }),
    });
    setClient(client);
    await assert.rejects(client.start(), /cancelled|Invalid.*JSON/i);
    assert.equal(client.running, false);
  });
});

test("unterminated App Server frames are bounded and close the owned process", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, maxStdoutBufferBytes: 128, stderrHandler: () => {},
      launch: () => ({ ...spec, args: [...spec.args, "oversize"] }),
    });
    setClient(client);
    await assert.rejects(client.start(), error => /buffer limit/i.test(error.message) && !error.message.includes("XXXX"));
    assert.equal(client.running, false);
  });
});

test("initialization timeout closes its owned process without a recursive-close deadlock", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    let cleanups = 0;
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 200, stderrHandler: () => {},
      launch: () => ({ ...spec, args: [...spec.args, "stall"], cleanup: () => { cleanups += 1; } }),
    });
    setClient(client);
    await assert.rejects(client.start(), /timed out/i);
    assert.equal(client.running, false); assert.equal(cleanups, 1);
  });
});

test("cleanup failure quarantines client and reports once to its owner", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    const reported = [];
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {},
      cleanupFailureHandler: (error) => { reported.push(error?.message ?? String(error)); },
      launch: () => ({ ...spec, cleanup: () => { throw new Error("fixture cleanup failure"); } }),
    });
    setClient(client); await client.start();
    await assert.rejects(client.close(), /fixture cleanup failure/);
    await assert.rejects(client.close(), /fixture cleanup failure/);
    await assert.rejects(client.start(), /cleanup failed|closing/i);
    assert.deepEqual(reported, ["fixture cleanup failure"], "owned cleanup failure must reach the account owner exactly once");
    assert.equal(client.running, false);
  });
});

test("a successfully closed client can explicitly reopen without inheriting the old process", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    let cleanups = 0;
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {},
      launch: () => ({ ...spec, cleanup: () => { cleanups += 1; } }),
    });
    setClient(client);
    const first = await client.start(); await client.close();
    assert.equal(alive(first.pid), false);
    const second = await client.start(); await client.close();
    assert.equal(alive(second.pid), false); assert.equal(cleanups, 2);
  });
});

test("close before a queued start prevents invoking the launch factory", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    let launches = 0;
    const client = new CodexAppServerClient({ cwd: root, requestTimeoutMs: 2_000, stderrHandler: () => {},
      launch: () => { launches += 1; return spec; },
    });
    setClient(client);
    const starting = client.start(), observed = starting.catch(error => error);
    await client.close(); assert.ok((await observed) instanceof Error);
    assert.equal(launches, 0); assert.equal(client.running, false);
  });
});

test("unexpected process exit drains owned cleanup and blocks relaunch until it settles", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    const entered = gate(), release = gate(); let launches = 0, cleanups = 0;
    const client = new CodexAppServerClient({ cwd: root, stderrHandler: () => {}, launch: () => {
      launches += 1;
      return { ...spec, cleanup: async () => { cleanups += 1; entered.resolve(); await release.promise; } };
    } });
    setClient(client); await client.start();
    const exited = client.request("exit-now", {}).catch(error => error);
    await exited;
    // Bounded observation: the exit handler must have initiated cleanup itself.
    await new Promise(resolve => setImmediate(resolve));
    const observedCleanups = cleanups;
    try {
      assert.equal(observedCleanups, 1);
      await entered.promise;
      await assert.rejects(client.start(), /closing|cleanup/i);
      assert.equal(launches, 1);
    } finally { release.resolve(); await client.close(); }
    await client.start(); await client.close();
    assert.equal(cleanups, 2);
  });
});

test("synchronous spawn failure still owns and reports failed launch-state cleanup", async () => {
  let cleanups = 0, reports = 0;
  const client = new CodexAppServerClient({ cwd: process.cwd(), stderrHandler: () => {},
    cleanupFailureHandler: () => { reports += 1; },
    launch: () => ({ command: process.execPath, args: ["\u0000"], cleanup: () => { cleanups += 1; throw new Error("fixture cleanup failure"); } }),
  });
  await assert.rejects(client.start());
  assert.equal(cleanups, 1);
  assert.equal(reports, 1);
  await assert.rejects(client.start(), /cleanup failed|closing/i);
  await assert.rejects(client.close(), /fixture cleanup failure/);
});

test("bidirectional request IDs occupy independent namespaces", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    let requests = 0;
    const client = new CodexAppServerClient({ cwd: root, stderrHandler: () => {}, requestTimeoutMs: 2_000,
      launch: () => ({ ...spec, args: [...spec.args, "peer-id"] }),
      serverRequestHandler: handle => { requests += 1; handle.resolve({ accepted: true }); },
    });
    setClient(client);
    const result = await client.start();
    assert.equal(requests, 1); assert.equal(alive(result.pid), true);
  });
});

test("settled server request handles cannot resolve a reused ID or a later process generation", { timeout: 8_000 }, async () => {
  await fixture(async ({ root, spec, setClient }) => {
    let arrived = gate(); const handles = [];
    const client = new CodexAppServerClient({ cwd: root, stderrHandler: () => {}, launch: () => spec,
      serverRequestHandler: handle => { handles.push(handle); arrived.resolve(); },
    });
    setClient(client); await client.start();
    client.notify("emit-approval", {}); await arrived.promise;
    handles[0].resolve({ accepted: false });
    for (const reopen of [false, true]) {
      if (reopen) { await client.close(); await client.start(); }
      arrived = gate(); client.notify("emit-approval", {}); await arrived.promise;
      const current = handles.at(-1);
      assert.throws(() => handles[0].resolve({ accepted: true }), /settled|unknown/i);
      assert.equal(current.settled, false);
      current.reject({ code: -32000, message: "fixture rejection" });
    }
  });
});

for (const mode of ["invalid-method", "invalid-error", "invalid-version"]) {
  test(`invalid RPC fields fail closed: ${mode}`, { timeout: 8_000 }, async () => {
    await fixture(async ({ root, spec, setClient }) => {
      const client = new CodexAppServerClient({ cwd: root, stderrHandler: () => {}, requestTimeoutMs: 2_000,
        launch: () => ({ ...spec, args: [...spec.args, mode] }),
      });
      setClient(client); await assert.rejects(client.start(), /Invalid.*envelope/i);
      assert.equal(client.running, false);
    });
  });
}

import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { BrowserElicitationBridge } from "../src/browser-elicitation-bridge.mjs";
import { registerBrowserPreviewTools } from "../src/browser-tools.mjs";

const require = createRequire(import.meta.url);
const { CLIENT_CAPABILITIES_META_KEY } = require("@modelcontextprotocol/server");
const z = require("zod/v4");

function assertCallerContract(text) {
  assert.match(text, /caller must read and apply the current codex\.browser_confirmation_policy/i);
  assert.match(text, /user-authored task context.*before choosing accept, decline, or cancel/i);
  assert.match(text, /only when that policy\/context permits/i);
  assert.match(text, /requestState is continuation state only, not approval evidence/i);
  assert.match(text, /valid requestState does not authorize accept/i);
}

function originRequest(origin = "https://example.com") {
  return {
    mode: "form",
    message: "Allow Browser access",
    requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      connector_id: "browser-use",
      tool_name: "access_browser_origin",
      persist: "always",
      origin,
    },
  };
}

function genericRequest() {
  return {
    mode: "form",
    message: "Generic prompt",
    requestedSchema: { type: "object", properties: {} },
  };
}

function requestOnce(bridge, request, seen) {
  return new Promise((resolve, reject) => {
    const handle = {
      method: "mcpServer/elicitation/request",
      params: { serverName: "node_repl", request },
      settled: false,
      resolve(value) {
        this.settled = true;
        seen.push(value);
        resolve(value);
      },
      reject(value) {
        this.settled = true;
        reject(new Error(JSON.stringify(value)));
      },
    };
    bridge.handleServerRequest(handle);
  });
}

function taskFor(bridge, request, state) {
  return async () => {
    state.taskRuns += 1;
    const response = await requestOnce(bridge, request, state.responses);
    return { ok: true, response };
  };
}

async function fallbackOriginFlow(action) {
  const bridge = new BrowserElicitationBridge({ continuationTtlMs: 5_000 });
  const state = { taskRuns: 0, responses: [] };
  const input = { tabRef: "browser_tab_a", cwd: "C:/workspace", maxChars: 1_000 };

  const first = await bridge.run({
    toolName: "codex.browser_read",
    input,
    task: taskFor(bridge, originRequest(), state),
  });

  assert.equal(first.isError, false);
  assert.equal(first.structuredContent.status, "permission_required");
  assert.equal(first.structuredContent.operationCompleted, false);
  assert.equal(first.structuredContent.permission.kind, "browser_origin_permission");
  assert.equal(first.structuredContent.permission.origin, "https://example.com");
  assert.equal(first.structuredContent.permission.persistence, "always");
  assert.equal(first.structuredContent.permission.acceptSupported, true);
  assert.equal(first.structuredContent.permission.decision, "dynamic_policy_required");
  assertCallerContract(first.structuredContent.callerObligation);
  assert.deepEqual(JSON.parse(first.content[0].text), first.structuredContent);
  assert.deepEqual(state.responses, [], "issuing a valid continuation must not decide permission");

  const token = first.structuredContent.continuation.requestState;
  assert.equal(typeof token, "string");

  let continuationTaskRan = false;
  const second = await bridge.run({
    toolName: "codex.browser_read",
    input,
    task: async () => {
      continuationTaskRan = true;
      return { bad: true };
    },
    fallbackContinuation: {
      requestState: token,
      response: { action },
    },
  });

  const expected = action === "accept"
    ? { action: "accept", content: { persist: "always" } }
    : { action };
  assert.deepEqual(second, { ok: true, response: expected });
  assert.equal(state.taskRuns, 1);
  assert.equal(continuationTaskRan, false);
  assert.deepEqual(state.responses, [expected], `${action} must reach the exact pending request without caller metadata`);
  // In particular, decline must not widen persistent denial, and cancel is
  // non-decision cleanup with no content or persistence attached.

  await assert.rejects(
    bridge.run({
      toolName: "codex.browser_read",
      input,
      task: async () => ({ bad: true }),
      fallbackContinuation: {
        requestState: token,
        response: { action: "accept" },
      },
    }),
    /expired|already consumed/i
  );

  bridge.close();
}

async function tamperAndForge() {
  const bridge = new BrowserElicitationBridge({ continuationTtlMs: 5_000 });
  const state = { taskRuns: 0, responses: [] };
  const input = { tabRef: "browser_tab_b", cwd: "C:/workspace", maxChars: 1_000 };
  const first = await bridge.run({
    toolName: "codex.browser_read",
    input,
    task: taskFor(bridge, originRequest(), state),
  });
  const token = first.structuredContent.continuation.requestState;

  await assert.rejects(
    bridge.run({
      toolName: "codex.browser_read",
      input: { ...input, maxChars: 1_001 },
      task: async () => ({ bad: true }),
      fallbackContinuation: {
        requestState: token,
        response: { action: "accept" },
      },
    }),
    /exact tool and input/i
  );

  await assert.rejects(
    bridge.run({
      toolName: "codex.browser_read",
      input,
      task: async () => ({ bad: true }),
      fallbackContinuation: {
        requestState: token + "x",
        response: { action: "accept" },
      },
    }),
    /invalid or expired/i
  );

  const done = await bridge.run({
    toolName: "codex.browser_read",
    input,
    task: async () => ({ bad: true }),
    fallbackContinuation: {
      requestState: token,
      response: { action: "accept" },
    },
  });

  assert.equal(done.ok, true);
  assert.equal(state.taskRuns, 1);
  bridge.close();
}

async function unsupportedFallbackAcceptance() {
  const bridge = new BrowserElicitationBridge({ continuationTtlMs: 5_000 });
  const state = { taskRuns: 0, responses: [] };
  const input = { tabRef: "browser_tab_generic" };
  const first = await bridge.run({
    toolName: "codex.browser_read",
    input,
    task: taskFor(bridge, genericRequest(), state),
  });

  assert.equal(first.structuredContent.permission.acceptSupported, false);
  const token = first.structuredContent.continuation.requestState;

  await assert.rejects(
    bridge.run({
      toolName: "codex.browser_read",
      input,
      task: async () => ({ bad: true }),
      fallbackContinuation: {
        requestState: token,
        response: { action: "accept" },
      },
    }),
    /cannot be accepted/i
  );

  bridge.close();
}

async function capabilityModes() {
  for (const [label, caps, expectNative] of [
    ["modern-form", { elicitation: { form: {} } }, true],
    ["legacy-bare", { elicitation: {} }, true],
    ["url-only", { elicitation: { url: {} } }, false],
    ["missing", {}, false],
  ]) {
    const bridge = new BrowserElicitationBridge({ continuationTtlMs: 5_000 });
    const state = { taskRuns: 0, responses: [] };
    const input = { tabRef: "browser_tab_" + label };
    const mcpReq = {
      envelope: {
        [CLIENT_CAPABILITIES_META_KEY]: caps,
      },
    };

    const first = await bridge.run({
      toolName: "codex.browser_read",
      input,
      mcpReq,
      task: taskFor(bridge, originRequest(), state),
    });

    if (expectNative) {
      assert.equal(first.resultType, "input_required", label);
      assert.ok(first.inputRequests?.browser_elicitation, label);
      const nativeResponse = { action: "accept", content: { persist: "always" } };
      const done = await bridge.run({
        toolName: "codex.browser_read",
        input,
        mcpReq: {
          ...mcpReq,
          requestState: () => first.requestState,
          inputResponses: { browser_elicitation: nativeResponse },
        },
        task: async () => assert.fail("native resume must not rerun the task"),
      });
      assert.deepEqual(done, { ok: true, response: nativeResponse });
      assert.deepEqual(state.responses, [nativeResponse]);
    } else {
      assert.equal(first.structuredContent?.status, "permission_required", label);
    }

    bridge.close();
  }
}

async function schemaAndHandlerBinding() {
  const registered = new Map();
  let captured = null;
  const elicitationBridge = {
    async run(value) {
      captured = value;
      return {
        content: [{ type: "text", text: "{\"status\":\"ok\"}" }],
        structuredContent: { status: "ok" },
      };
    },
  };

  let dispatched = null;
  registerBrowserPreviewTools({
    registerTool(name, definition, handler) {
      registered.set(name, { definition, handler });
    },
  }, { async readTab(input) { dispatched = input; return { status: "ok" }; } }, { elicitationBridge });

  const read = registered.get("codex.browser_read");
  assert.ok(read);

  const continuation = {
    requestState: "signed-state",
    response: { action: "accept" },
  };

  const tabInput = { tabRef: "browser_tab_schema" };
  const actionInput = { actionApprovalRef: "browser_action_schema" };
  // Explicitly pin every registered boundary, including prepare paths which
  // read page DOM and the diagnostic probe which actually submits page work.
  const resumableInputs = {
    read: tabInput,
    discover_elements: tabInput,
    prepare_element_action: { ...tabInput, elementRef: "browser_element_schema", action: "click" },
    element_action: actionInput,
    webmcp_discover: tabInput,
    webmcp_call: { webMcpRef: "browser_webmcp_schema", toolName: "lookup", input: {} },
    screenshot: tabInput,
    close_tab: actionInput,
    bulk_close_tabs: actionInput,
    open_tab: actionInput,
    scroll: tabInput,
    keypress: { ...tabInput, key: "Tab" },
    model_route_probe: tabInput,
    navigate: actionInput,
    prepare_click: { ...tabInput, role: "button", name: "Continue" },
    click: actionInput,
    prepare_download: { ...tabInput, role: "link", name: "Download" },
    download: actionInput,
    prepare_upload: { ...tabInput, role: "button", name: "Upload", filePath: "C:/workspace/example.txt" },
    upload: actionInput,
    prepare_fill: { ...tabInput, role: "textbox", name: "Search", text: "query" },
    fill: actionInput,
  };
  const nonResumableInputs = {
    status: {},
    confirmation_policy: {},
    emergency_reset: {},
    tabs: {},
    prepare_close_tab: tabInput,
    prepare_bulk_close_tabs: { tabRefs: [tabInput.tabRef] },
    prepare_open_tab: { family: "chrome", url: "https://example.com" },
    prepare_navigate: { ...tabInput, url: "https://example.com" },
  };
  assert.deepEqual([...registered.keys()].sort(),
    [...Object.keys(resumableInputs), ...Object.keys(nonResumableInputs)].map(name => `codex.browser_${name}`).sort());
  for (const [name, input] of Object.entries(resumableInputs)) {
    const schema = registered.get(`codex.browser_${name}`).definition.inputSchema;
    const modelSchema = z.toJSONSchema(schema);
    assertCallerContract(modelSchema.properties._browserContinuation.description);
    assert.equal(modelSchema.additionalProperties, false, name);
    assert.equal(schema.safeParse(input).success, true, name);
    for (const action of ["accept", "decline", "cancel"]) {
      assert.equal(schema.safeParse({ ...input, _browserContinuation: { ...continuation, response: { action } } }).success, true, name);
      for (const extra of [{ origin: "https://evil.example" }, { persist: "always" }, { content: {} }, { _meta: {} }]) {
        assert.equal(schema.safeParse({ ...input, _browserContinuation: { ...continuation, response: { action, ...extra } } }).success, false, name);
      }
    }
    assert.equal(schema.safeParse({ ...input, _browserContinuation: { ...continuation, approved: true } }).success, false, name);
  }
  for (const [name, input] of Object.entries(nonResumableInputs)) {
    const schema = registered.get(`codex.browser_${name}`).definition.inputSchema;
    assert.equal(Object.hasOwn(z.toJSONSchema(schema).properties, "_browserContinuation"), false, name);
    assert.equal(schema.safeParse(input).success, true, name);
    assert.equal(schema.safeParse({ ...input, _browserContinuation: continuation }).success, false, name);
  }

  assert.equal(
    read.definition.inputSchema.safeParse({
      tabRef: "browser_tab_schema",
      maxChars: 1_000,
    }).success,
    true
  );
  assert.equal(
    read.definition.inputSchema.safeParse({
      tabRef: "browser_tab_schema",
      maxChars: 1_000,
      _browserContinuation: continuation,
    }).success,
    true
  );
  assert.equal(
    read.definition.inputSchema.safeParse({
      tabRef: "browser_tab_schema",
      randomExtra: true,
    }).success,
    false
  );
  assert.equal(
    read.definition.inputSchema.safeParse({
      tabRef: "browser_tab_schema",
      _browserContinuation: {
        requestState: "signed-state",
        response: { action: "accept", extra: true },
      },
    }).success,
    false
  );

  const mcpReq = { envelope: {} };
  const result = await read.handler({
    tabRef: "browser_tab_schema",
    maxChars: 1_000,
    _browserContinuation: continuation,
  }, { mcpReq });

  assert.equal(result.structuredContent.status, "ok");
  assert.deepEqual(captured.input, {
    tabRef: "browser_tab_schema",
    maxChars: 1_000,
  });
  assert.deepEqual(captured.fallbackContinuation, continuation);
  assert.equal(captured.mcpReq, mcpReq);
  await captured.task();
  assert.deepEqual(dispatched, captured.input, "reserved state must not reach the Browser executor");
}

async function policyWhilePermissionPending() {
  const bridge = new BrowserElicitationBridge({ continuationTtlMs: 5_000 });
  const registered = new Map();
  const state = { taskRuns: 0, responses: [] };
  let policyReads = 0;
  registerBrowserPreviewTools({
    registerTool(name, definition, handler) { registered.set(name, handler); },
  }, {
    readTab: taskFor(bridge, originRequest(), state),
    async confirmationPolicy() { policyReads++; return { status: "ok", codexPolicy: "Current policy" }; },
  }, { elicitationBridge: bridge });
  const read = registered.get("codex.browser_read");
  const input = { tabRef: "browser_tab_pending" };
  const first = await read(input, {});
  assert.equal(first.structuredContent.permission.decision, "dynamic_policy_required");
  assert.equal(policyReads, 0, "the bridge must not apply or fetch policy on the caller's behalf");
  const policy = await registered.get("codex.browser_confirmation_policy")({}, {});
  assert.equal(policy.structuredContent.codexPolicy, "Current policy", "caller must be able to read policy while permission is pending");
  assert.equal(policyReads, 1);
  assert.deepEqual(state.responses, [], "reading policy does not itself approve the operation");
  const result = await read({ ...input, _browserContinuation: {
    requestState: first.structuredContent.continuation.requestState,
    response: { action: "cancel" },
  } }, {});
  assert.equal(result.isError, false);
  assert.deepEqual(state.responses, [{ action: "cancel" }]);
  assert.equal(state.taskRuns, 1);
  bridge.close();
}

async function rejectCallerMetadata() {
  for (const action of ["accept", "decline", "cancel"]) {
    for (const extra of [{ origin: "https://evil.example" }, { persist: "always" }, { content: { persist: "always" } }, { _meta: {} }]) {
      const bridge = new BrowserElicitationBridge({ continuationTtlMs: 5_000 });
      const state = { taskRuns: 0, responses: [] };
      const input = { tabRef: "browser_tab_metadata" };
      const first = await bridge.run({ toolName: "codex.browser_read", input, task: taskFor(bridge, originRequest(), state) });
      await assert.rejects(bridge.run({
        toolName: "codex.browser_read", input,
        task: async () => assert.fail("must not restart"),
        fallbackContinuation: { requestState: first.structuredContent.continuation.requestState, response: { action, ...extra } },
      }), /accepts only an action/);
      assert.deepEqual(state.responses, [{ action: "cancel" }], "invalid decisions may only clean up, never persist");
      bridge.close();
    }
  }
}

for (const action of ["accept", "decline", "cancel"]) await fallbackOriginFlow(action);
await tamperAndForge();
await unsupportedFallbackAcceptance();
await capabilityModes();
await schemaAndHandlerBinding();
await policyWhilePermissionPending();
await rejectCallerMetadata();

console.log("BROWSER_ELICITATION_FALLBACK_OK");

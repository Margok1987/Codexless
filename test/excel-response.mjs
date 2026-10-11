import test from "node:test";
import assert from "node:assert/strict";
import { ExcelDocumentAdapter, registerExcelTools } from "../src/excel-tools.mjs";

const readTools = ["read_sheets_metadata", "read_ranges", "search_workbook"];
const toolNames = [...readTools, "write_range", "format_range"];
const data = (result) => ({ isError: false, data: result });
const cells = (values = [[1]], formulas = []) => data({ result: [{ range: "A1", values, formulas }] });
const readArgs = (tool) => tool === "read_sheets_metadata" ? {} : tool === "search_workbook" ? { query: "needle" } : { sheetId: "S1", ranges: ["A1"], cellLimit: 10 };

function fixture({ read = cells(), mutation = data({ ok: true }), discovery = null, schema = null } = {}) {
  const calls = [];
  const session = { executor_session_id: "disposable-fixture", document_title: "Disposable QA.xlsx", surface: "excel", status: "connected", supported_tools: toolNames.map((name) => ({ name, version: "1" })) };
  const workbench = {
    async mcpCall(request) {
      calls.push(structuredClone(request));
      if (request.tool.endsWith("list_document_sessions")) return discovery ?? data({ executors: [session] });
      if (request.tool.endsWith("get_document_tool_schemas")) return schema ?? data({ tool_schemas: request.arguments.items.map((item) => ({ tool_name: item.tool_name, version: item.version, input_schema: { type: "object" } })) });
      assert.ok(request.tool.endsWith("execute_document_command"));
      const value = ["write_range", "format_range"].includes(request.arguments.tool_name) ? mutation : read;
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
  };
  return { adapter: new ExcelDocumentAdapter({ workbench }), workbench, calls, dispatches: () => calls.filter((call) => call.tool.endsWith("execute_document_command")) };
}

const errors = [
  { isError: true, text: "native failure", data: { result: [] } },
  data({ isError: true, result: [] }),
  data({ ok: false, error: "" }),
  data({ error: "provider failure", result: [] }),
  data({ errorCode: "PROVIDER_FAILED", result: [] }),
  data({ status: "failed", result: [] }),
  data({ structuredContent: { ok: false, result: [] } }),
  data({ ok: false, structuredContent: { result: [] } }),
  data({ result: { isError: true, ranges: [] } }),
];

test("all three reads reject errors at native, document and result envelope layers", async () => {
  for (const tool of readTools) for (const response of errors) {
    const f = fixture({ read: response });
    await assert.rejects(() => f.adapter.executeRead(tool, {}, readArgs(tool)), /EXCEL_READ_FAILED/);
    assert.equal(f.dispatches().length, 1, "an error must not cause a retry");
  }
});

test("public read handlers preserve the MCP error envelope", async () => {
  const f = fixture({ read: errors[0] });
  const handlers = new Map();
  registerExcelTools({ registerTool(name, options, handler) { handlers.set(name, handler); } }, { workbench: f.workbench });
  for (const tool of readTools) {
    const result = await handlers.get(`codex.excel_${tool}`)(readArgs(tool));
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /EXCEL_READ_FAILED/);
  }
});

test("complete, partial, absent and unexpected read results stay distinct", async () => {
  const cases = [
    [data({ result: [] }), "succeeded"],
    [data({ result: "<sheets><sheet>QA</sheet></sheets>" }), "succeeded"],
    [data({ structuredContent: { result: [{ range: "A1", values: [[1]] }] } }), "succeeded"],
    [{ structuredContent: { result: [] } }, "succeeded"],
    [data({ result: [], truncated: true }), "partial"],
    [data({ result: { partial: true, ranges: [] } }), "partial"],
    [{ ...cells(), partial: true }, "partial"],
    [data({ result: [], status: "partial" }), "partial"],
    [null, "unverified"],
    [data(null), "unverified"],
    [data({}), "unverified"],
    [data({ ok: true }), "unverified"],
    [data({ result: null }), "unverified"],
    [data({ result: "" }), "unverified"],
    [data({ result: {} }), "unverified"],
    [data({ result: true }), "unverified"],
  ];
  for (const tool of readTools) for (const [response, expected] of cases) {
    const f = fixture({ read: response });
    const result = await f.adapter.executeRead(tool, {}, readArgs(tool));
    assert.equal(result.status, expected);
    assert.equal(f.dispatches().length, 1);
    if (tool === "search_workbook") assert.equal(f.dispatches()[0].arguments.args.searchTerm, "needle");
  }
});

test("discovery and schema errors fail before workbook dispatch", async () => {
  for (const response of errors.slice(0, 8)) for (const stage of ["discovery", "schema"]) {
    const f = fixture({ [stage]: response });
    await assert.rejects(() => f.adapter.executeRead("read_ranges", {}, readArgs("read_ranges")), /EXCEL_(SESSION_DISCOVERY|SCHEMA_LOOKUP)_FAILED/);
    assert.equal(f.dispatches().length, 0);
  }
});

async function mutate(f, tool = "write_range", requested = { sheetId: "S1", writes: [{ cell: "A1", value: 1 }] }) {
  return f.adapter.executeMutation(tool, { idempotencyKey: "fixture-once-0001" }, requested, { sheetId: "S1", ranges: ["A1"], ...(tool === "format_range" ? { includeStyles: true } : {}) });
}

test("error, partial, missing and thrown readbacks never confirm a write or format", async () => {
  const readbacks = [...errors.slice(0, 8).map((error) => ({ ...error, data: { ...error.data, result: [{ range: "A1", values: [[1]], styles: { fontWeight: "bold" } }] } })), data({ result: { isError: true, range: "A1", values: [[1]], styles: { fontWeight: "bold" } } }), data({ result: [{ range: "A1", values: [[1]] }], truncated: true }), data(null), data({}), new Error("transport lost")];
  for (const tool of ["write_range", "format_range"]) for (const read of readbacks) {
    const f = fixture({ read });
    const requested = tool === "write_range" ? { writes: [{ cell: "A1", value: 1 }] } : { range: "A1", cellStyles: { fontWeight: "bold" } };
    const result = await mutate(f, tool, requested);
    assert.equal(result.verificationStatus, "uncertain");
    assert.equal(result.readbackStatus, "unavailable");
    assert.equal(result.replayAllowed, false);
    assert.equal(f.dispatches().filter((call) => call.arguments.tool_name === tool).length, 1);
  }
});

test("an unknown mutation is dispatched once and can only be reconciled by a valid readback", async () => {
  for (const mutation of [...errors, data(null), data({}), new Error("receipt lost")]) {
    const f = fixture({ mutation });
    const result = await mutate(f);
    assert.equal(result.dispatchStatus, "uncertain");
    assert.equal(result.verificationStatus, "applied");
    assert.equal(result.replayAllowed, false);
    assert.equal(f.dispatches().length, 2, "one write followed by one independent read, never a second write");
    assert.equal(f.dispatches()[0].arguments.idempotency_key, "fixture-once-0001");
  }
});

test("values, formulas and explicit null require matching observed cells", async () => {
  const cases = [
    [{ cell: "A1", value: 1 }, cells(), "applied"],
    [{ cell: "A1", value: true }, cells([[true]]), "applied"],
    [{ cell: "A1", value: null }, cells([[null]]), "applied"],
    [{ cell: "A1", value: null }, cells([]), "uncertain"],
    [{ cell: "A1", value: null }, data({ result: '<range><address range="A1"><A1><f></f></A1></address></range>' }), "uncertain"],
    [{ cell: "A1", value: 1 }, cells([[1]], [["=1"]]), "uncertain"],
    [{ cell: "A1", formula: "=1+1" }, cells([[2]], [["=1+1"]]), "applied"],
    [{ cell: "A1", formula: "=1+1" }, cells([[2]]), "uncertain"],
    [{ cell: "A1", value: 2, formula: "=1+1" }, cells([[2]], [["=1+1"]]), "uncertain"],
  ];
  for (const [write, read, expected] of cases) assert.equal((await mutate(fixture({ read }), "write_range", { writes: [write] })).verificationStatus, expected);
  for (const writes of [[{ cell: "A1", value: 1 }, { cell: "A2", value: 2 }], [{ cell: "A1", value: 1 }, { cell: "a1", value: 1 }]]) {
    assert.equal((await mutate(fixture(), "write_range", { writes })).verificationStatus, "uncertain");
  }
});

test("notes, row/column size and inline styles remain unverified even if values match", async () => {
  for (const effect of [{ note: "QA" }, { note: null }, { resizeColumn: { type: "autofit" } }, { resizeRow: { type: "points", value: 20 } }, { cellStyles: { fontWeight: "bold" } }]) {
    assert.equal((await mutate(fixture(), "write_range", { writes: [{ cell: "A1", value: 1, ...effect }] })).verificationStatus, "uncertain");
  }
});

test("format verification requires all scalar styles on the exact range; borders remain unverified", async () => {
  const read = data({ result: [{ range: "A1", styles: { fontWeight: "bold", backgroundColor: "#ffff00" } }] });
  const cases = [
    [{ range: "A1", cellStyles: { fontWeight: "bold" } }, "applied"],
    [{ range: "A1", cellStyles: { fontWeight: "normal" } }, "uncertain"],
    [{ range: "A1", cellStyles: { fontWeight: "bold", numberFormat: "0.00" } }, "uncertain"],
    [{ range: "A1:A2", cellStyles: { fontWeight: "bold" } }, "uncertain"],
    [{ range: "A1", cellStyles: {} }, "uncertain"],
    [{ range: "A1", cellStyles: { fontWeight: "bold", borders: [{ sides: ["left"], style: "solid", weight: "thin" }] } }, "uncertain"],
  ];
  for (const [requested, expected] of cases) assert.equal((await mutate(fixture({ read }), "format_range", requested)).verificationStatus, expected);
});

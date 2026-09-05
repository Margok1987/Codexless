import assert from "node:assert/strict";
import path from "node:path";
import { CodexPublicContextExecutor } from "../src/public-context-executor.mjs";
import {
  PUBLIC_SERVER_INSTRUCTIONS,
  PUBLIC_SKILL_ROUTING_INSTRUCTIONS,
} from "../src/public-server-factory.mjs";
import {
  STOCK_RUNTIME_KIND,
  StockPromptInputSkillRoutingCore,
  parsePromptInputSkillCatalog,
  runStockPromptInputSidecar,
} from "../src/stock-prompt-input-skill-routing.mjs";

const fixtureCwd = path.resolve("test", "fixtures", "stock-prompt-input-project");
const otherCwd = path.resolve("test", "fixtures", "stock-prompt-input-other");
const fakeCodexBin = path.join(fixtureCwd, process.platform === "win32" ? "codex.exe" : "codex");

function rawSkill(name, cwd = fixtureCwd) {
  return {
    name,
    description: `${name} explicit description`,
    path: path.join(cwd, "skills", name.replaceAll(":", "_"), "SKILL.md"),
    enabled: true,
  };
}

function renderedSkill(name, cwd = fixtureCwd) {
  const locator = path.join(cwd, "skills", name.replaceAll(":", "_"), "SKILL.md").replaceAll("\\", "/");
  return `- ${name}: ${name} rendered description (file: ${locator})`;
}

function promptJson(lines, { developer = true, tagged = true, changed = false } = {}) {
  const text = tagged
    ? [
        "<skills_instructions>",
        "## Skills",
        "A skill is a set of instructions provided through a SKILL.md source.",
        "### Available skills",
        ...lines,
        "</skills_instructions>",
      ].join("\n")
    : "<other_instructions>none</other_instructions>";
  const out = [];
  if (developer) {
    out.push({
      type: "message",
      role: "developer",
      content: [{ type: changed ? "output_text" : "input_text", text }],
    });
  }
  out.push({ type: "message", role: "user", content: [{ type: "input_text", text: "fixture" }] });
  return JSON.stringify(out);
}

function threadResult(params, overrides = {}) {
  const cwd = path.resolve(params.cwd);
  const base = {
    thread: { id: "thread-new", ephemeral: true, cwd, cliVersion: "fixture-codex", turns: [] },
    model: typeof params.model === "string" ? params.model : "gpt-5.6-sol",
    cwd,
    activePermissionProfile: { id: ":workspace" },
    runtimeWorkspaceRoots: [cwd],
    instructionSources: [path.join(cwd, "AGENTS.md")],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
  };
  return { ...base, ...overrides, thread: { ...base.thread, ...(overrides.thread ?? {}) } };
}

class FakeClient {
  constructor({ calls, skillsByCwd, files, threadFactory }) {
    this.calls = calls;
    this.skillsByCwd = skillsByCwd;
    this.files = files;
    this.threadFactory = threadFactory;
    this.running = false;
    this.initializedResult = null;
  }
  async start() {
    this.running = true;
    this.initializedResult = { fixture: true };
    return this.initializedResult;
  }
  async close() { this.running = false; }
  async request(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === "thread/start") return this.threadFactory(params);
    if (method === "skills/list") {
      const cwd = path.resolve(params.cwds[0]);
      return { data: [{ cwd, skills: structuredClone(this.skillsByCwd.get(cwd) ?? []) }] };
    }
    if (method === "fs/readFile") {
      const text = this.files.get(params.path);
      if (text === undefined) throw new Error(`missing fixture file: ${params.path}`);
      return { dataBase64: Buffer.from(text, "utf8").toString("base64") };
    }
    throw new Error(`unexpected fake method: ${method}`);
  }
}

function fixture({
  skillsByCwd = new Map([[fixtureCwd, [rawSkill("visible-auto"), rawSkill("explicit-only")]]]),
  prompt = promptJson([renderedSkill("visible-auto")]),
  configOverrides = [],
  runtimeKind = STOCK_RUNTIME_KIND,
  runner = null,
  threadFactory = (params) => threadResult(params),
  codexBin = fakeCodexBin,
} = {}) {
  const calls = [];
  const sidecars = [];
  const files = new Map();
  for (const skills of skillsByCwd.values()) {
    for (const skill of skills) files.set(skill.path, `# ${skill.name}\nfixture explicit Skill body`);
  }
  let options = null;
  const context = new CodexPublicContextExecutor({
    codexBin,
    defaultCwd: fixtureCwd,
    configOverrides,
    runtimeKind,
    promptInputRunner: async (spec) => {
      sidecars.push(structuredClone(spec));
      if (runner) return runner(spec);
      return { ok: true, stdout: typeof prompt === "function" ? prompt(spec) : prompt };
    },
    clientFactory: (value) => {
      options = value;
      return new FakeClient({ calls, skillsByCwd, files, threadFactory });
    },
  });
  return { context, calls, sidecars, appServerSpec: () => options.launch() };
}

function unavailable(project, code) {
  const implicit = project.skillRouting.implicit;
  assert.equal(implicit.status, "unavailable");
  assert.equal(implicit.count, 0);
  assert.deepEqual(implicit.skills, []);
  assert.equal(implicit.diagnostics[0].code, code);
}

function facts({ method = "thread/start", params = {}, result = {} } = {}) {
  const request = { cwd: fixtureCwd, ephemeral: true, ...params };
  return { method, params: request, result: threadResult(request, result) };
}

// Happy production consumer: implicit is only rendered prompt-input; explicit remains independent.
{
  const configOverrides = ["features.fixture=true", "fixture.marker=\"redact-me\""];
  const fx = fixture({
    configOverrides,
    prompt: promptJson([renderedSkill("visible-auto"), renderedSkill("chrome:control-chrome")]),
  });
  const project = await fx.context.projectContext({ cwd: fixtureCwd });
  assert.equal(project.cwd, fixtureCwd);
  assert.equal(project.approvalPolicy, "on-request");
  assert.deepEqual(project.skillRouting.implicit.skills.map((skill) => skill.name), ["visible-auto", "chrome:control-chrome"]);
  assert.equal(project.skillRouting.implicit.skills.some((skill) => skill.name === "explicit-only"), false);
  assert.equal(fx.calls.some((call) => call.method === "skills/list"), false);
  assert.equal(fx.calls.some((call) => call.method.startsWith("turn/")), false);

  const appServer = fx.appServerSpec();
  const sidecar = fx.sidecars[0];
  assert.equal(sidecar.command, appServer.command);
  assert.deepEqual(sidecar.args.slice(0, 4), appServer.args.slice(0, 4));
  assert.deepEqual(sidecar.args.slice(4), ["-m", "gpt-5.6-sol", "-C", fixtureCwd, "debug", "prompt-input"]);
  const alignment = project.skillRouting.implicit.alignment;
  assert.equal(alignment.session.method, "thread/start");
  assert.equal(alignment.session.newSession, true);
  assert.equal(alignment.session.threadDynamicConfig, false);
  assert.equal(alignment.cwd.requestMatchesResponse, true);
  assert.equal(alignment.cwd.responseMatchesThread, true);
  assert.equal(alignment.model.requestedModel, null);
  assert.equal(alignment.model.resolvedModel, "gpt-5.6-sol");
  assert.equal(alignment.config.overrideCount, 2);
  assert.equal(JSON.stringify(alignment).includes("redact-me"), false);

  const explicit = await fx.context.skillList({ cwd: fixtureCwd });
  assert.deepEqual(explicit.skills.map((skill) => skill.name), ["visible-auto", "explicit-only"]);
  const read = await fx.context.skillRead({ cwd: fixtureCwd, name: "explicit-only" });
  assert.equal(read.status, "ok");
  assert.match(read.text, /fixture explicit Skill body/);
  await fx.context.close();
}

// PATH changes cannot replace the constructor-resolved executable used by app-server or sidecar.
{
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = path.join(fixtureCwd, "decoy-bin");
    const exact = path.resolve(process.execPath);
    const fx = fixture({ codexBin: exact });
    const project = await fx.context.projectContext({ cwd: fixtureCwd });
    assert.equal(project.skillRouting.implicit.status, "ok");
    assert.equal(fx.appServerSpec().command, exact);
    assert.equal(fx.sidecars[0].command, exact);
    await fx.context.close();
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
}

// Unsupported runtime fails closed in project_context and explicit tools still work.
{
  const fx = fixture({ runtimeKind: "remote", runner: async () => { throw new Error("must not run"); } });
  const project = await fx.context.projectContext({ cwd: fixtureCwd });
  unavailable(project, "IMPLICIT_SKILLS_UNSUPPORTED_RUNTIME");
  assert.equal(project.cwd, fixtureCwd);
  assert.equal(fx.sidecars.length, 0);
  assert.equal((await fx.context.skillList({ cwd: fixtureCwd })).count, 2);
  await fx.context.close();
}

// Single core gates session/thread-config/cwd/model facts before launching prompt-input.
{
  const cases = [
    ["resume", facts({ method: "thread/resume" }), "IMPLICIT_SKILLS_UNSUPPORTED_SESSION"],
    ["non-ephemeral", facts({ result: { thread: { ephemeral: false } } }), "IMPLICIT_SKILLS_UNSUPPORTED_SESSION"],
    ["thread config", facts({ params: { config: { model: "other" } } }), "IMPLICIT_SKILLS_THREAD_CONFIG_UNSUPPORTED"],
    ["response cwd", facts({ result: { cwd: otherCwd, thread: { cwd: otherCwd } } }), "IMPLICIT_SKILLS_CWD_ALIGNMENT_UNPROVEN"],
    ["thread cwd", facts({ result: { thread: { cwd: otherCwd } } }), "IMPLICIT_SKILLS_CWD_ALIGNMENT_UNPROVEN"],
    ["missing model", facts({ result: { model: null } }), "IMPLICIT_SKILLS_MODEL_ALIGNMENT_UNPROVEN"],
    ["model mismatch", facts({ params: { model: "requested" }, result: { model: "resolved" } }), "IMPLICIT_SKILLS_MODEL_ALIGNMENT_UNPROVEN"],
  ];
  for (const [name, input, code] of cases) {
    let runs = 0;
    const core = new StockPromptInputSkillRoutingCore({
      runtimeKind: STOCK_RUNTIME_KIND,
      codexBin: fakeCodexBin,
      appServerCwd: fixtureCwd,
      configOverrides: ["fixture=true"],
      promptInputRunner: async () => { runs += 1; return { ok: true, stdout: promptJson([]) }; },
    });
    const result = await core.readImplicitFromThreadStart(input);
    assert.equal(result.status, "unavailable", name);
    assert.equal(result.diagnostics[0].code, code, name);
    assert.equal(runs, 0, name);
  }
}

// Unsupported prompt-input and parse drift stay local to skillRouting; project_context and explicit tools survive.
{
  const cases = [
    [async () => ({ ok: false, code: "IMPLICIT_SKILLS_DEBUG_UNAVAILABLE", message: "unsupported" }), "IMPLICIT_SKILLS_DEBUG_UNAVAILABLE"],
    [async () => ({ ok: false, code: "IMPLICIT_SKILLS_DEBUG_FAILED", message: "nonzero" }), "IMPLICIT_SKILLS_DEBUG_FAILED"],
    [async () => ({ ok: false, code: "IMPLICIT_SKILLS_DEBUG_TIMEOUT", message: "timeout" }), "IMPLICIT_SKILLS_DEBUG_TIMEOUT"],
    [async () => ({ ok: true, stdout: "{bad" }), "IMPLICIT_SKILLS_PROMPT_JSON_INVALID"],
    [async () => ({ ok: true, stdout: promptJson([renderedSkill("visible-auto")], { developer: false }) }), "IMPLICIT_SKILLS_DEVELOPER_MISSING"],
    [async () => ({ ok: true, stdout: promptJson([renderedSkill("visible-auto")], { tagged: false }) }), "IMPLICIT_SKILLS_TAG_MISMATCH"],
    [async () => ({ ok: true, stdout: promptJson([renderedSkill("visible-auto")], { changed: true }) }), "IMPLICIT_SKILLS_STRUCTURE_MISMATCH"],
  ];
  for (const [runner, code] of cases) {
    const fx = fixture({ runner });
    const project = await fx.context.projectContext({ cwd: fixtureCwd });
    unavailable(project, code);
    assert.equal(project.cliVersion, "fixture-codex");
    assert.equal((await fx.context.skillList({ cwd: fixtureCwd })).count, 2);
    assert.equal((await fx.context.skillRead({ cwd: fixtureCwd, name: "explicit-only" })).status, "ok");
    await fx.context.close();
  }
}

// The production runner classifies representative local child-process failures without exposing stderr.
{
  const missing = await runStockPromptInputSidecar({
    command: path.join(fixtureCwd, "missing-codex-binary"), args: [], cwd: process.cwd(),
  }, { timeoutMs: 200 });
  assert.equal(missing.code, "IMPLICIT_SKILLS_EXECUTABLE_UNAVAILABLE");
  const nonzero = await runStockPromptInputSidecar({
    command: process.execPath, args: ["-e", "process.exit(7)"], cwd: process.cwd(),
  }, { timeoutMs: 2_000 });
  assert.equal(nonzero.code, "IMPLICIT_SKILLS_DEBUG_FAILED");
  assert.equal(Object.hasOwn(nonzero, "stderr"), false);
  const timeout = await runStockPromptInputSidecar({
    command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], cwd: process.cwd(),
  }, { timeoutMs: 30 });
  assert.equal(timeout.code, "IMPLICIT_SKILLS_DEBUG_TIMEOUT");
}

// Large explicit catalog does not backfill stock-rendered omissions.
{
  const explicitSkills = Array.from({ length: 120 }, (_, i) => rawSkill(`skill-${String(i + 1).padStart(3, "0")}`));
  const fx = fixture({
    skillsByCwd: new Map([[fixtureCwd, explicitSkills]]),
    prompt: promptJson(explicitSkills.slice(0, 105).map((skill) => renderedSkill(skill.name))),
  });
  const project = await fx.context.projectContext({ cwd: fixtureCwd });
  assert.equal(project.skillRouting.implicit.count, 105);
  assert.equal(project.skillRouting.implicit.skills.some((skill) => skill.name === "skill-106"), false);
  assert.equal((await fx.context.skillList({ cwd: fixtureCwd })).count, 120);
  await fx.context.close();
}

// cwd/config changes are recomputed, never served from a stale implicit cache.
{
  const skills = new Map([
    [fixtureCwd, [rawSkill("explicit-a", fixtureCwd)]],
    [otherCwd, [rawSkill("explicit-b", otherCwd)]],
  ]);
  const fx = fixture({
    skillsByCwd: skills,
    prompt: (spec) => path.resolve(spec.cwd) === fixtureCwd
      ? promptJson([renderedSkill("implicit-a", fixtureCwd)])
      : promptJson([renderedSkill("implicit-b", otherCwd)]),
  });
  const a = await fx.context.projectContext({ cwd: fixtureCwd });
  const b = await fx.context.projectContext({ cwd: otherCwd });
  assert.deepEqual(a.skillRouting.implicit.skills.map((skill) => skill.name), ["implicit-a"]);
  assert.deepEqual(b.skillRouting.implicit.skills.map((skill) => skill.name), ["implicit-b"]);
  assert.deepEqual(fx.sidecars.map((spec) => path.resolve(spec.cwd)), [fixtureCwd, otherCwd]);
  await fx.context.close();

  const c1 = fixture({ configOverrides: ["fixture.generation=1"] });
  const c2 = fixture({ configOverrides: ["fixture.generation=2"] });
  await c1.context.projectContext({ cwd: fixtureCwd });
  await c2.context.projectContext({ cwd: fixtureCwd });
  assert.deepEqual(c1.sidecars[0].args.slice(0, 2), ["-c", "fixture.generation=1"]);
  assert.deepEqual(c2.sidecars[0].args.slice(0, 2), ["-c", "fixture.generation=2"]);
  await c1.context.close();
  await c2.context.close();
}

// Server habit is short and progressive; it embeds no Skill inventory/count/body.
{
  assert.ok(PUBLIC_SKILL_ROUTING_INSTRUCTIONS.length < 320);
  assert.match(PUBLIC_SKILL_ROUTING_INSTRUCTIONS, /Simple tasks do not require bootstrap/i);
  assert.match(PUBLIC_SKILL_ROUTING_INSTRUCTIONS, /codex\.project_context/);
  assert.match(PUBLIC_SKILL_ROUTING_INSTRUCTIONS, /materially relevant/i);
  assert.match(PUBLIC_SKILL_ROUTING_INSTRUCTIONS, /if stuck/i);
  assert.doesNotMatch(PUBLIC_SKILL_ROUTING_INSTRUCTIONS, /every task|must.*project_context/i);
  assert.doesNotMatch(PUBLIC_SERVER_INSTRUCTIONS, /<skills_instructions>|### Available skills|SKILL\.md|\b21\b|chrome:|skill-\d+/i);
}

// Parser contract exists only in the internal core module and remains strict.
{
  const parsed = parsePromptInputSkillCatalog(promptJson([renderedSkill("alpha"), renderedSkill("chrome:control-chrome")]));
  assert.deepEqual(parsed.map((skill) => skill.name), ["alpha", "chrome:control-chrome"]);
  assert.equal(parsed[0].source.kind, "file");
}

// Codex 0.153.4 adds host root aliases before Available skills and usage instructions after it.
{
  const stock01534 = JSON.stringify([
    {
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: [
          "<skills_instructions>",
          "## Skills",
          "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file.",
          "### Skill roots",
          "- `r0` = `/Users/test/.codex/skills`",
          "Read a skill package directly with `skills.read({\\\"package\\\":\\\"<package>\\\"})` to read its `SKILL.md`; root aliases are resolved automatically. To read another file from that skill, use the same `package` and pass the file's complete `skill://` identifier as `resource`. If the package is not provided, use `skills.list` to find it.",
          "### Available skills",
          "- alpha: Alpha skill (note: description contains a colon). (file: r0/alpha/SKILL.md)",
          "- executor-demo: Executor skill. (executor package: pkg/executor-demo)",
          "- orchestrator-demo: Orchestrator skill. (orchestrator package: pkg/orchestrator-demo)",
          "### How to use skills",
          "- Discovery: The list above is the skills available in this session.",
          "- Safety and fallback: If a skill cannot be applied cleanly, continue with the best fallback.",
          "</skills_instructions>",
        ].join("\n"),
      }],
    },
    { type: "message", role: "user", content: [{ type: "input_text", text: "fixture" }] },
  ]);
  const parsed = parsePromptInputSkillCatalog(stock01534);
  assert.deepEqual(parsed.map((skill) => skill.name), ["alpha", "executor-demo", "orchestrator-demo"]);
  assert.deepEqual(parsed.map((skill) => skill.source.kind), ["file", "executor package", "orchestrator package"]);
}

console.log("stock debug prompt-input production consumer contract PASS");

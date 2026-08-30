import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitSyncInputSchema, gitSyncAuthorized, registerGitSyncTools } from "../src/git-sync-tools.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "codexless-git-sync-contract-"));
const projectRoot = path.join(root, "project");
const nested = path.join(projectRoot, "nested");
const outside = path.join(root, "outside");
await mkdir(nested, { recursive: true });
await mkdir(outside, { recursive: true });
process.once("exit", () => { void rm(root, { recursive: true, force: true }); });

function authorityFor({ trustedAncestor = projectRoot, permissionCeiling = ":workspace" } = {}) {
  return {
    async resolveAuthority({ cwd }) {
      return {
        effectiveCwd: cwd,
        trustedAncestor,
        permissionProfile: permissionCeiling,
        permissionCeiling,
      };
    },
  };
}

function workbenchFor(state) {
  const processes = new Map();
  let next = 0;
  const commands = [];
  return {
    commands,
    async processAction(input) {
      if (input.action === "start") {
        assert.equal(path.isAbsolute(input.command[0]), true, "host Git executable must be absolute");
        assert.equal(input.tty, false);
        commands.push([...input.command]);
        const processRef = `p${++next}`;
        processes.set(processRef, input.command.slice(1));
        return { status: "started", processRef };
      }
      if (input.action === "poll") {
        const args = processes.get(input.processRef);
        assert.ok(args, `unknown process ${input.processRef}`);
        return { status: "exited", exit: responseFor(state, stripFixedConfig(args)) };
      }
      throw new Error(`unexpected process action ${input.action}`);
    },
  };
}

function stripFixedConfig(args) {
  assert.deepEqual(args.slice(0, 4), ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper="]);
  return args.slice(4);
}

function responseFor(state, args) {
  const key = args.join(" ");
  if (key === "rev-parse --show-toplevel") return { exitCode: 0, stdout: state.root, stderr: "" };
  if (key === "remote get-url origin") {
    return state.remote === null
      ? { exitCode: 1, stdout: "", stderr: "missing remote" }
      : { exitCode: 0, stdout: state.remote, stderr: "" };
  }
  if (key === "branch --show-current") return { exitCode: 0, stdout: state.branch, stderr: "" };
  if (key === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
    return state.upstream === null
      ? { exitCode: 1, stdout: "", stderr: "no upstream" }
      : { exitCode: 0, stdout: state.upstream, stderr: "" };
  }
  if (key === "rev-parse HEAD") return { exitCode: 0, stdout: state.head, stderr: "" };
  if (key === "rev-parse origin/main") {
    return state.originMain === null
      ? { exitCode: 1, stdout: "", stderr: "missing ref" }
      : { exitCode: 0, stdout: state.originMain, stderr: "" };
  }
  if (key === "rev-list --left-right --count origin/main...HEAD") {
    return { exitCode: 0, stdout: `${state.behind}\t${state.ahead}`, stderr: "" };
  }
  if (key === "fetch --prune origin") {
    state.originMain = state.fetchOriginMain ?? state.originMain;
    state.ahead = state.fetchAhead ?? state.ahead;
    state.behind = state.fetchBehind ?? state.behind;
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  throw new Error(`unexpected git command: ${key}`);
}

function state(overrides = {}) {
  return {
    root: projectRoot,
    remote: "https://github.com/example/homelab.git",
    branch: "main",
    upstream: "origin/main",
    head: "1111111111111111111111111111111111111111",
    originMain: "1111111111111111111111111111111111111111",
    ahead: 0,
    behind: 0,
    fetchOriginMain: null,
    fetchAhead: null,
    fetchBehind: null,
    ...overrides,
  };
}

async function run(overrides = {}, options = {}) {
  const gitState = state(overrides);
  const workbench = workbenchFor(gitState);
  const result = await gitSyncAuthorized({
    workbench,
    authorityExecutor: options.authorityExecutor ?? authorityFor(),
    cwd: options.cwd ?? projectRoot,
    gitExecutable: process.execPath,
  });
  return { result, workbench };
}

const current = await run();
assert.equal(current.result.status, "freshness_checked");
assert.equal(current.result.postState.head, current.result.preState.head);
assert.equal(current.workbench.commands.some((command) => command.at(-3) === "fetch" && command.at(-2) === "--prune" && command.at(-1) === "origin"), true);

const staleRemote = await run({
  fetchOriginMain: "2222222222222222222222222222222222222222",
  fetchBehind: 1,
});
assert.equal(staleRemote.result.preState.behind, 0);
assert.equal(staleRemote.result.postState.behind, 1);
assert.equal(staleRemote.result.postState.originMain, "2222222222222222222222222222222222222222");
assert.equal(staleRemote.result.postState.head, staleRemote.result.preState.head);

await assert.rejects(
  () => run({}, { cwd: outside }),
  (error) => error.code === "GIT_SYNC_AUTHORITY_BOUNDARY"
);
await assert.rejects(
  () => run({ root: nested }),
  (error) => error.code === "GIT_SYNC_REPOSITORY_ROOT_MISMATCH"
);
await assert.rejects(
  () => run({}, { authorityExecutor: authorityFor({ permissionCeiling: ":read-only" }) }),
  (error) => error.code === "GIT_SYNC_WRITABLE_AUTHORITY_REQUIRED"
);
await assert.rejects(
  () => run({ branch: "feature" }),
  (error) => error.code === "GIT_SYNC_REPOSITORY_CONTRACT"
);
await assert.rejects(
  () => run({ upstream: null }),
  (error) => error.code === "GIT_SYNC_GIT_COMMAND_FAILED"
);
await assert.rejects(
  () => run({ remote: null }),
  (error) => error.code === "GIT_SYNC_GIT_COMMAND_FAILED"
);
await assert.rejects(
  () => run({ remote: "ssh://github.com/example/homelab.git" }),
  (error) => error.code === "GIT_SYNC_REMOTE_UNSUPPORTED"
);
await assert.rejects(
  () => run({ remote: "https://user:secret@github.com/example/homelab.git" }),
  (error) => error.code === "GIT_SYNC_REMOTE_UNSUPPORTED"
);

const schema = createGitSyncInputSchema();
assert.equal(schema.safeParse({ cwd: projectRoot }).success, true);
for (const injection of [
  { cwd: projectRoot, fastForward: true },
  { cwd: projectRoot, command: ["push"] },
  { cwd: projectRoot, remote: "evil" },
  { cwd: projectRoot, ref: "main" },
  { cwd: projectRoot, shell: true },
  { cwd: projectRoot, gitExecutable: "evil.exe" },
]) {
  assert.equal(schema.safeParse(injection).success, false);
}

const registrations = [];
registerGitSyncTools(
  { registerTool: (...args) => registrations.push(args) },
  { workbench: workbenchFor(state()), authorityExecutor: authorityFor() }
);
assert.deepEqual(registrations.map(([name]) => name), ["codex.git_sync"]);

console.log(JSON.stringify({
  ok: true,
  positive: 2,
  negative: 8,
  fetchOnly: true,
  absoluteExecutable: true,
  schemaInjectionRejected: true,
  publicTool: "codex.git_sync",
}));

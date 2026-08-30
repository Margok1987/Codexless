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

function authorityFor(trustedAncestor = projectRoot) {
  return {
    async resolveAuthority({ cwd }) {
      return { effectiveCwd: cwd, trustedAncestor, permissionProfile: ":workspace" };
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
        assert.deepEqual(input.command.slice(0, 1), ["git.exe"]);
        assert.equal(input.tty, false);
        commands.push([...input.command]);
        const processRef = `p${++next}`;
        processes.set(processRef, input.command.slice(1));
        return { status: "started", processRef };
      }
      if (input.action === "poll") {
        const args = processes.get(input.processRef);
        assert.ok(args, `unknown process ${input.processRef}`);
        return { status: "exited", exit: responseFor(state, args) };
      }
      throw new Error(`unexpected process action ${input.action}`);
    },
  };
}

function responseFor(state, args) {
  const key = args.join(" ");
  if (key === "rev-parse --show-toplevel") return { exitCode: 0, stdout: state.root, stderr: "" };
  if (key === "remote get-url origin") return state.remote === null ? { exitCode: 1, stdout: "", stderr: "missing remote" } : { exitCode: 0, stdout: state.remote, stderr: "" };
  if (key === "branch --show-current") return { exitCode: 0, stdout: state.branch, stderr: "" };
  if (key === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return state.upstream === null ? { exitCode: 1, stdout: "", stderr: "no upstream" } : { exitCode: 0, stdout: state.upstream, stderr: "" };
  if (key === "rev-parse HEAD") return { exitCode: 0, stdout: state.head, stderr: "" };
  if (key === "rev-parse origin/main") return state.originMain === null ? { exitCode: 1, stdout: "", stderr: "missing ref" } : { exitCode: 0, stdout: state.originMain, stderr: "" };
  if (key === "status --porcelain=v1 --untracked-files=all") return { exitCode: 0, stdout: state.dirty ? " M tracked.txt\n" : "", stderr: "" };
  if (key === "rev-list --left-right --count origin/main...HEAD") return { exitCode: 0, stdout: `${state.behind}\t${state.ahead}`, stderr: "" };
  if (key === "fetch --prune origin") return { exitCode: 0, stdout: "", stderr: "" };
  if (key === "merge --ff-only origin/main") {
    state.head = state.originMain;
    state.ahead = 0;
    state.behind = 0;
    return { exitCode: 0, stdout: "Fast-forward", stderr: "" };
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
    dirty: false,
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

async function succeeds(overrides, options = {}) {
  const gitState = state(overrides);
  const workbench = workbenchFor(gitState);
  const result = await gitSyncAuthorized({
    workbench,
    authorityExecutor: authorityFor(),
    cwd: options.cwd ?? projectRoot,
    fastForward: options.fastForward ?? false,
  });
  return { result, workbench };
}

await succeeds();
const behind = await succeeds({
  head: "1111111111111111111111111111111111111111",
  originMain: "2222222222222222222222222222222222222222",
  behind: 1,
}, { fastForward: true });
assert.equal(behind.result.status, "fast_forwarded");
assert.equal(behind.result.postState.head, behind.result.postState.originMain);
assert.equal(behind.workbench.commands.some((args) => args.join(" ") === "git.exe merge --ff-only origin/main"), true);

const current = await succeeds({}, { fastForward: true });
assert.equal(current.result.status, "already_current");
assert.equal(current.workbench.commands.some((args) => args.join(" ") === "git.exe merge --ff-only origin/main"), false);

await assert.rejects(
  () => gitSyncAuthorized({ workbench: workbenchFor(state()), authorityExecutor: authorityFor(), cwd: outside }),
  (error) => error.code === "GIT_SYNC_AUTHORITY_BOUNDARY"
);
await assert.rejects(
  () => gitSyncAuthorized({ workbench: workbenchFor(state()), authorityExecutor: authorityFor(), cwd: path.join(projectRoot, "..", "outside") }),
  (error) => error.code === "GIT_SYNC_AUTHORITY_BOUNDARY"
);

for (const overrides of [
  { dirty: true },
  { ahead: 1 },
  { ahead: 1, behind: 1 },
  { branch: "feature" },
  { upstream: null },
  { originMain: null },
]) {
  const workbench = workbenchFor(state(overrides));
  await assert.rejects(
    () => gitSyncAuthorized({ workbench, authorityExecutor: authorityFor(), cwd: projectRoot, fastForward: true }),
    (error) => typeof error.code === "string"
  );
  assert.equal(workbench.commands.some((args) => args.join(" ") === "git.exe merge --ff-only origin/main"), false);
}

const schema = createGitSyncInputSchema();
assert.equal(schema.safeParse({ cwd: projectRoot }).success, true);
assert.equal(schema.safeParse({ cwd: projectRoot, fastForward: true }).success, true);
for (const injection of [
  { cwd: projectRoot, command: ["push"] },
  { cwd: projectRoot, remote: "evil" },
  { cwd: projectRoot, ref: "main" },
  { cwd: projectRoot, shell: true },
]) {
  assert.equal(schema.safeParse(injection).success, false);
}

const registrations = [];
registerGitSyncTools({ registerTool: (...args) => registrations.push(args) }, { workbench: workbenchFor(state()), authorityExecutor: authorityFor() });
assert.deepEqual(registrations.map(([name]) => name), ["codex.git_sync"]);

console.log(JSON.stringify({ ok: true, positive: 3, negative: 8, schemaInjectionRejected: true, publicTool: "codex.git_sync" }));

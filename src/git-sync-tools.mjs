import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

const GIT_EXECUTABLE = "git.exe";
const GIT_TIMEOUT_MS = 30_000;
const GIT_POLL_INTERVAL_MS = 50;
const MAX_DIAGNOSTIC_CHARS = 8_000;

export function createGitSyncInputSchema() {
  return z.object({
    cwd: z.string().min(1).max(32_768),
    fastForward: z.boolean().default(false),
  }).strict();
}

export function registerGitSyncTools(server, { workbench, authorityExecutor }) {
  if (!workbench) throw new Error("codex.git_sync requires the existing Workbench host-process path");
  if (!authorityExecutor) throw new Error("codex.git_sync requires the Codex authority resolver");

  server.registerTool(
    "codex.git_sync",
    {
      title: "Bounded Git Freshness / Fast-Forward",
      description:
        "Run the explicit model-free Git freshness lane for one already authorized project root. The service resolves Codex project authority for cwd, requires a normal main/origin/origin-main repository, then internally runs only git fetch --prune origin and, when fastForward=true and all clean fast-forward preconditions hold, git merge --ff-only origin/main through the existing host-process substrate. Callers cannot provide Git arguments, remotes, refs, force flags, shells, or another root. No commit, push, reset, checkout, rebase, or arbitrary merge is supported.",
      inputSchema: createGitSyncInputSchema(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => gitSyncAuthorized({ workbench, authorityExecutor, ...input }))
  );
}

export async function gitSyncAuthorized({ workbench, authorityExecutor, cwd, fastForward = false }) {
  if (!workbench || typeof workbench.processAction !== "function") {
    throw new Error("codex.git_sync requires the existing Workbench host-process path");
  }
  if (!authorityExecutor || typeof authorityExecutor.resolveAuthority !== "function") {
    throw new Error("codex.git_sync requires the Codex authority resolver");
  }
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("codex.git_sync requires cwd");
  if (typeof fastForward !== "boolean") throw new Error("codex.git_sync fastForward must be boolean");

  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
  const trustedRoot = await canonicalDirectory(authority?.trustedAncestor);
  const effectiveCwd = await canonicalDirectory(authority?.effectiveCwd ?? cwd);
  assertWithinRoot(trustedRoot, effectiveCwd, "cwd");

  const repoRootText = await gitText(workbench, effectiveCwd, ["rev-parse", "--show-toplevel"], "repository-root");
  const repoRoot = await canonicalDirectory(repoRootText);
  if (!samePath(repoRoot, trustedRoot)) {
    throw gitError(
      "GIT_SYNC_REPOSITORY_ROOT_MISMATCH",
      "codex.git_sync requires the Git repository root to equal the trusted Codex project root",
      { trustedRoot, repoRoot }
    );
  }

  const preState = await readGitState(workbench, repoRoot);
  validateRepositoryContract(preState);
  if (fastForward && preState.dirty) {
    throw gitError(
      "GIT_SYNC_DIRTY_WORKTREE",
      "codex.git_sync fastForward=true refuses a dirty working tree before any merge",
      { preState }
    );
  }

  await gitRun(workbench, repoRoot, ["fetch", "--prune", "origin"], "fetch");
  const fetchedState = await readGitState(workbench, repoRoot);

  if (!fastForward) {
    return successPayload({
      status: "freshness_checked",
      fastForward: false,
      repoRoot,
      authority,
      preState,
      postState: fetchedState,
      merge: "not_requested",
    });
  }

  validateRepositoryContract(fetchedState);
  if (fetchedState.dirty) {
    throw gitError(
      "GIT_SYNC_DIRTY_WORKTREE",
      "codex.git_sync fastForward=true refuses to merge a dirty working tree",
      { preState, postState: fetchedState }
    );
  }
  if (fetchedState.ahead > 0) {
    throw gitError(
      "GIT_SYNC_NOT_FAST_FORWARDABLE",
      "codex.git_sync fastForward=true refuses a repository that is ahead or diverged",
      { preState, postState: fetchedState }
    );
  }
  if (fetchedState.behind === 0) {
    if (!samePath(fetchedState.head, fetchedState.originMain)) {
      throw gitError(
        "GIT_SYNC_POSTCONDITION_FAILED",
        "codex.git_sync could not prove that the current repository is aligned with origin/main",
        { preState, postState: fetchedState }
      );
    }
    return successPayload({
      status: "already_current",
      fastForward: true,
      repoRoot,
      authority,
      preState,
      postState: fetchedState,
      merge: "not_needed",
    });
  }

  await gitRun(workbench, repoRoot, ["merge", "--ff-only", "origin/main"], "fast-forward-merge");
  const finalState = await readGitState(workbench, repoRoot);
  validateRepositoryContract(finalState);
  if (finalState.dirty || finalState.ahead !== 0 || finalState.behind !== 0 || !samePath(finalState.head, finalState.originMain)) {
    throw gitError(
      "GIT_SYNC_POSTCONDITION_FAILED",
      "codex.git_sync fast-forward completed without the required clean origin/main postcondition",
      { preState, postState: fetchedState, finalState }
    );
  }

  return successPayload({
    status: "fast_forwarded",
    fastForward: true,
    repoRoot,
    authority,
    preState,
    postState: finalState,
    fetchedState,
    merge: "ff_only",
  });
}

async function readGitState(workbench, repoRoot) {
  const remoteOrigin = redactRemoteUrl(await gitText(workbench, repoRoot, ["remote", "get-url", "origin"], "remote-origin"));
  const branch = await gitText(workbench, repoRoot, ["branch", "--show-current"], "branch");
  const upstream = await gitText(workbench, repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], "upstream");
  const head = await gitText(workbench, repoRoot, ["rev-parse", "HEAD"], "head");
  const originMain = await gitText(workbench, repoRoot, ["rev-parse", "origin/main"], "origin-main");
  const status = await gitText(workbench, repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], "status");
  const counts = await gitText(workbench, repoRoot, ["rev-list", "--left-right", "--count", "origin/main...HEAD"], "ahead-behind");
  const match = counts.match(/^(\d+)\s+(\d+)$/);
  if (!match) throw gitError("GIT_SYNC_STATE_INVALID", "codex.git_sync received an invalid Git ahead/behind state", { operation: "ahead-behind" });

  return {
    remoteOrigin,
    branch,
    upstream,
    head,
    originMain,
    dirty: status.length > 0,
    ahead: Number.parseInt(match[2], 10),
    behind: Number.parseInt(match[1], 10),
  };
}

function validateRepositoryContract(state) {
  if (state.branch !== "main" || state.upstream !== "origin/main" || !state.remoteOrigin) {
    throw gitError(
      "GIT_SYNC_REPOSITORY_CONTRACT",
      "codex.git_sync supports only a main branch with origin and origin/main upstream",
      { branch: state.branch, upstream: state.upstream, hasOrigin: Boolean(state.remoteOrigin) }
    );
  }
}

async function gitText(workbench, cwd, args, operation) {
  const result = await gitRun(workbench, cwd, args, operation);
  return result.stdout.trim();
}

async function gitRun(workbench, cwd, args, operation) {
  const start = await workbench.processAction({
    action: "start",
    command: [GIT_EXECUTABLE, ...args],
    cwd,
    tty: false,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!start?.processRef) throw gitError("GIT_SYNC_HOST_PROCESS_START_FAILED", "codex.git_sync host Git process returned no process reference", { operation });

  const deadline = Date.now() + GIT_TIMEOUT_MS + 5_000;
  let stdout = "";
  let stderr = "";
  while (Date.now() <= deadline) {
    const poll = await workbench.processAction({ action: "poll", processRef: start.processRef });
    stdout = appendBounded(stdout, poll?.stdout);
    stderr = appendBounded(stderr, poll?.stderr);
    if (poll?.status === "exited") {
      const exitCode = poll?.exit?.exitCode ?? null;
      const exitStdout = typeof poll?.exit?.stdout === "string" ? poll.exit.stdout : "";
      const exitStderr = typeof poll?.exit?.stderr === "string" ? poll.exit.stderr : "";
      stdout = appendBounded(stdout, exitStdout);
      stderr = appendBounded(stderr, exitStderr);
      if (exitCode !== 0) {
        throw gitError(
          "GIT_SYNC_GIT_COMMAND_FAILED",
          `codex.git_sync Git ${operation} failed with exit code ${String(exitCode)}`,
          { operation, exitCode, diagnostic: redactDiagnostic(stderr || stdout) }
        );
      }
      return { exitCode: 0, stdout, stderr };
    }
    await delay(GIT_POLL_INTERVAL_MS);
  }

  try {
    await workbench.processAction({ action: "kill", processRef: start.processRef });
  } catch {}
  throw gitError("GIT_SYNC_GIT_COMMAND_TIMEOUT", `codex.git_sync Git ${operation} exceeded its bounded timeout`, { operation });
}

async function canonicalDirectory(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("codex.git_sync requires a trusted project root");
  const resolved = await realpath(value);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`codex.git_sync requires a directory: ${resolved}`);
  return resolved;
}

function assertWithinRoot(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw gitError("GIT_SYNC_AUTHORITY_BOUNDARY", `codex.git_sync refused ${label} outside the trusted Codex project root`, { root, target });
  }
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function successPayload({ status, fastForward, repoRoot, authority, preState, postState, fetchedState = null, merge }) {
  return {
    status,
    fastForward,
    cwd: repoRoot,
    trustedAncestor: authority.trustedAncestor,
    permissionProfile: authority.permissionProfile,
    remoteOrigin: postState.remoteOrigin,
    branch: postState.branch,
    upstream: postState.upstream,
    preState,
    ...(fetchedState ? { fetchedState } : {}),
    postState,
    merge,
  };
}

function gitError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function appendBounded(current, addition) {
  const next = `${current}${typeof addition === "string" ? addition : ""}`;
  return next.length <= MAX_DIAGNOSTIC_CHARS ? next : next.slice(next.length - MAX_DIAGNOSTIC_CHARS);
}

function redactRemoteUrl(value) {
  return String(value ?? "")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/([?&](?:access[_-]?token|api[_-]?key|token|secret|password)=)[^&\s]+/gi, "$1<redacted>");
}

function redactDiagnostic(value) {
  return redactRemoteUrl(value)
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function structured(task) {
  try {
    const payload = await task();
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (error?.details && typeof error.details === "object" && !Array.isArray(error.details)) payload.details = error.details;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}

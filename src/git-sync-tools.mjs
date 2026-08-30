import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

const GIT_TIMEOUT_MS = 30_000;
const GIT_POLL_INTERVAL_MS = 50;
const MAX_DIAGNOSTIC_CHARS = 8_000;
const WRITABLE_PERMISSION_PROFILES = new Set([":workspace", ":danger-full-access"]);

export function createGitSyncInputSchema() {
  return z.object({
    cwd: z.string().min(1).max(32_768),
  }).strict();
}

export function registerGitSyncTools(server, { workbench, authorityExecutor }) {
  if (!workbench) throw new Error("codex.git_sync requires the existing Workbench host-process path");
  if (!authorityExecutor) throw new Error("codex.git_sync requires the Codex authority resolver");

  server.registerTool(
    "codex.git_sync",
    {
      title: "Bounded Git Freshness",
      description:
        "Run one explicit model-free Git freshness check for an already-authorized writable project root. The service resolves Codex project authority for cwd, requires the Git repository root to equal that trusted root, requires main with origin/main and an HTTPS origin, then runs only git fetch --prune origin through the existing host-process substrate. Callers cannot provide an executable, Git arguments, remotes, refs, force flags, shells, or another root. No working-tree, HEAD, branch, commit, push, reset, checkout, rebase, or merge mutation is supported.",
      inputSchema: createGitSyncInputSchema(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => structured(() => gitSyncAuthorized({ workbench, authorityExecutor, ...input }))
  );
}

export async function gitSyncAuthorized({ workbench, authorityExecutor, cwd, gitExecutable = null }) {
  if (!workbench || typeof workbench.processAction !== "function") {
    throw new Error("codex.git_sync requires the existing Workbench host-process path");
  }
  if (!authorityExecutor || typeof authorityExecutor.resolveAuthority !== "function") {
    throw new Error("codex.git_sync requires the Codex authority resolver");
  }
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("codex.git_sync requires cwd");

  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
  const permissionCeiling = authority?.permissionCeiling ?? authority?.permissionProfile ?? null;
  if (!WRITABLE_PERMISSION_PROFILES.has(permissionCeiling)) {
    throw gitError(
      "GIT_SYNC_WRITABLE_AUTHORITY_REQUIRED",
      "codex.git_sync requires an explicitly writable Codex project authority",
      { permissionCeiling }
    );
  }

  const trustedRoot = await canonicalDirectory(authority?.trustedAncestor);
  const effectiveCwd = await canonicalDirectory(authority?.effectiveCwd ?? cwd);
  assertWithinRoot(trustedRoot, effectiveCwd, "cwd");

  const executable = await canonicalExecutable(gitExecutable ?? await resolveHostGitExecutable(trustedRoot));
  if (isWithinRoot(trustedRoot, executable)) {
    throw gitError(
      "GIT_SYNC_EXECUTABLE_BOUNDARY",
      "codex.git_sync refused a Git executable from inside the trusted project root",
      { executable }
    );
  }

  const repoRootText = await gitText(workbench, executable, effectiveCwd, ["rev-parse", "--show-toplevel"], "repository-root");
  const repoRoot = await canonicalDirectory(repoRootText);
  if (!samePath(repoRoot, trustedRoot)) {
    throw gitError(
      "GIT_SYNC_REPOSITORY_ROOT_MISMATCH",
      "codex.git_sync requires the Git repository root to equal the trusted Codex project root",
      { trustedRoot, repoRoot }
    );
  }

  const preState = await readGitState(workbench, executable, repoRoot);
  validateRepositoryContract(preState);

  await gitRun(workbench, executable, repoRoot, ["fetch", "--prune", "origin"], "fetch");
  const postState = await readGitState(workbench, executable, repoRoot);
  validateRepositoryContract(postState);

  if (postState.head !== preState.head) {
    throw gitError(
      "GIT_SYNC_POSTCONDITION_FAILED",
      "codex.git_sync fetch changed HEAD unexpectedly",
      { preHead: preState.head, postHead: postState.head }
    );
  }

  return {
    status: "freshness_checked",
    cwd: repoRoot,
    trustedAncestor: authority.trustedAncestor,
    permissionProfile: authority.permissionProfile,
    permissionCeiling,
    remoteOrigin: postState.remoteOrigin,
    branch: postState.branch,
    upstream: postState.upstream,
    preState,
    postState,
  };
}

async function readGitState(workbench, executable, repoRoot) {
  const remoteOrigin = validateRemoteOrigin(
    await gitText(workbench, executable, repoRoot, ["remote", "get-url", "origin"], "remote-origin")
  );
  const branch = await gitText(workbench, executable, repoRoot, ["branch", "--show-current"], "branch");
  const upstream = await gitText(
    workbench,
    executable,
    repoRoot,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    "upstream"
  );
  const head = await gitText(workbench, executable, repoRoot, ["rev-parse", "HEAD"], "head");
  const originMain = await gitText(workbench, executable, repoRoot, ["rev-parse", "origin/main"], "origin-main");
  const counts = await gitText(
    workbench,
    executable,
    repoRoot,
    ["rev-list", "--left-right", "--count", "origin/main...HEAD"],
    "ahead-behind"
  );
  const match = counts.match(/^(\d+)\s+(\d+)$/);
  if (!match) {
    throw gitError(
      "GIT_SYNC_STATE_INVALID",
      "codex.git_sync received an invalid Git ahead/behind state",
      { operation: "ahead-behind" }
    );
  }

  return {
    remoteOrigin,
    branch,
    upstream,
    head,
    originMain,
    ahead: Number.parseInt(match[2], 10),
    behind: Number.parseInt(match[1], 10),
  };
}

function validateRepositoryContract(state) {
  if (state.branch !== "main" || state.upstream !== "origin/main" || !state.remoteOrigin) {
    throw gitError(
      "GIT_SYNC_REPOSITORY_CONTRACT",
      "codex.git_sync supports only a main branch with HTTPS origin and origin/main upstream",
      { branch: state.branch, upstream: state.upstream, hasOrigin: Boolean(state.remoteOrigin) }
    );
  }
}

async function gitText(workbench, executable, cwd, args, operation) {
  const result = await gitRun(workbench, executable, cwd, args, operation);
  return result.stdout.trim();
}

async function gitRun(workbench, executable, cwd, args, operation) {
  const start = await workbench.processAction({
    action: "start",
    command: [executable, ...args],
    cwd,
    tty: false,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!start?.processRef) {
    throw gitError(
      "GIT_SYNC_HOST_PROCESS_START_FAILED",
      "codex.git_sync host Git process returned no process reference",
      { operation }
    );
  }

  const deadline = Date.now() + GIT_TIMEOUT_MS + 5_000;
  let stdout = "";
  let stderr = "";
  while (Date.now() <= deadline) {
    const poll = await workbench.processAction({ action: "poll", processRef: start.processRef });
    stdout = appendBounded(stdout, poll?.stdout);
    stderr = appendBounded(stderr, poll?.stderr);
    if (poll?.status === "exited") {
      const exitCode = poll?.exit?.exitCode ?? null;
      stdout = appendBounded(stdout, poll?.exit?.stdout);
      stderr = appendBounded(stderr, poll?.exit?.stderr);
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
  throw gitError(
    "GIT_SYNC_GIT_COMMAND_TIMEOUT",
    `codex.git_sync Git ${operation} exceeded its bounded timeout`,
    { operation }
  );
}

async function resolveHostGitExecutable(trustedRoot) {
  const basename = process.platform === "win32" ? "git.exe" : "git";
  for (const rawEntry of String(process.env.PATH ?? "").split(path.delimiter)) {
    const entry = rawEntry.trim().replace(/^"|"$/g, "");
    if (!entry || !path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, basename);
    try {
      const resolved = await canonicalExecutable(candidate);
      if (isWithinRoot(trustedRoot, resolved)) continue;
      if (process.platform !== "win32") await access(resolved, fsConstants.X_OK);
      return resolved;
    } catch {}
  }
  throw gitError(
    "GIT_SYNC_GIT_NOT_FOUND",
    "codex.git_sync could not resolve Git from an absolute host PATH entry outside the project root"
  );
}

async function canonicalDirectory(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("codex.git_sync requires a trusted project root");
  }
  const resolved = await realpath(value);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`codex.git_sync requires a directory: ${resolved}`);
  return resolved;
}

async function canonicalExecutable(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw gitError("GIT_SYNC_GIT_NOT_FOUND", "codex.git_sync requires an absolute host Git executable");
  }
  const resolved = await realpath(value);
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw gitError("GIT_SYNC_GIT_NOT_FOUND", "codex.git_sync resolved Git to a non-file path");
  }
  return resolved;
}

function assertWithinRoot(root, target, label) {
  if (!isWithinRoot(root, target)) {
    throw gitError(
      "GIT_SYNC_AUTHORITY_BOUNDARY",
      `codex.git_sync refused ${label} outside the trusted Codex project root`,
      { root, target }
    );
  }
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left, right) {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function validateRemoteOrigin(value) {
  const text = String(value ?? "").trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw gitError("GIT_SYNC_REMOTE_UNSUPPORTED", "codex.git_sync requires origin to be an HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw gitError(
      "GIT_SYNC_REMOTE_UNSUPPORTED",
      "codex.git_sync requires an HTTPS origin without embedded credentials"
    );
  }
  return parsed.toString();
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

function redactDiagnostic(value) {
  return String(value ?? "")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/([?&](?:access[_-]?token|api[_-]?key|token|secret|password)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function structured(task) {
  try {
    const payload = await task();
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (error?.details && typeof error.details === "object" && !Array.isArray(error.details)) {
      payload.details = error.details;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}

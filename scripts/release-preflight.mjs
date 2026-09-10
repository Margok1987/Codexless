import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  RELEASE_MANIFEST_RELATIVE_PATH,
  buildReleaseManifest,
  readReleaseManifest,
  serializeReleaseManifest,
} from "../src/release-identity.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION } from "../src/surface-contracts.mjs";

export function evaluateReleasePreflight({
  manifestCurrent,
  sourceRevision,
  resolvedSourceRevision,
  head,
  sourceRevisionAncestor = false,
  committedDiffOutsideManifest = [],
  payloadPathsAbsentFromSourceRevision = [],
  statusLines = [],
  strayTracked = [],
  manifestTracked = true,
  qualification = false,
} = {}) {
  const dirtyOutsideManifest = statusLines.filter(Boolean).filter((line) => line.slice(3) !== RELEASE_MANIFEST_RELATIVE_PATH);
  const sourceRevisionIsCommit = typeof sourceRevision === "string"
    && sourceRevision.length > 0
    && resolvedSourceRevision === sourceRevision;
  const sourceRevisionMatchesHead = sourceRevisionIsCommit && sourceRevision === head;
  const sourcePayloadMatchesRevision = sourceRevisionIsCommit
    && payloadPathsAbsentFromSourceRevision.length === 0
    && (
      sourceRevisionMatchesHead
      || (sourceRevisionAncestor && committedDiffOutsideManifest.length === 0)
    );
  const worktreeReady = dirtyOutsideManifest.length === 0;
  const qualificationReady = Boolean(manifestCurrent) && strayTracked.length === 0;
  const releaseReady = qualificationReady
    && manifestTracked
    && sourcePayloadMatchesRevision
    && worktreeReady;
  const blockingReasons = [];
  if (!manifestCurrent) blockingReasons.push("manifest_not_current");
  if (strayTracked.length) blockingReasons.push("stray_tracked_files");
  if (!qualification) {
    if (!manifestTracked) blockingReasons.push("manifest_not_tracked");
    if (!sourceRevisionIsCommit) blockingReasons.push("source_revision_not_exact_commit");
    else {
      if (payloadPathsAbsentFromSourceRevision.length) blockingReasons.push("source_revision_payload_untracked");
      if (!sourcePayloadMatchesRevision && !payloadPathsAbsentFromSourceRevision.length) blockingReasons.push("source_revision_payload_drift");
    }
    if (!worktreeReady) blockingReasons.push("working_tree_dirty_outside_manifest");
  }
  return {
    ok: qualification ? qualificationReady : releaseReady,
    releaseReady,
    sourceRevisionIsCommit,
    sourceRevisionMatchesHead,
    sourceRevisionAncestor,
    sourcePayloadMatchesRevision,
    committedDiffOutsideManifest,
    payloadPathsAbsentFromSourceRevision,
    worktreeReady,
    dirtyOutsideManifest,
    blockingReasons,
  };
}

export function findReleasePayloadPathsAbsentFromRevision({ root, sourceRevision, files } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("release provenance root is required");
  if (typeof sourceRevision !== "string" || !sourceRevision) throw new TypeError("release provenance sourceRevision is required");
  if (!Array.isArray(files)) throw new TypeError("release provenance files must be an array");
  const result = spawnSync("git", ["ls-tree", "-r", "--name-only", "-z", sourceRevision], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  if (result.status !== 0) throw new Error("Could not enumerate the exact release source revision");
  const trackedAtRevision = new Set(result.stdout.split("\0").filter(Boolean).map((entry) => entry.replace(/\\/g, "/")));
  return files
    .map((entry) => typeof entry?.path === "string" ? entry.path.replace(/\\/g, "/") : "")
    .filter(Boolean)
    .filter((releasePath) => !trackedAtRevision.has(releasePath))
    .sort();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readReleaseManifest(root);
  const current = await buildReleaseManifest({
    root,
    serverVersion: PUBLIC_SERVER_VERSION,
    hostContractVersion: PUBLIC_SURFACE_VERSION,
    sourceRevision: manifest.sourceRevision,
  });
  const manifestCurrent = serializeReleaseManifest(current) === serializeReleaseManifest(manifest);
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const status = git(root, ["status", "--short", "--branch"]);
  const statusLines = gitRaw(root, ["status", "--porcelain=v1", "--untracked-files=all"]).split(/\r?\n/).filter(Boolean);
  const branch = git(root, ["branch", "--show-current"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const resolvedSourceRevision = manifest.sourceRevision
    ? gitOptional(root, ["rev-parse", "--verify", `${manifest.sourceRevision}^{commit}`])
    : null;
  const sourceRevisionIsCommit = typeof manifest.sourceRevision === "string"
    && manifest.sourceRevision.length > 0
    && resolvedSourceRevision === manifest.sourceRevision;
  const sourceRevisionAncestor = sourceRevisionIsCommit
    ? gitSuccess(root, ["merge-base", "--is-ancestor", manifest.sourceRevision, head])
    : false;
  const committedDiffOutsideManifest = sourceRevisionAncestor
    ? git(root, ["diff", "--name-only", `${manifest.sourceRevision}..${head}`]).split(/\r?\n/).filter(Boolean).filter((entry) => entry !== RELEASE_MANIFEST_RELATIVE_PATH)
    : [];
  const payloadPathsAbsentFromSourceRevision = sourceRevisionIsCommit
    ? findReleasePayloadPathsAbsentFromRevision({ root, sourceRevision: manifest.sourceRevision, files: manifest.files })
    : [];
  const strayTracked = git(root, ["ls-files", "node_modules", "_work", "NUL", "nul"]).split(/\r?\n/).filter(Boolean);
  const manifestTracked = git(root, ["ls-files", RELEASE_MANIFEST_RELATIVE_PATH]) === RELEASE_MANIFEST_RELATIVE_PATH;
  const evaluation = evaluateReleasePreflight({
    manifestCurrent,
    sourceRevision: manifest.sourceRevision,
    resolvedSourceRevision,
    head,
    sourceRevisionAncestor,
    committedDiffOutsideManifest,
    payloadPathsAbsentFromSourceRevision,
    statusLines,
    strayTracked,
    manifestTracked,
    qualification: args.qualification,
  });
  const receipt = {
    ok: evaluation.ok,
    mode: args.qualification ? "qualification" : "release",
    releaseReady: evaluation.releaseReady,
    version: packageJson.version,
    buildId: manifest.buildId,
    sourceRevision: manifest.sourceRevision,
    manifestCurrent,
    sourceRevisionIsCommit: evaluation.sourceRevisionIsCommit,
    sourceRevisionMatchesHead: evaluation.sourceRevisionMatchesHead,
    sourceRevisionAncestor: evaluation.sourceRevisionAncestor,
    sourcePayloadMatchesRevision: evaluation.sourcePayloadMatchesRevision,
    worktreeReady: evaluation.worktreeReady,
    manifestTracked,
    blockingReasons: evaluation.blockingReasons,
    git: { branch, head, status },
    committedDiffOutsideManifest: evaluation.committedDiffOutsideManifest,
    payloadPathsAbsentFromSourceRevision: evaluation.payloadPathsAbsentFromSourceRevision,
    dirtyOutsideManifest: evaluation.dirtyOutsideManifest,
    strayTracked,
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!receipt.ok) process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = { qualification: false };
  for (const arg of argv) {
    if (arg === "--qualification") parsed.qualification = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: node scripts/release-preflight.mjs [--qualification]\n");
      process.exit(0);
    } else throw new Error(`Unknown release preflight argument: ${arg}`);
  }
  return parsed;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function gitRaw(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.replace(/\r?\n$/, "");
}

function gitOptional(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitSuccess(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseManifest, readReleaseManifest, serializeReleaseManifest } from "../src/release-identity.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION } from "../src/surface-contracts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await readReleaseManifest(root);
const current = await buildReleaseManifest({ root, serverVersion: PUBLIC_SERVER_VERSION, hostContractVersion: PUBLIC_SURFACE_VERSION, sourceRevision: manifest.sourceRevision });
const manifestCurrent = serializeReleaseManifest(current) === serializeReleaseManifest(manifest);
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const status = git(["status", "--short", "--branch"]);
const branch = git(["branch", "--show-current"]);
const head = git(["rev-parse", "HEAD"]);
const strayTracked = git(["ls-files", "node_modules", "_work", "NUL", "nul"]).split(/\r?\n/).filter(Boolean);
const receipt = { ok: manifestCurrent && !strayTracked.length, version: packageJson.version, buildId: manifest.buildId, sourceRevision: manifest.sourceRevision, manifestCurrent, git: { branch, head, status }, strayTracked };
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (!receipt.ok) process.exitCode = 1;

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

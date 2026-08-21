import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { hashReleaseFileBytes, readReleaseManifest, serializeReleaseManifest } from "../src/release-identity.mjs";
import { readDeterministicTarGz, readDeterministicZip, sha256 } from "./release-artifacts-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.resolve(valueAfter("--input") ?? path.join(projectRoot, "_work", "release"));
const manifest = await readReleaseManifest(projectRoot);
const rootName = `codexless-${manifest.version}`;
const names = {
  windows: `${rootName}-windows-x64.zip`, macos: `${rootName}-macos-arm64.tar.gz`,
  manifest: `${rootName}-release-manifest.json`, sums: `${rootName}-SHA256SUMS`, receipt: `${rootName}-artifact-receipt.json`,
};
const files = Object.fromEntries(await Promise.all(Object.values(names).map(async (name) => [name, await readFile(path.join(artifactRoot, name))])));
const sidecarText = files[names.manifest].toString("utf8");
if (sidecarText !== serializeReleaseManifest(manifest)) throw new Error("artifact manifest sidecar does not match the current frozen manifest");
const sums = parseSums(files[names.sums].toString("utf8"));
for (const name of [names.windows, names.macos, names.manifest]) if (sums.get(name) !== sha256(files[name])) throw new Error(`SHA256SUMS mismatch for ${name}`);
const receipt = JSON.parse(files[names.receipt].toString("utf8"));
if (receipt.version !== manifest.version || receipt.buildId !== manifest.buildId) throw new Error("artifact receipt identity does not match current manifest");

for (const [platform, entries] of [["windows-x64", readDeterministicZip(files[names.windows])], ["macos-arm64", readDeterministicTarGz(files[names.macos])]]) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry.bytes]));
  if (byPath.size !== manifest.files.length + 1) throw new Error(`${platform} artifact file count mismatch`);
  for (const expected of manifest.files) {
    const bytes = byPath.get(`${rootName}/${expected.path}`);
    if (!bytes || hashReleaseFileBytes(bytes) !== expected.sha256) throw new Error(`${platform} payload identity mismatch: ${expected.path}`);
  }
  const embedded = byPath.get(`${rootName}/config/release-manifest.json`);
  if (!embedded || embedded.toString("utf8") !== sidecarText) throw new Error(`${platform} embedded manifest mismatch`);
}
process.stdout.write(`${JSON.stringify({ ok: true, version: manifest.version, buildId: manifest.buildId, artifacts: receipt.artifacts }, null, 2)}\n`);

function parseSums(text) {
  const result = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})  ([^/\\]+)$/);
    if (!match || result.has(match[2])) throw new Error("malformed or duplicate SHA256SUMS entry");
    result.set(match[2], match[1]);
  }
  return result;
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  if (!process.argv[index + 1]) throw new Error(`${flag} requires a path`);
  return process.argv[index + 1];
}

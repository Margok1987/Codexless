import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildReleaseManifest, readReleaseManifest, serializeReleaseManifest } from "../src/release-identity.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION } from "../src/surface-contracts.mjs";
import { buildDeterministicTarGz, buildDeterministicZip, sha256 } from "./release-artifacts-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(valueAfter("--output") ?? path.join(projectRoot, "_work", "release"));
const committed = await readReleaseManifest(projectRoot);
const current = await buildReleaseManifest({ root: projectRoot, serverVersion: PUBLIC_SERVER_VERSION, hostContractVersion: PUBLIC_SURFACE_VERSION, sourceRevision: committed.sourceRevision });
if (serializeReleaseManifest(current) !== serializeReleaseManifest(committed)) throw new Error("release manifest is stale; run npm run release:manifest and restart downstream gates");

const rootName = `codexless-${committed.version}`;
const entries = await Promise.all(committed.files.map(async (entry) => ({ path: `${rootName}/${entry.path}`, bytes: await readFile(path.join(projectRoot, ...entry.path.split("/"))) })));
entries.push({ path: `${rootName}/config/release-manifest.json`, bytes: Buffer.from(serializeReleaseManifest(committed), "utf8") });
const names = {
  windows: `${rootName}-windows-x64.zip`,
  macos: `${rootName}-macos-arm64.tar.gz`,
  manifest: `${rootName}-release-manifest.json`,
  sums: `${rootName}-SHA256SUMS`,
  receipt: `${rootName}-artifact-receipt.json`,
};
const payloads = {
  [names.windows]: buildDeterministicZip(entries),
  [names.macos]: buildDeterministicTarGz(entries),
  [names.manifest]: Buffer.from(serializeReleaseManifest(committed), "utf8"),
};
const records = Object.entries(payloads).map(([name, bytes]) => ({ name, sha256: sha256(bytes), bytes: bytes.length }));
payloads[names.sums] = Buffer.from(records.map((record) => `${record.sha256}  ${record.name}`).join("\n") + "\n", "utf8");
const receipt = { schemaVersion: 1, productId: committed.productId, version: committed.version, buildId: committed.buildId, sourceRevision: committed.sourceRevision, artifacts: [...records, { name: names.sums, sha256: sha256(payloads[names.sums]), bytes: payloads[names.sums].length }] };
payloads[names.receipt] = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");

await mkdir(outputRoot, { recursive: true });
for (const [name, bytes] of Object.entries(payloads)) {
  const target = path.join(outputRoot, name);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rm(target, { force: true });
  await rename(temporary, target);
}
process.stdout.write(`${JSON.stringify({ ok: true, output: outputRoot, ...receipt }, null, 2)}\n`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  if (!process.argv[index + 1]) throw new Error(`${flag} requires a path`);
  return process.argv[index + 1];
}

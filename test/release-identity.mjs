import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_MANIFEST_RELATIVE_PATH,
  RELEASE_STATE_COMPATIBILITY,
  RELEASE_TREE_ENTRIES,
  assertReleaseVersionConsistency,
  buildReleaseManifest,
  collectReleaseFiles,
  computeReleaseBuildId,
  hashReleaseFileBytes,
  readReleaseIdentity,
  readReleaseManifest,
  serializeReleaseManifest,
  validateReleaseManifest,
} from "../src/release-identity.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION } from "../src/surface-contracts.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const buildIdForFiles = (files, overrides = {}) => computeReleaseBuildId({
  version: packageJson.version,
  hostContractVersion: PUBLIC_SURFACE_VERSION,
  files,
  ...overrides,
});

assert.equal(
  assertReleaseVersionConsistency({ packageVersion: packageJson.version, serverVersion: PUBLIC_SERVER_VERSION }),
  packageJson.version,
  "package.json.version and PUBLIC_SERVER_VERSION must stay equal"
);
assert.throws(
  () => assertReleaseVersionConsistency({ packageVersion: packageJson.version, serverVersion: "9.9.9-mismatch" }),
  /release version mismatch/,
  "a package/server version mismatch must fail closed"
);

const installerEntries = await readInstallerReleaseEntries();
assert.deepEqual(installerEntries.windows, RELEASE_TREE_ENTRIES, "release identity roots must match the Windows installer staging roots");
assert.deepEqual(installerEntries.mac, RELEASE_TREE_ENTRIES, "release identity roots must match the macOS installer staging roots");

const first = await buildReleaseManifest({
  root: projectRoot,
  serverVersion: PUBLIC_SERVER_VERSION,
  hostContractVersion: PUBLIC_SURFACE_VERSION,
});
const second = await buildReleaseManifest({
  root: projectRoot,
  serverVersion: PUBLIC_SERVER_VERSION,
  hostContractVersion: PUBLIC_SURFACE_VERSION,
});
assert.equal(first.buildId, second.buildId, "the same release tree must produce the same buildId twice");
assert.deepEqual(first.files, second.files, "the same release tree must produce the same ordered file manifest twice");
assert.equal(first.productId, "codexless");
assert.equal(first.version, packageJson.version, "manifest version must be read from package.json");
assert.equal(first.sourceRevision, null, "sourceRevision must remain explicit null when not injected");
assert.equal(first.hostContractVersion, PUBLIC_SURFACE_VERSION, "PUBLIC_SURFACE_VERSION is the host contract authority");
assert.deepEqual(first.stateCompatibility, {
  migration: "none",
  stores: {
    "recent-calls": { schemaVersion: 1 },
    "agent-task-cards": { schemaVersion: 1 },
  },
});
assert.equal(RELEASE_STATE_COMPATIBILITY.migration, "none");
assert.equal(first.files.some((entry) => entry.path === RELEASE_MANIFEST_RELATIVE_PATH), false, "the generated manifest must not hash itself");
assert.equal(first.files.some((entry) => entry.path.startsWith(".git/") || entry.path === ".git"), false, ".git must not enter the release buildId");
assert.equal(first.files.some((entry) => entry.path.includes("node_modules/")), false, "node_modules must not enter the source release buildId");
assert.equal(first.files.some((entry) => entry.path.startsWith("test/") || entry.path.startsWith("docs/") || entry.path.startsWith("_work/")), false, "non-installer review/test/work roots must not enter the buildId");

const committed = await readReleaseManifest(projectRoot);
assert.deepEqual(committed, first, "config/release-manifest.json must match the current installable release tree");
const committedRaw = await readFile(path.join(projectRoot, ...RELEASE_MANIFEST_RELATIVE_PATH.split("/")), "utf8");
assert.equal(committedRaw, serializeReleaseManifest(first), "release manifest generation must be byte-for-byte replayable");

const installedRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-installed-identity-"));
try {
  await mkdir(path.join(installedRoot, "config"), { recursive: true });
  await writeFile(path.join(installedRoot, "config", "release-manifest.json"), serializeReleaseManifest(committed), "utf8");
  const installedIdentity = await readReleaseIdentity(installedRoot);
  assert.deepEqual(installedIdentity, {
    productId: committed.productId,
    version: committed.version,
    buildId: committed.buildId,
    sourceRevision: committed.sourceRevision,
    hostContractVersion: committed.hostContractVersion,
    stateCompatibility: committed.stateCompatibility,
  }, "installed identity must be readable without package.json or .git");
} finally {
  await rm(installedRoot, { recursive: true, force: true });
}

const digestA = hashReleaseFileBytes(Buffer.from("alpha\n", "utf8"));
const digestB = hashReleaseFileBytes(Buffer.from("beta\n", "utf8"));
const orderedBuildId = buildIdForFiles([
  { path: "a.txt", sha256: digestA },
  { path: "b.txt", sha256: digestB },
]);
const reversedBuildId = buildIdForFiles([
  { path: "b.txt", sha256: digestB },
  { path: "a.txt", sha256: digestA },
]);
assert.equal(orderedBuildId, reversedBuildId, "caller file order must not affect buildId");
assert.notEqual(
  orderedBuildId,
  buildIdForFiles([{ path: "a.txt", sha256: digestA }, { path: "b.txt", sha256: digestB }], { version: "0.1.0-preview.metadata-test" }),
  "version metadata must be bound into buildId"
);
assert.notEqual(
  orderedBuildId,
  buildIdForFiles([{ path: "a.txt", sha256: digestA }, { path: "b.txt", sha256: digestB }], { sourceRevision: "different-source" }),
  "sourceRevision metadata must be bound into buildId"
);
assert.notEqual(
  orderedBuildId,
  buildIdForFiles([{ path: "a.txt", sha256: digestA }, { path: "b.txt", sha256: digestB }], { hostContractVersion: `${PUBLIC_SURFACE_VERSION}-different` }),
  "hostContractVersion metadata must be bound into buildId"
);

const lfDigest = hashReleaseFileBytes(Buffer.from("one\ntwo\n", "utf8"));
const crlfDigest = hashReleaseFileBytes(Buffer.from("one\r\ntwo\r\n", "utf8"));
assert.notEqual(lfDigest, crlfDigest, "raw payload byte differences such as LF vs CRLF must change the file hash");

const tempA = await mkdtemp(path.join(os.tmpdir(), "codexless-build-a-"));
const tempB = await mkdtemp(path.join(os.tmpdir(), "codexless-build-b-"));
try {
  await createTinyReleaseTree(tempA, "one\ntwo\n");
  await createTinyReleaseTree(tempB, "one\ntwo\n");
  const filesA1 = await collectReleaseFiles(tempA, { entries: ["payload"] });
  const filesA2 = await collectReleaseFiles(tempA, { entries: ["payload"] });
  const filesB1 = await collectReleaseFiles(tempB, { entries: ["payload"] });
  assert.equal(buildIdForFiles(filesA1), buildIdForFiles(filesA2), "re-reading the same tree must be deterministic");
  assert.equal(buildIdForFiles(filesA1), buildIdForFiles(filesB1), "absolute host root must not affect buildId when payload bytes are identical");

  await writeFile(path.join(tempB, "payload", "value.txt"), "one\r\ntwo\r\n", "utf8");
  const crlfFiles = await collectReleaseFiles(tempB, { entries: ["payload"] });
  assert.notEqual(buildIdForFiles(filesA1), buildIdForFiles(crlfFiles), "LF vs CRLF payload bytes must change buildId");

  await writeFile(path.join(tempB, "payload", "value.txt"), "one\nCHANGED\n", "utf8");
  const changedFiles = await collectReleaseFiles(tempB, { entries: ["payload"] });
  assert.notEqual(buildIdForFiles(filesA1), buildIdForFiles(changedFiles), "release content changes must change buildId");
} finally {
  await rm(tempA, { recursive: true, force: true });
  await rm(tempB, { recursive: true, force: true });
}

const injected = await buildReleaseManifest({
  root: projectRoot,
  serverVersion: PUBLIC_SERVER_VERSION,
  hostContractVersion: PUBLIC_SURFACE_VERSION,
  sourceRevision: "example-source-revision",
});
assert.equal(injected.sourceRevision, "example-source-revision", "sourceRevision must be injectable at generation time");
assert.notEqual(injected.buildId, first.buildId, "sourceRevision provenance must change the exact build identity");

for (const [label, tampered] of [
  ["version", { ...committed, version: `${committed.version}-tampered` }],
  ["sourceRevision", { ...committed, sourceRevision: "tampered-source" }],
  ["hostContractVersion", { ...committed, hostContractVersion: `${committed.hostContractVersion}-tampered` }],
]) {
  assert.throws(
    () => validateReleaseManifest(tampered),
    /buildId does not match its identity metadata and file manifest/,
    `changing manifest ${label} without recomputing buildId must fail validation`
  );
}
assert.throws(
  () => validateReleaseManifest({
    ...committed,
    stateCompatibility: {
      migration: "none",
      stores: {
        "recent-calls": { schemaVersion: 2 },
        "agent-task-cards": { schemaVersion: 1 },
      },
    },
  }),
  /recent-calls state compatibility must be schema v1/,
  "unsupported state compatibility must fail closed"
);

process.stdout.write(`release identity PASS ${first.version} ${first.buildId}\n`);

async function createTinyReleaseTree(root, text) {
  await mkdir(path.join(root, "payload"), { recursive: true });
  await writeFile(path.join(root, "payload", "value.txt"), text, "utf8");
  await writeFile(path.join(root, "npm-shrinkwrap.json"), "{\"lockfileVersion\":3}\n", "utf8");
}

async function readInstallerReleaseEntries() {
  const windowsSource = await readFile(path.join(projectRoot, "scripts", "install.ps1"), "utf8");
  const macSource = await readFile(path.join(projectRoot, "scripts", "install.sh"), "utf8");

  const windowsBlock = windowsSource.match(/\$entries\s*=\s*@\(([\s\S]*?)\)\s*\r?\n\s*foreach\s*\(\$entry/);
  if (!windowsBlock) throw new Error("could not parse Windows installer release entries");
  const windows = [...windowsBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  const macBlock = macSource.match(/for entry in\s+([^;]+);\s*do/);
  if (!macBlock) throw new Error("could not parse macOS installer release entries");
  const mac = macBlock[1].trim().split(/\s+/);
  return { windows, mac };
}

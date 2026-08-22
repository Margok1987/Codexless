import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_GENERATION_FILES,
  materializeInitialBootstrap,
  readBootstrapPointer,
} from "../src/bootstrap-persistence.mjs";
import { buildBootstrapFailureReceipt } from "../src/bootstrap-updater.mjs";
import { releaseAssetContract } from "../src/release-discovery.mjs";
import { buildReleaseManifest, serializeReleaseManifest } from "../src/release-identity.mjs";
import { canonicalInstallDirIdentity, INSTALLER_LOCK_DIRNAME, INSTALLER_LOCK_METADATA_FILENAME, OWNERSHIP_MARKER_PREFIX, validateLifecycleReceipt } from "../src/lifecycle-contract.mjs";

if (process.platform !== "win32") {
  process.stdout.write("bootstrap updater Windows E2E SKIP (not win32)\n");
  process.exit(0);
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const root = await mkdtemp(path.join(os.tmpdir(), "codexless-bootstrap-updater-"));
const fakeTools = path.join(root, "fake-tools");
const stateHome = path.join(root, "home");
const stateRoot = path.join(stateHome, ".config", "codexless");
const realPowerShellHome = readRealPowerShellHome();
const realStateRoot = path.join(realPowerShellHome, ".config", "codexless");
const realActivationLock = path.join(realStateRoot, INSTALLER_LOCK_DIRNAME);
assert.notEqual(path.resolve(stateRoot).toLowerCase(), path.resolve(realStateRoot).toLowerCase(), "fixture state root must be isolated from real PowerShell home");
const realActivationLockBefore = await snapshotActivationLock(realActivationLock);
const tempRoot = path.join(root, "download-temp");
const stagingRoot = path.join(root, "staging-temp");
const secret = "ghp_BOOTSTRAP_SECRET_MUST_NOT_LEAK";
const counters = { artifact: 0, manifest: 0, releases: 0 };
const serverState = {
  version: null,
  artifactBytes: null,
  artifactDigest: null,
  sidecarBytes: null,
  sidecarDigest: null,
};
let origin;
let helperOldRelease = null;
let helperTargetRelease = null;

const server = http.createServer((req, res) => {
  if (req.url === "/releases") {
    counters.releases += 1;
    const naming = releaseAssetContract(serverState.version, "win32", "x64");
    const body = Buffer.from(JSON.stringify([{
      id: 202,
      tag_name: `v${serverState.version}`,
      draft: false,
      prerelease: true,
      published_at: "2026-08-18T00:00:00Z",
      assets: [
        asset(1, naming.artifactName, serverState.artifactBytes.length, `sha256:${serverState.artifactDigest}`, `${origin}/artifact`),
        asset(2, naming.manifestName, serverState.sidecarBytes.length, `sha256:${serverState.sidecarDigest}`, `${origin}/manifest`),
      ],
    }]), "utf8");
    res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length), "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59" });
    res.end(body);
    return;
  }
  if (req.url === "/artifact") {
    counters.artifact += 1;
    sendBytes(res, serverState.artifactBytes);
    return;
  }
  if (req.url === "/manifest") {
    counters.manifest += 1;
    sendBytes(res, serverState.sidecarBytes);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;

try {
  await mkdir(fakeTools, { recursive: true });
  await writeFile(path.join(fakeTools, "npm.cmd"), "@echo off\r\necho added noisy npm fixture output\r\nexit /b 0\r\n", "utf8");
  await mkdir(stateRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });

  const oldRelease = await createFixtureRelease("0.1.0-preview.0", "old-release", "host-v1");
  const targetRelease = await createFixtureRelease("0.2.0-preview.0", "target-release", "host-v2");
  const mismatchRelease = await createFixtureRelease("0.2.0-preview.0", "mismatch-release", "host-mismatch");
  setTarget(targetRelease);

  const freshBootstrap = path.join(root, "fresh-bootstrap");
  const freshInstall = path.join(root, "fresh-parent", "Codexless");
  const freshInvocations = await invocationDir("fresh");
  const previousBootstrapBuild = "a".repeat(64);
  await materializeInitialBootstrap({ sourceRoot: projectRoot, bootstrapRoot: freshBootstrap, buildId: previousBootstrapBuild });
  const oldBootstrapEntry = path.join(freshBootstrap, "generations", previousBootstrapBuild, "scripts", "bootstrap.mjs");
  const oldBootstrapBytes = await readFile(oldBootstrapEntry);
  const fresh = await runExternalBootstrap(freshBootstrap, freshInstall, freshInvocations);
  assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
  const freshReceipt = JSON.parse(fresh.stdout);
  assert.equal(freshReceipt.ok, true);
  assert.equal(freshReceipt.action, "installed");
  assert.equal(freshReceipt.current.buildId, null);
  assert.equal(freshReceipt.staged.buildId, targetRelease.manifest.buildId);
  assert.equal(freshReceipt.lifecycle.to.buildId, targetRelease.manifest.buildId);
  assert.equal((await readBootstrapPointer(freshBootstrap)).buildId, targetRelease.manifest.buildId);
  assert.equal(Buffer.compare(await readFile(oldBootstrapEntry), oldBootstrapBytes), 0, "self-update must leave executing previous generation byte-for-byte intact");
  assert.equal((await readInvocationRecords(freshInvocations)).length, 1, "fresh external updater must invoke staged installer exactly once");
  assert.equal((await readInvocationRecords(freshInvocations))[0].repair, false);
  assert.equal((await stat(freshInstall)).isDirectory(), true);
  assert.equal((await readdir(tempRoot)).length, 0);
  assert.equal((await readdir(stagingRoot)).length, 0);
  assertNoSecretOrPath(freshReceipt);

  const normalBootstrap = path.join(root, "normal-bootstrap");
  const normalInstall = path.join(root, "normal-parent", "Codexless");
  assert.equal(runFixtureInstaller(oldRelease, normalInstall, { bootstrapRoot: normalBootstrap }).status, 0);
  setTarget(targetRelease);
  resetCounters();
  const normalInvocations = await invocationDir("normal-update");
  const normal = await runExternalBootstrap(normalBootstrap, normalInstall, normalInvocations);
  assert.equal(normal.status, 0, normal.stderr || normal.stdout);
  const normalReceipt = JSON.parse(normal.stdout);
  assert.equal(normalReceipt.action, "updated");
  assert.equal(normalReceipt.lifecycle.action, "updated");
  assert.equal((await readInvocationRecords(normalInvocations)).length, 1);
  assert.equal((await readInvocationRecords(normalInvocations))[0].repair, false, "normal update must not pass -Repair");
  assert.equal((await readBootstrapPointer(normalBootstrap)).buildId, targetRelease.manifest.buildId);
  assert.equal((await readInstalledManifest(normalInstall)).buildId, targetRelease.manifest.buildId);
  assert.equal((await readMarker(normalInstall)).lastKnownBuildId, targetRelease.manifest.buildId);

  resetCounters();
  const noopInvocations = await invocationDir("noop");
  const noop = await runExternalBootstrap(normalBootstrap, normalInstall, noopInvocations);
  assert.equal(noop.status, 0);
  const noopReceipt = JSON.parse(noop.stdout);
  assert.equal(noopReceipt.action, "no-op");
  assert.ok(new Set(["up_to_date", "same_build"]).has(noopReceipt.status));
  assert.equal(counters.artifact, 0, "same-build check must not download artifact");
  assert.equal((await readInvocationRecords(noopInvocations)).length, 0);

  const repairBootstrap = path.join(root, "repair-bootstrap");
  const repairInstall = path.join(root, "repair-parent", "Codexless");
  assert.equal(runFixtureInstaller(oldRelease, repairInstall, { bootstrapRoot: repairBootstrap }).status, 0);
  const repairSeedMarker = await readMarker(repairInstall);
  await corruptInstallIdentity(repairInstall);
  setTarget(targetRelease);
  resetCounters();
  const repairInvocations = await invocationDir("repair-valid-marker");
  const repaired = await runExternalBootstrap(repairBootstrap, repairInstall, repairInvocations);
  assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
  const repairReceipt = JSON.parse(repaired.stdout);
  assert.equal(repairReceipt.action, "repaired");
  assert.equal(repairReceipt.lifecycle.action, "repaired");
  const repairRecords = await readInvocationRecords(repairInvocations);
  assert.equal(repairRecords.length, 1);
  assert.equal(repairRecords[0].repair, true, "marker-qualified damaged identity must invoke fixed staged installer with -Repair");
  assert.equal(repairReceipt.lifecycle.from.buildId, repairSeedMarker.lastKnownBuildId, "H repair preflight must remain the authority for marker-backed from identity");
  assert.equal((await readInstalledManifest(repairInstall)).buildId, targetRelease.manifest.buildId);
  assert.equal((await readBootstrapPointer(repairBootstrap)).buildId, targetRelease.manifest.buildId);
  assert.equal((await readMarker(repairInstall)).lastKnownBuildId, targetRelease.manifest.buildId);

  await assertMarkerGateFailure("missing-marker", async ({ installDir }) => {
    await rm(await markerFilePath(installDir), { force: true });
  }, "REPAIR_OWNERSHIP_UNAVAILABLE");
  await assertMarkerGateFailure("wrong-marker", async ({ installDir }) => {
    await rm(await markerFilePath(installDir), { force: true });
    const wrongDir = path.join(root, "wrong-owned-parent", "Codexless");
    const seed = await readMarkerFromSeedForWrongPath(oldRelease, wrongDir);
    void seed;
  }, "REPAIR_OWNERSHIP_UNAVAILABLE");
  await assertMarkerGateFailure("tampered-marker", async ({ installDir }) => {
    const markerPath = await markerFilePath(installDir);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, `${JSON.stringify({ ...marker, unexpectedSecret: secret })}\n`, "utf8");
  }, "REPAIR_OWNERSHIP_INVALID");

  const productBootstrap = path.join(root, "product-mismatch-bootstrap");
  const productInstall = path.join(root, "product-mismatch-parent", "Codexless");
  assert.equal(runFixtureInstaller(oldRelease, productInstall, { bootstrapRoot: productBootstrap }).status, 0);
  const productMarker = await readMarker(productInstall);
  const productManifest = await readInstalledManifest(productInstall);
  await writeFile(path.join(productInstall, "config", "release-manifest.json"), `${JSON.stringify({ ...productManifest, productId: "other-product" })}\n`, "utf8");
  await writeFile(path.join(productInstall, "package.json"), JSON.stringify({ name: "other-product", version: productManifest.version }), "utf8");
  setTarget(targetRelease);
  resetCounters();
  const productInvocations = await invocationDir("product-mismatch");
  const productFailure = await runExternalBootstrap(productBootstrap, productInstall, productInvocations);
  assert.notEqual(productFailure.status, 0);
  const productFailureReceipt = JSON.parse(productFailure.stdout);
  assert.equal(productFailureReceipt.errorCode, "INSTALL_OWNERSHIP_MISMATCH", "product contradiction must never fall back to marker repair");
  assert.equal((await readInvocationRecords(productInvocations)).length, 0);
  assert.equal(counters.artifact, 0);
  assert.equal((await readMarker(productInstall)).lastKnownBuildId, productMarker.lastKnownBuildId);

  const mismatchBootstrap = path.join(root, "sidecar-mismatch-bootstrap");
  await materializeInitialBootstrap({ sourceRoot: projectRoot, bootstrapRoot: mismatchBootstrap, buildId: "b".repeat(64) });
  setTarget(targetRelease, { artifactBytes: mismatchRelease.zipBytes });
  resetCounters();
  const mismatchInvocations = await invocationDir("sidecar-internal-mismatch");
  const mismatch = await runExternalBootstrap(mismatchBootstrap, path.join(root, "mismatch-parent", "Codexless"), mismatchInvocations);
  assert.notEqual(mismatch.status, 0);
  const mismatchReceipt = JSON.parse(mismatch.stdout);
  assert.equal(mismatchReceipt.errorCode, "ARTIFACT_MANIFEST_MISMATCH");
  assert.equal(mismatchReceipt.errorStage, "manifest-match");
  assert.equal((await readInvocationRecords(mismatchInvocations)).length, 0);

  const badDigestBootstrap = path.join(root, "bad-digest-bootstrap");
  await materializeInitialBootstrap({ sourceRoot: projectRoot, bootstrapRoot: badDigestBootstrap, buildId: "c".repeat(64) });
  setTarget(targetRelease, { artifactDigest: "0".repeat(64) });
  resetCounters();
  const badDigestInvocations = await invocationDir("bad-digest");
  const badDigest = await runExternalBootstrap(badDigestBootstrap, path.join(root, "bad-digest-parent", "Codexless"), badDigestInvocations);
  assert.notEqual(badDigest.status, 0);
  assert.equal(JSON.parse(badDigest.stdout).errorStage, "discovery");
  assert.equal(counters.artifact, 1);
  assert.equal((await readInvocationRecords(badDigestInvocations)).length, 0);
  assert.equal((await readdir(stagingRoot)).length, 0, "bad digest must fail before safe extraction staging");

  const incompatibleBootstrap = path.join(root, "incompatible-bootstrap");
  const incompatibleInstall = path.join(root, "incompatible-parent", "Codexless");
  assert.equal(runFixtureInstaller(oldRelease, incompatibleInstall, { bootstrapRoot: incompatibleBootstrap }).status, 0);
  await corruptInstallIdentity(incompatibleInstall);
  const incompatibleSidecar = structuredClone(targetRelease.manifest);
  incompatibleSidecar.stateCompatibility.stores["recent-calls"].schemaVersion = 2;
  setTarget(targetRelease, { sidecarBytes: Buffer.from(`${JSON.stringify(incompatibleSidecar)}\n`, "utf8") });
  resetCounters();
  const incompatibleInvocations = await invocationDir("state-incompatible");
  const incompatible = await runExternalBootstrap(incompatibleBootstrap, incompatibleInstall, incompatibleInvocations);
  assert.notEqual(incompatible.status, 0);
  const incompatibleReceipt = JSON.parse(incompatible.stdout);
  assert.equal(incompatibleReceipt.errorCode, "DISCOVERY_FAILED");
  assert.equal(counters.artifact, 0, "state-incompatible sidecar must fail before repair artifact download");
  assert.equal((await readInvocationRecords(incompatibleInvocations)).length, 0);

  const concurrencyBootstrap = path.join(root, "concurrency-bootstrap");
  const concurrencyInstall = path.join(root, "concurrency-parent", "Codexless");
  assert.equal(runFixtureInstaller(oldRelease, concurrencyInstall, { bootstrapRoot: concurrencyBootstrap }).status, 0);
  setTarget(targetRelease);
  resetCounters();
  const concurrencyInvocations = await invocationDir("concurrency");
  const [left, right] = await Promise.all([
    runExternalBootstrap(concurrencyBootstrap, concurrencyInstall, concurrencyInvocations, { barrier: true, doctorDelayMs: 600 }),
    runExternalBootstrap(concurrencyBootstrap, concurrencyInstall, concurrencyInvocations, { barrier: true, doctorDelayMs: 600 }),
  ]);
  const contenders = [left, right];
  const winners = contenders.filter((result) => result.status === 0);
  const losers = contenders.filter((result) => result.status !== 0);
  assert.equal(winners.length, 1, `exactly one external updater must win H activation: ${JSON.stringify(contenders)}`);
  assert.equal(losers.length, 1);
  assert.equal(JSON.parse(winners[0].stdout).lifecycle.action, "updated");
  assert.equal(JSON.parse(losers[0].stdout).errorCode, "INSTALLER_FAILED");
  assert.equal((await readInvocationRecords(concurrencyInvocations)).length, 2, "both external updaters reach the staged installer; H lock decides mutation winner");
  assert.equal((await readInstalledManifest(concurrencyInstall)).buildId, targetRelease.manifest.buildId);
  assert.equal((await readBootstrapPointer(concurrencyBootstrap)).buildId, targetRelease.manifest.buildId);
  assert.equal((await readInstalledManifest(path.join(root, "concurrency-parent", "Codexless-previous"))).buildId, oldRelease.manifest.buildId, "only the winning installer mutates previous backup");
  assert.equal((await readdir(concurrencyBootstrap)).some((name) => name.startsWith(".pending-")), false, "winner/loser cleanup must leave no pending bootstrap generation");

  const failureReceipt = buildBootstrapFailureReceipt(new Error(`${secret} https://example.com/evil ${path.join(root, "secret-path")}`));
  assertNoSecretOrPath(failureReceipt);
  assert.deepEqual(await snapshotActivationLock(realActivationLock), realActivationLockBefore, "fixture must not mutate the real user activation lock");

  process.stdout.write(`bootstrap updater Windows E2E PASS ${targetRelease.manifest.buildId}\n`);
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}

async function assertMarkerGateFailure(label, mutateMarker, expectedCode) {
  const bootstrapRoot = path.join(root, `${label}-bootstrap`);
  const installDir = path.join(root, `${label}-parent`, "Codexless");
  assert.equal(runFixtureInstaller(oldReleaseForHelper(), installDir, { bootstrapRoot }).status, 0);
  await mutateMarker({ installDir, bootstrapRoot });
  await corruptInstallIdentity(installDir);
  setTarget(targetReleaseForHelper());
  resetCounters();
  const invocations = await invocationDir(label);
  const result = await runExternalBootstrap(bootstrapRoot, installDir, invocations);
  assert.notEqual(result.status, 0, `${label} must fail closed`);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.errorCode, expectedCode, `${label} must fail at marker qualification`);
  assert.ok(counters.releases >= 1 && counters.manifest >= 1, `${label} must still perform P0-F discovery/check before marker qualification`);
  assert.equal(counters.artifact, 0, `${label} must not download artifact after marker qualification failure`);
  assert.equal((await readInvocationRecords(invocations)).length, 0, `${label} must not invoke staged installer`);
}

function oldReleaseForHelper() { return helperOldRelease; }
function targetReleaseForHelper() { return helperTargetRelease; }

async function readMarkerFromSeedForWrongPath(release, wrongDir) {
  const bootstrapRoot = path.join(root, "wrong-marker-other-bootstrap");
  const result = runFixtureInstaller(release, wrongDir, { bootstrapRoot });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return readMarker(wrongDir);
}

async function createFixtureRelease(version, sourceRevision, hostContractVersion) {
  const packageParent = path.join(root, `package-${sourceRevision}`);
  const releaseRoot = path.join(packageParent, `codexless-${version}`);
  for (const directory of ["src", "config", "scripts", "skills/codexless-browser-repair", "bin"]) await mkdir(path.join(releaseRoot, directory), { recursive: true });

  for (const relative of BOOTSTRAP_GENERATION_FILES) {
    const from = path.join(projectRoot, ...relative.split("/"));
    const to = path.join(releaseRoot, ...relative.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  for (const file of ["lifecycle.mjs", "materialize-bootstrap.mjs", "install.sh"]) {
    await copyFile(path.join(projectRoot, "scripts", file), path.join(releaseRoot, "scripts", file));
  }
  await copyFile(path.join(projectRoot, "scripts", "install.ps1"), path.join(releaseRoot, "scripts", "install-real.ps1"));
  await writeFile(path.join(releaseRoot, "scripts", "install.ps1"), fixtureInstallerWrapper(), "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "resolve-codex.mjs"), [
    "import process from 'node:process';",
    "process.stdout.write(JSON.stringify({ok:true,path:process.execPath,version:'fixture-codex',source:'fixture'}) + '\\n');",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "doctor.mjs"), [
    "import process from 'node:process';",
    "const delay = Number(process.env.CODEXLESS_FIXTURE_DOCTOR_DELAY_MS || '0');",
    "if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);",
    "process.stdout.write(JSON.stringify({status:'ok'}) + '\\n');",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "uninstall.ps1"), "# fixture\n", "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "uninstall.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "launch.mjs"), "// fixture\n", "utf8");
  await writeFile(path.join(releaseRoot, "bin", "fixture.txt"), "fixture\n", "utf8");
  await writeFile(path.join(releaseRoot, "config", "toolbox-method-registry.json"), "{}\n", "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "runtime-install-state.mjs"), [
    "import process from 'node:process';",
    "const command = process.argv[2] || 'status';",
    "let value;",
    "if (command === 'status') value = {ok:true,preference:{mode:null,persisted:false,updatedAt:null},routing:{activation:'existing_only_pending_managed',managedReady:false,persisted:false,updatedAt:null}};",
    "else if (command === 'verify-managed') value = {ok:true,action:'managed-runtime-provisioned',activationChanged:false,activation:'existing_only_pending_managed',managedReady:false,managed:{packageName:'@openai/codex',packageVersion:'0.147.0',platformPackageName:'@openai/codex-win32-x64',platformPackageVersion:'0.147.0-win32-x64',binarySha256:'f'.repeat(64),codexHome:'fixture-managed-home',source:'fixture'},officialLoginRequiredBeforeFirstDualActivation:true,noExistingCredentialCopy:true,noExistingCodexHomeCopy:true,noSilentFallback:true};",
    "else value = {ok:true,action:command,mode:process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : null};",
    "process.stdout.write(JSON.stringify(value) + '\\n');",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "sync-codex-skills.mjs"), [
    "import process from 'node:process';",
    "process.stdout.write(JSON.stringify({ok:true,status:'current',action:'no-op',targetLane:'existing',transactionId:null}) + '\\n');",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(releaseRoot, "skills", "codexless-browser-repair", "SKILL.md"), "---\nname: codexless-browser-repair\ndescription: fixture\n---\n", "utf8");
  await writeFile(path.join(releaseRoot, "package.json"), `${JSON.stringify({ name: "codexless", version, private: true, type: "module" }, null, 2)}\n`, "utf8");
  await writeFile(path.join(releaseRoot, "npm-shrinkwrap.json"), `${JSON.stringify({ name: "codexless", version, lockfileVersion: 3, requires: true, packages: { "": { name: "codexless", version } } }, null, 2)}\n`, "utf8");
  for (const file of ["README.md", "README.zh-CN.md", "SECURITY.md", "EXPORT_SYNC.md", "THIRD_PARTY_NOTICES.md", "LICENSE"]) {
    await writeFile(path.join(releaseRoot, file), `${file} fixture ${sourceRevision}\n`, "utf8");
  }

  const manifest = await buildReleaseManifest({ root: releaseRoot, serverVersion: version, hostContractVersion, sourceRevision });
  await writeFile(path.join(releaseRoot, "config", "release-manifest.json"), serializeReleaseManifest(manifest), "utf8");
  const zipPath = path.join(root, `${sourceRevision}.zip`);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
    `[System.IO.Compression.ZipFile]::CreateFromDirectory('${escapePowerShell(packageParent)}','${escapePowerShell(zipPath)}',[System.IO.Compression.CompressionLevel]::Optimal,$false);`,
  ].join(" ")], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const fixture = { version, root: releaseRoot, manifest, zipBytes: await readFile(zipPath) };
  if (version === "0.1.0-preview.0" && sourceRevision === "old-release") helperOldRelease = fixture;
  if (version === "0.2.0-preview.0" && sourceRevision === "target-release") helperTargetRelease = fixture;
  return fixture;
}

function fixtureInstallerWrapper() {
  return [
    "[CmdletBinding()]",
    "param([string]$InstallDir,[switch]$Repair,[switch]$Json)",
    "$ErrorActionPreference='Stop'",
    "Set-Variable -Name HOME -Scope Global -Value $env:USERPROFILE -Force",
    "$fixtureStateRoot=[System.IO.Path]::GetFullPath((Join-Path (Join-Path $HOME '.config') 'codexless'))",
    "if(([string]$HOME -ne [string]$env:HOME) -or ([string]$HOME -ne [string]$env:USERPROFILE) -or ($fixtureStateRoot -ne [System.IO.Path]::GetFullPath($env:CODEXLESS_BOOTSTRAP_FIXTURE_STATE_ROOT))){ throw 'fixture HOME isolation failed' }",
    "$invokeDir=$env:CODEXLESS_BOOTSTRAP_FIXTURE_INVOKE_DIR",
    "if($invokeDir){ New-Item -ItemType Directory -Force -Path $invokeDir | Out-Null; $record=[ordered]@{repair=$Repair.IsPresent;pid=$PID;home=[string]$HOME;envHome=[string]$env:HOME;userProfile=[string]$env:USERPROFILE;stateRoot=$fixtureStateRoot} | ConvertTo-Json -Compress; [System.IO.File]::WriteAllText((Join-Path $invokeDir ('invoke-'+$PID+'.json')),$record) }",
    "if($env:CODEXLESS_BOOTSTRAP_FIXTURE_BARRIER -eq '1' -and $invokeDir){ $deadline=[DateTime]::UtcNow.AddSeconds(10); while((Get-ChildItem -LiteralPath $invokeDir -Filter 'invoke-*.json' -ErrorAction SilentlyContinue).Count -lt 2){ if([DateTime]::UtcNow -gt $deadline){ throw 'fixture barrier timeout' }; Start-Sleep -Milliseconds 20 } }",
    "if($Repair){ & (Join-Path $PSScriptRoot 'install-real.ps1') -InstallDir $InstallDir -Json -Repair }",
    "else { & (Join-Path $PSScriptRoot 'install-real.ps1') -InstallDir $InstallDir -Json }",
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");
}

function setTarget(fixture, { artifactBytes = fixture.zipBytes, artifactDigest = null, sidecarBytes = null } = {}) {
  const sidecar = sidecarBytes ?? Buffer.from(serializeReleaseManifest(fixture.manifest), "utf8");
  serverState.version = fixture.version;
  serverState.artifactBytes = Buffer.from(artifactBytes);
  serverState.artifactDigest = artifactDigest ?? sha256(serverState.artifactBytes);
  serverState.sidecarBytes = Buffer.from(sidecar);
  serverState.sidecarDigest = sha256(serverState.sidecarBytes);
}

function runFixtureInstaller(fixture, installDir, { bootstrapRoot } = {}) {
  return spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(fixture.root, "scripts", "install.ps1"), "-InstallDir", installDir, "-Json",
  ], {
    encoding: "utf8",
    env: fixtureEnv({ bootstrapRoot }),
    windowsHide: true,
    timeout: 30_000,
  });
}

async function runExternalBootstrap(bootstrapRoot, installDir, invocations, { barrier = false, doctorDelayMs = 0 } = {}) {
  const env = fixtureEnv({ bootstrapRoot, invocations, barrier, doctorDelayMs, testMode: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(bootstrapRoot, "run.mjs"), "update", "--install-dir", installDir], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("external bootstrap fixture timed out"));
    }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function fixtureEnv({ bootstrapRoot = null, invocations = null, barrier = false, doctorDelayMs = 0, testMode = false } = {}) {
  const env = {
    ...process.env,
    PATH: `${fakeTools}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: stateHome,
    USERPROFILE: stateHome,
    CODEXLESS_BOOTSTRAP_FIXTURE_STATE_ROOT: stateRoot,
    GITHUB_TOKEN: secret,
    CODEXLESS_FIXTURE_DOCTOR_DELAY_MS: String(doctorDelayMs),
  };
  if (bootstrapRoot) env.CODEXLESS_BOOTSTRAP_ROOT = bootstrapRoot; else delete env.CODEXLESS_BOOTSTRAP_ROOT;
  if (invocations) env.CODEXLESS_BOOTSTRAP_FIXTURE_INVOKE_DIR = invocations; else delete env.CODEXLESS_BOOTSTRAP_FIXTURE_INVOKE_DIR;
  if (barrier) env.CODEXLESS_BOOTSTRAP_FIXTURE_BARRIER = "1"; else delete env.CODEXLESS_BOOTSTRAP_FIXTURE_BARRIER;
  delete env.CODEXLESS_BOOTSTRAP_PREPARED_BUILD_ID;
  delete env.CODEXLESS_BOOTSTRAP_PREPARED_REUSED;
  delete env.CODEXLESS_BOOTSTRAP_PREPARED_PENDING_DIR;
  if (testMode) {
    env.CODEXLESS_BOOTSTRAP_TEST_MODE = "1";
    env.CODEXLESS_BOOTSTRAP_TEST_ENDPOINT = `${origin}/releases`;
    env.CODEXLESS_BOOTSTRAP_TEST_TEMP_ROOT = tempRoot;
    env.CODEXLESS_BOOTSTRAP_TEST_STAGING_ROOT = stagingRoot;
    env.CODEXLESS_BOOTSTRAP_TEST_STATE_ROOT = stateRoot;
  } else {
    delete env.CODEXLESS_BOOTSTRAP_TEST_MODE;
    delete env.CODEXLESS_BOOTSTRAP_TEST_ENDPOINT;
    delete env.CODEXLESS_BOOTSTRAP_TEST_TEMP_ROOT;
    delete env.CODEXLESS_BOOTSTRAP_TEST_STAGING_ROOT;
    delete env.CODEXLESS_BOOTSTRAP_TEST_STATE_ROOT;
  }
  return env;
}

async function invocationDir(label) {
  const target = path.join(root, `invocations-${label}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  return target;
}

async function readInvocationRecords(directory) {
  const names = (await readdir(directory)).filter((name) => name.startsWith("invoke-") && name.endsWith(".json"));
  const records = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"))));
  const expectedHome = path.resolve(stateHome).toLowerCase();
  const expectedStateRoot = path.resolve(stateRoot).toLowerCase();
  for (const record of records) {
    assert.equal(path.resolve(record.home).toLowerCase(), expectedHome, "fixture PowerShell $HOME must use isolated home");
    assert.equal(path.resolve(record.envHome).toLowerCase(), expectedHome, "fixture env HOME must use isolated home");
    assert.equal(path.resolve(record.userProfile).toLowerCase(), expectedHome, "fixture USERPROFILE must use isolated home");
    assert.equal(path.resolve(record.stateRoot).toLowerCase(), expectedStateRoot, "fixture PowerShell StateRoot must stay under isolated home");
  }
  return records;
}

async function corruptInstallIdentity(installDir) {
  await writeFile(path.join(installDir, "config", "release-manifest.json"), `{damaged-${secret}`, "utf8");
  await writeFile(path.join(installDir, "package.json"), `{damaged-${secret}`, "utf8");
}

async function readInstalledManifest(installDir) {
  return JSON.parse(await readFile(path.join(installDir, "config", "release-manifest.json"), "utf8"));
}

async function markerFilePath(installDir) {
  const identity = await canonicalInstallDirIdentity(installDir);
  return path.join(stateRoot, `${OWNERSHIP_MARKER_PREFIX}${identity.sha256}.json`);
}

async function readMarker(installDir) {
  return JSON.parse(await readFile(await markerFilePath(installDir), "utf8"));
}

function readRealPowerShellHome() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "[Console]::Out.Write([string]$HOME)"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const home = result.stdout.trim();
  assert.equal(path.isAbsolute(home), true, "real PowerShell $HOME must be absolute");
  return home;
}

async function snapshotActivationLock(lockPath) {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
  const metadataPath = path.join(lockPath, INSTALLER_LOCK_METADATA_FILENAME);
  let metadata;
  try {
    const metadataStat = await stat(metadataPath);
    metadata = {
      exists: true,
      mtimeMs: metadataStat.mtimeMs,
      size: metadataStat.size,
      sha256: sha256(await readFile(metadataPath)),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    metadata = { exists: false };
  }
  return {
    exists: true,
    mtimeMs: lockStat.mtimeMs,
    entries: (await readdir(lockPath)).sort(),
    metadata,
  };
}

function resetCounters() {
  counters.artifact = 0;
  counters.manifest = 0;
  counters.releases = 0;
}

function assertNoSecretOrPath(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(secret), false, "receipt must redact test token/secret");
  assert.equal(serialized.includes(origin), false, "receipt must not expose test endpoint URL");
  assert.equal(serialized.includes(path.resolve(root)), false, "receipt must not expose absolute fixture paths");
}

function asset(id, name, size, digest, url) {
  return { id, name, size, digest, state: "uploaded", browser_download_url: url };
}

function sendBytes(res, bytes) {
  const body = Buffer.from(bytes);
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
  res.end(body);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

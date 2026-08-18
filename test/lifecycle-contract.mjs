import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALLER_LOCK_DIRNAME,
  INSTALLER_LOCK_METADATA_FILENAME,
  INSTALLER_LOCK_RECLAIM_PREFIX,
  LifecycleContractError,
  OWNERSHIP_MARKER_PREFIX,
  acquireInstallerLock,
  buildInstallerLockFailureReceipt,
  buildLifecycleFailureReceipt,
  buildLifecycleReceipt,
  canonicalInstallDirIdentity,
  inspectLifecycle,
  releaseInstallerLock,
  validateLifecycleReceipt,
  withInstallerLock,
  writeOwnershipMarker,
} from "../src/lifecycle-contract.mjs";
import {
  computeReleaseBuildId,
  readReleaseManifest,
  serializeReleaseManifest,
} from "../src/release-identity.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const baseManifest = await readReleaseManifest(projectRoot);
const root = await mkdtemp(path.join(os.tmpdir(), "codexless-lifecycle-contract-"));
const secret = "SUPER_SECRET_FIXTURE_MUST_NOT_LEAK";

try {
  const targetSame = path.join(root, "target-same");
  const targetChanged = path.join(root, "target-changed");
  const installedKnown = path.join(root, "installed-known");
  const installedLegacy = path.join(root, "installed-legacy");
  const targetIncompatible = path.join(root, "target-incompatible");

  const oldManifest = deriveManifest(baseManifest, {
    sourceRevision: "old-build",
    hostContractVersion: "host-v1",
  });
  const sameHostManifest = deriveManifest(baseManifest, {
    sourceRevision: "new-build-same-host",
    hostContractVersion: "host-v1",
  });
  const changedHostManifest = deriveManifest(baseManifest, {
    sourceRevision: "new-build-changed-host",
    hostContractVersion: "host-v2",
  });

  await writeManifestRoot(installedKnown, oldManifest);
  await writeManifestRoot(targetSame, sameHostManifest);
  await writeManifestRoot(targetChanged, changedHostManifest);
  await mkdir(installedLegacy, { recursive: true });
  await writeFile(path.join(installedLegacy, "package.json"), JSON.stringify({ name: "codexless", version: baseManifest.version }), "utf8");

  const fresh = await inspectLifecycle({ targetRoot: targetSame });
  assert.equal(fresh.action, "installed");
  assert.equal(fresh.from, null);
  assert.equal(fresh.requiresRuntimeRestart, false, "fresh install has no running previous build to replace");
  assert.equal(fresh.requiresHostRefresh, false, "fresh install has no old host contract to refresh");

  const sameHost = await inspectLifecycle({ targetRoot: targetSame, installedRoot: installedKnown });
  assert.equal(sameHost.action, "updated");
  assert.equal(sameHost.requiresRuntimeRestart, true, "different exact buildId must conservatively require runtime restart");
  assert.equal(sameHost.requiresHostRefresh, false, "same known host contract must not require host refresh");

  const changedHost = await inspectLifecycle({ targetRoot: targetChanged, installedRoot: installedKnown });
  assert.equal(changedHost.requiresHostRefresh, true, "changed host contract must require host refresh");

  const unknownOld = await inspectLifecycle({ targetRoot: targetSame, installedRoot: installedLegacy });
  assert.equal(unknownOld.from.buildId, null);
  assert.equal(unknownOld.from.hostContractVersion, null);
  assert.equal(unknownOld.requiresRuntimeRestart, true, "unknown old build on an existing install must require runtime restart");
  assert.equal(unknownOld.requiresHostRefresh, true, "unknown old host contract must require host refresh");

  const successReceipt = buildLifecycleReceipt({
    plan: sameHost,
    installDir: path.join(root, "installed"),
    doctorStatus: "ok",
    backupRetained: true,
    backupPath: path.join(root, "Codexless-previous"),
  });
  validateLifecycleReceipt(successReceipt, { expectOk: true });
  assert.deepEqual(Object.keys(successReceipt).sort(), [
    "action", "artifactBuildId", "doctorStatus", "from", "installDir", "ok", "receiptVersion", "requiresHostRefresh", "requiresRuntimeRestart", "rollback", "state", "to",
  ].sort());
  assert.deepEqual(successReceipt.state, { preserved: true, schemaCompatible: true, migrated: false });
  assert.deepEqual(successReceipt.rollback, {
    performed: false,
    backupRetained: true,
    backupPath: path.join(root, "Codexless-previous"),
  });

  const failureReceipt = buildLifecycleFailureReceipt({
    action: "update-failed",
    installDir: path.join(root, "installed"),
    errorStage: "installed-doctor",
    errorCode: "INSTALLED_DOCTOR_FAILED",
    error: "doctor failed",
    rollbackPerformed: true,
    schemaCompatible: true,
  });
  validateLifecycleReceipt(failureReceipt, { expectOk: false });
  assert.equal(failureReceipt.rollback.performed, true);
  assert.equal(failureReceipt.state.schemaCompatible, true, "post-preflight failure receipt should retain known state compatibility");
  assert.equal(JSON.stringify(successReceipt).includes(secret), false);
  assert.equal(JSON.stringify(failureReceipt).includes(secret), false);

  const incompatible = structuredClone(sameHostManifest);
  incompatible.stateCompatibility.stores["recent-calls"].schemaVersion = 2;
  await mkdir(path.join(targetIncompatible, "config"), { recursive: true });
  await writeFile(path.join(targetIncompatible, "config", "release-manifest.json"), `${JSON.stringify(incompatible, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => inspectLifecycle({ targetRoot: targetIncompatible, installedRoot: installedKnown }),
    (error) => error instanceof LifecycleContractError && error.code === "STATE_INCOMPATIBLE" && error.stage === "state-compatibility",
    "incompatible target state contract must fail closed before activation"
  );

  await assertLockContract();
  await assertRepairOwnershipContract({ targetRoot: targetChanged, oldManifest, targetIncompatible });
  await assertInstallerContractMarkers();
  process.stdout.write(`lifecycle contract PASS ${sameHost.to.buildId}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function assertLockContract() {
  const stateRoot = path.join(root, "lock-state");
  const installDir = path.join(root, `install-${secret}`);
  await mkdir(installDir, { recursive: true });
  const identity = await canonicalInstallDirIdentity(installDir);

  const first = await acquireInstallerLock({ stateRoot, installDir, action: "update" });
  assert.equal(first.ok, true);
  assert.equal(first.reentrant, false);
  const second = await acquireInstallerLock({ stateRoot, installDir, action: "update" });
  assert.equal(second.reentrant, true, "same-process recursive lock acquisition must not deadlock");
  assert.equal(second.nonce, first.nonce);
  await releaseInstallerLock({ stateRoot, nonce: second.nonce });
  assert.equal((await readdir(stateRoot)).includes(INSTALLER_LOCK_DIRNAME), true, "inner recursive release must retain the outer lock");
  await releaseInstallerLock({ stateRoot, nonce: first.nonce });
  assert.equal((await readdir(stateRoot)).includes(INSTALLER_LOCK_DIRNAME), false);

  await assert.rejects(
    () => withInstallerLock({ stateRoot, installDir, action: "repair" }, async () => { throw new Error("fixture exception"); }),
    /fixture exception/
  );
  const afterException = await acquireInstallerLock({ stateRoot, installDir, action: "repair" });
  await releaseInstallerLock({ stateRoot, nonce: afterException.nonce });

  const staleNonce = "a".repeat(32);
  await writeRawLock(stateRoot, {
    productId: "codexless",
    pid: 424242,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    nonce: staleNonce,
    action: "update",
    installDirHash: identity.sha256,
  });
  const reclaimed = await acquireInstallerLock({
    stateRoot,
    installDir,
    action: "update",
    pidProbe: async () => "dead",
  });
  assert.notEqual(reclaimed.nonce, staleNonce);
  assert.equal((await readdir(stateRoot)).includes(`${INSTALLER_LOCK_RECLAIM_PREFIX}${staleNonce}`), true, "dead-owner reclaim must leave a nonce tombstone against stale-snapshot races");
  await releaseInstallerLock({ stateRoot, nonce: reclaimed.nonce });

  const liveNonce = "b".repeat(32);
  await writeRawLock(stateRoot, {
    productId: "codexless",
    pid: 515151,
    startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    nonce: liveNonce,
    action: "repair",
    installDirHash: identity.sha256,
  });
  await assert.rejects(
    () => acquireInstallerLock({ stateRoot, installDir, action: "repair", pidProbe: async () => "alive" }),
    (error) => error instanceof LifecycleContractError && error.code === "INSTALLER_BUSY",
    "a live PID must never be reclaimed merely because the lock looks old"
  );
  const stillLive = JSON.parse(await readFile(path.join(stateRoot, INSTALLER_LOCK_DIRNAME, INSTALLER_LOCK_METADATA_FILENAME), "utf8"));
  assert.equal(stillLive.nonce, liveNonce);
  await rm(path.join(stateRoot, INSTALLER_LOCK_DIRNAME), { recursive: true, force: true });

  const recentDeadNonce = "c".repeat(32);
  await writeRawLock(stateRoot, {
    productId: "codexless",
    pid: 616161,
    startedAt: new Date().toISOString(),
    nonce: recentDeadNonce,
    action: "install",
    installDirHash: identity.sha256,
  });
  await assert.rejects(
    () => acquireInstallerLock({ stateRoot, installDir, action: "install", pidProbe: async () => "dead" }),
    (error) => error instanceof LifecycleContractError && error.code === "INSTALLER_BUSY",
    "a just-created dead-looking PID must fail closed to reduce PID race/reuse risk"
  );
  await rm(path.join(stateRoot, INSTALLER_LOCK_DIRNAME), { recursive: true, force: true });

  const unknownNonce = "d".repeat(32);
  await writeRawLock(stateRoot, {
    productId: "codexless",
    pid: 717171,
    startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    nonce: unknownNonce,
    action: "update",
    installDirHash: identity.sha256,
  });
  await assert.rejects(
    () => acquireInstallerLock({ stateRoot, installDir, action: "update", pidProbe: async () => "unknown" }),
    (error) => error instanceof LifecycleContractError && error.code === "INSTALLER_BUSY" && /repair|manual/i.test(error.message),
    "unknown PID liveness must fail closed and point to explicit recovery"
  );
  await rm(path.join(stateRoot, INSTALLER_LOCK_DIRNAME), { recursive: true, force: true });

  const receipt = buildInstallerLockFailureReceipt(new LifecycleContractError(
    `busy C:\\Users\\fixture\\${secret} token=${secret}`,
    { code: "INSTALLER_BUSY", stage: "activation-lock" }
  ));
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.errorCode, "INSTALLER_BUSY");
  assert.equal(serialized.includes(secret), false, "lock errors must redact secret-like values and path components");
  assert.equal(serialized.includes("C:\\Users"), false, "lock errors must not expose an absolute install path");

  const safeLock = await acquireInstallerLock({ stateRoot, installDir, action: "install" });
  const raw = JSON.parse(await readFile(path.join(stateRoot, INSTALLER_LOCK_DIRNAME, INSTALLER_LOCK_METADATA_FILENAME), "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), ["action", "installDirHash", "nonce", "pid", "productId", "startedAt"].sort());
  assert.equal(JSON.stringify(raw).includes(installDir), false);
  assert.equal(JSON.stringify(raw).includes(secret), false);
  assert.equal(JSON.stringify(safeLock).includes(installDir), false);
  await releaseInstallerLock({ stateRoot, nonce: safeLock.nonce });
}

async function assertRepairOwnershipContract({ targetRoot, oldManifest, targetIncompatible }) {
  const stateRoot = path.join(root, "repair-state");
  const corruptInstall = path.join(root, `repair-owned-${secret}`);
  await mkdir(path.join(corruptInstall, "config"), { recursive: true });
  await writeFile(path.join(corruptInstall, "config", "release-manifest.json"), "{damaged", "utf8");
  await writeFile(path.join(corruptInstall, "package.json"), "{damaged", "utf8");

  const markerA = await writeOwnershipMarker({
    stateRoot,
    installDir: corruptInstall,
    buildId: oldManifest.buildId,
    version: oldManifest.version,
    now: Date.now() - 10_000,
  });
  assert.equal(markerA.productId, "codexless");
  assert.deepEqual(Object.keys(markerA.installDirIdentity).sort(), ["algorithm", "sha256"]);
  const markerFiles = (await readdir(stateRoot)).filter((name) => name.startsWith(OWNERSHIP_MARKER_PREFIX));
  assert.equal(markerFiles.length, 1);
  const markerPath = path.join(stateRoot, markerFiles[0]);
  const markerRaw = await readFile(markerPath, "utf8");
  assert.equal(markerRaw.includes(path.resolve(corruptInstall)), false, "marker must not store the canonical absolute path");
  assert.equal(markerRaw.includes(secret), false, "marker must not store secret-like install path material except the basename opt-in");
  assert.deepEqual(Object.keys(JSON.parse(markerRaw)).sort(), [
    "createdAt", "installDirIdentity", "lastKnownBuildId", "lastKnownVersion", "markerVersion", "productId", "updatedAt",
  ].sort());

  await assert.rejects(
    () => inspectLifecycle({ targetRoot, installedRoot: corruptInstall, mode: "update", stateRoot, installDir: corruptInstall }),
    (error) => error instanceof LifecycleContractError && error.code === "INSTALLED_IDENTITY_UNAVAILABLE",
    "ordinary update must not use the external marker to bypass install-tree ownership evidence"
  );

  const repaired = await inspectLifecycle({
    targetRoot,
    installedRoot: corruptInstall,
    mode: "repair",
    stateRoot,
    installDir: corruptInstall,
  });
  assert.equal(repaired.action, "repaired");
  assert.equal(repaired.from.buildId, oldManifest.buildId);
  assert.equal(repaired.state.schemaCompatible, true);

  const markerB = await writeOwnershipMarker({
    stateRoot,
    installDir: corruptInstall,
    buildId: repaired.to.buildId,
    version: repaired.to.version,
  });
  assert.equal(markerB.createdAt, markerA.createdAt, "marker refresh must preserve original createdAt");
  assert.equal(markerB.lastKnownBuildId, repaired.to.buildId);
  assert.equal(markerB.lastKnownVersion, repaired.to.version);

  const wrongPath = path.join(root, "repair-wrong-path");
  await mkdir(wrongPath, { recursive: true });
  await assert.rejects(
    () => inspectLifecycle({ targetRoot, installedRoot: wrongPath, mode: "repair", stateRoot, installDir: wrongPath }),
    (error) => error instanceof LifecycleContractError && error.code === "REPAIR_OWNERSHIP_UNAVAILABLE",
    "marker for one canonical installDir must not authorize another directory"
  );

  const validMarker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, `${JSON.stringify({ ...validMarker, productId: "other-product" })}\n`, "utf8");
  await assert.rejects(
    () => inspectLifecycle({ targetRoot, installedRoot: corruptInstall, mode: "repair", stateRoot, installDir: corruptInstall }),
    (error) => error instanceof LifecycleContractError && error.code === "REPAIR_OWNERSHIP_INVALID",
    "wrong-product marker must fail closed"
  );

  await writeFile(markerPath, `${JSON.stringify({ ...validMarker, unexpectedSecret: secret })}\n`, "utf8");
  await assert.rejects(
    () => inspectLifecycle({ targetRoot, installedRoot: corruptInstall, mode: "repair", stateRoot, installDir: corruptInstall }),
    (error) => error instanceof LifecycleContractError && error.code === "REPAIR_OWNERSHIP_INVALID",
    "tampered marker with extra fields must fail closed"
  );
  await writeFile(markerPath, `${JSON.stringify(validMarker)}\n`, "utf8");

  await assert.rejects(
    () => inspectLifecycle({ targetRoot: targetIncompatible, installedRoot: corruptInstall, mode: "repair", stateRoot, installDir: corruptInstall }),
    (error) => error instanceof LifecycleContractError && error.code === "STATE_INCOMPATIBLE",
    "target state incompatibility must fail before repair activation even with a matching marker"
  );

  await rm(markerPath, { force: true });
  await assert.rejects(
    () => inspectLifecycle({ targetRoot, installedRoot: corruptInstall, mode: "repair", stateRoot, installDir: corruptInstall }),
    (error) => error instanceof LifecycleContractError && error.code === "REPAIR_OWNERSHIP_UNAVAILABLE" && /new directory|manually/i.test(error.message),
    "missing marker must fail closed with reinstall/manual recovery guidance"
  );
}

async function writeRawLock(stateRoot, metadata) {
  const lockPath = path.join(stateRoot, INSTALLER_LOCK_DIRNAME);
  await rm(lockPath, { recursive: true, force: true });
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, INSTALLER_LOCK_METADATA_FILENAME), `${JSON.stringify(metadata)}\n`, "utf8");
}

function deriveManifest(base, overrides) {
  const manifest = {
    ...structuredClone(base),
    ...overrides,
    files: structuredClone(base.files),
  };
  manifest.buildId = computeReleaseBuildId({
    productId: manifest.productId,
    manifestVersion: manifest.manifestVersion,
    version: manifest.version,
    sourceRevision: manifest.sourceRevision,
    hostContractVersion: manifest.hostContractVersion,
    stateCompatibility: manifest.stateCompatibility,
    buildIdAlgorithm: manifest.buildIdAlgorithm,
    fileHashAlgorithm: manifest.fileHashAlgorithm,
    files: manifest.files,
  });
  return manifest;
}

async function writeManifestRoot(rootPath, manifest) {
  await mkdir(path.join(rootPath, "config"), { recursive: true });
  await writeFile(path.join(rootPath, "config", "release-manifest.json"), serializeReleaseManifest(manifest), "utf8");
}

async function assertInstallerContractMarkers() {
  const windows = await readFile(path.join(projectRoot, "scripts", "install.ps1"), "utf8");
  const mac = await readFile(path.join(projectRoot, "scripts", "install.sh"), "utf8");
  for (const [label, source] of [["Windows", windows], ["macOS", mac]]) {
    assert.match(source, /scripts[\\/]lifecycle\.mjs/, `${label} installer must call the shared lifecycle helper`);
    assert.match(source, /lock-acquire/, `${label} installer must acquire the shared activation lock`);
    assert.match(source, /lock-release/, `${label} installer must release the shared activation lock`);
    assert.match(source, /preflight/, `${label} installer must run lifecycle preflight before activation`);
    assert.match(source, /receipt/, `${label} installer must build the shared success receipt`);
    assert.match(source, /marker-write/, `${label} installer must write the ownership marker through the shared helper`);
    assert.match(source, /repair/i, `${label} installer must expose explicit repair mode`);
    assert.equal(source.includes("--force"), false, `${label} installer must not expose --force`);
    assert.match(source, /STATE_INCOMPATIBLE/, `${label} installer must expose the state compatibility gate`);
    if (label === "Windows") assert.ok(source.indexOf("lock-acquire") < source.indexOf("Copy-ReleaseTree -From"), `${label} lock must precede staging copy`);
    assert.ok(source.indexOf("receipt") < source.lastIndexOf("marker-write"), `${label} marker must be written only after the success receipt`);
    assert.match(source, /materialize-bootstrap\.mjs/, `${label} installer must wire the external bootstrap helper`);
    assert.ok(source.indexOf("preflight") < source.indexOf("materialize-bootstrap.mjs"), `${label} bootstrap prepare/validate must occur only after lifecycle preflight`);
    assert.ok(source.lastIndexOf("marker-write") < source.lastIndexOf("materialize-bootstrap.mjs"), `${label} bootstrap commit must remain after ownership marker write in the installer transaction`);
    assert.match(source, /previous\.rollback-/, `${label} previous rotation must use a transaction-specific rollback stash`);
    assert.match(source, /PREVIOUS_STASH_RESTORE_FAILED/, `${label} previous stash restore failure must be fail-visible`);
    assert.match(source, /PREVIOUS_STASH_CLEANUP_FAILED/, `${label} committed previous stash cleanup failure must be fail-visible`);
    assert.ok(source.indexOf("previous-stash") < source.lastIndexOf("marker-write"), `${label} old previous must be stashed before marker/bootstrap commit`);
    assert.ok(source.lastIndexOf("previous-stash-cleanup") > source.lastIndexOf("bootstrap-commit"), `${label} old previous stash may be deleted only after bootstrap commit succeeds`);
  }
  assert.ok(windows.indexOf("lock-acquire") < windows.indexOf("New-Item -ItemType Directory -Force -Path $ParentDir"), "Windows lock must precede creating/touching the install parent for staging");
  assert.ok(mac.indexOf("lock-acquire") < mac.indexOf('mkdir -p "$PARENT_DIR"'), "macOS lock must precede staging/install parent mutation");
  assert.match(windows, /\$SuccessReceipt\s*\|\s*ConvertTo-Json/, "Windows JSON output must project the shared success receipt");
  assert.ok(windows.lastIndexOf("Move-Item -LiteralPath $BackupDir -Destination $InstallDir") < windows.lastIndexOf("Restore-PreviousBackupStash"), "Windows rollback must restore current app before retained previous stash");
  assert.match(mac, /printf\s+'%s\\n'\s+"\$SUCCESS_RECEIPT"/, "macOS JSON output must emit the shared success receipt unchanged");
  assert.ok(mac.lastIndexOf('mv "$BACKUP_DIR" "$INSTALL_DIR"') < mac.lastIndexOf("restore_previous_backup_stash"), "macOS rollback must restore current app before retained previous stash");
}

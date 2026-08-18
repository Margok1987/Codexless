import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  CODEXLESS_GITHUB_REPOSITORY,
  buildDiscoveryFailureReceipt,
  cleanupVerifiedArtifact,
  compareCurrentToLatest,
  discoverCodexlessRelease,
  parseGithubAssetDigest,
  releaseAssetContract,
  selectExactAsset,
  selectLatestPreviewRelease,
} from "../src/release-discovery.mjs";
import {
  RELEASE_BUILD_ID_ALGORITHM,
  RELEASE_FILE_HASH_ALGORITHM,
  RELEASE_MANIFEST_VERSION,
  RELEASE_PRODUCT_ID,
  computeReleaseBuildId,
  serializeReleaseManifest,
} from "../src/release-identity.mjs";

const unhandledRejections = [];
const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
process.on("unhandledRejection", onUnhandledRejection);

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(packageJson.repository.url, `git+https://github.com/${CODEXLESS_GITHUB_REPOSITORY.owner}/${CODEXLESS_GITHUB_REPOSITORY.repo}.git`, "package repository must match the single discovery repository identity");
assert.equal(packageJson.homepage.startsWith(`https://github.com/${CODEXLESS_GITHUB_REPOSITORY.owner}/${CODEXLESS_GITHUB_REPOSITORY.repo}`), true, "homepage must match the discovery repository identity");

const artifactBytes = Buffer.from("CODEXLESS_TEST_ARTIFACT\n", "utf8");
const artifactSha = sha256(artifactBytes);
const targetVersion = "0.2.0-preview.0";
const targetHostContract = "codexless-public-preview-v2";
const validTargetManifest = makeManifest(targetVersion, targetHostContract, "target-source");
const validTargetBytes = Buffer.from(serializeReleaseManifest(validTargetManifest), "utf8");
const validTargetSha = sha256(validTargetBytes);

assert.equal(compareCurrentToLatest("0.1.0-preview.0", targetVersion), "update_available");
assert.equal(compareCurrentToLatest(targetVersion, targetVersion), "up_to_date");
assert.equal(compareCurrentToLatest("0.3.0-preview.0", targetVersion), "ahead");
assert.equal(compareCurrentToLatest("not-semver", targetVersion), "unverified");

const selected = selectLatestPreviewRelease([
  releaseFixture("0.9.0-preview.0", { draft: true }),
  releaseFixture("0.8.0-preview.0", { prerelease: false }),
  releaseFixture("0.7.0-beta.1"),
  releaseFixture("0.2.0-preview.0"),
  releaseFixture("0.2.0-preview.2"),
  releaseFixture("0.2.0-preview.1"),
]);
assert.equal(selected?.parsed.raw, "0.2.0-preview.2", "draft/stable/non-preview releases must be ignored and strict preview semver must win");

assert.equal(releaseAssetContract(targetVersion, "win32", "x64").artifactName, `codexless-${targetVersion}-windows-x64.zip`);
assert.equal(releaseAssetContract(targetVersion, "darwin", "arm64").artifactName, `codexless-${targetVersion}-macos-arm64.tar.gz`);
assert.throws(() => releaseAssetContract(targetVersion, "win32", "arm64"), /unsupported release platform/);
assert.equal(parseGithubAssetDigest(`sha256:${artifactSha}`), artifactSha);
assert.throws(() => parseGithubAssetDigest(`md5:${artifactSha}`), /unsupported or malformed/);
const uploadedAsset = asset(91, "state-test.zip", 1, `sha256:${artifactSha}`, "http://127.0.0.1/state-test.zip");
const processingAsset = { ...uploadedAsset, id: 92, state: "processing" };
assert.equal(selectExactAsset({ assets: [processingAsset, uploadedAsset] }, "state-test.zip").id, 91, "non-uploaded same-name assets must not make an uploaded asset ambiguous");
assert.throws(() => selectExactAsset({ assets: [processingAsset] }, "state-test.zip"), /required release asset is missing/, "non-uploaded assets must not be update candidates");

const serverState = { scenario: null };
const server = http.createServer(async (req, res) => {
  const scenario = serverState.scenario;
  if (!scenario) { res.writeHead(500).end(); return; }
  if (req.url === "/releases") {
    if (scenario.delayMetadataMs) await delay(scenario.delayMetadataMs);
    if (scenario.metadataBodyStall) {
      sendPartialAndStall(res, Buffer.from("[{\"partial\":", "utf8"), "application/json");
      return;
    }
    if (scenario.metadataStatus) {
      const limitedHeaders = {
        "content-type": "application/json",
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "2000000000",
      };
      if (scenario.metadataStatus === 429) limitedHeaders["retry-after"] = "5";
      res.writeHead(scenario.metadataStatus, limitedHeaders);
      res.end(JSON.stringify({ message: "limited" }));
      return;
    }
    if (scenario.malformedMetadata) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not-json");
      return;
    }
    const body = Buffer.from(JSON.stringify(scenario.releases), "utf8");
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(body.length),
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "59",
      "x-ratelimit-reset": "2000000000",
    });
    res.end(body);
    return;
  }
  if (req.url === "/artifact") {
    if (scenario.artifactBodyStall) return sendPartialAndStall(res, Buffer.from((scenario.artifactBytes ?? artifactBytes).subarray(0, 5)));
    return sendBytes(res, scenario.artifactBytes ?? artifactBytes, scenario.artifactStatus ?? 200);
  }
  if (req.url === "/manifest") {
    if (scenario.manifestBodyStall) return sendPartialAndStall(res, Buffer.from("{\"manifestVersion\":", "utf8"), "application/json");
    return sendBytes(res, scenario.manifestBytes ?? validTargetBytes, scenario.manifestStatus ?? 200);
  }
  if (req.url === "/checksums") {
    if (scenario.checksumBodyStall) return sendPartialAndStall(res, Buffer.from("0123456789abcdef", "utf8"), "text/plain");
    return sendBytes(res, Buffer.from(scenario.checksumText ?? "", "utf8"), 200);
  }
  if (req.url === "/redirect-artifact") {
    res.writeHead(302, { location: "/artifact" });
    res.end();
    return;
  }
  if (req.url === "/redirect-evil") {
    res.writeHead(302, { location: "http://example.com/evil" });
    res.end();
    return;
  }
  res.writeHead(404).end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const endpoint = `${origin}/releases`;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-discovery-test-"));
const currentRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-current-test-"));
try {
  await writeInstalledManifest(currentRoot, makeManifest("0.1.0-preview.0", "codexless-public-preview-v1", "old-source"));

  serverState.scenario = normalScenario(origin, { githubDigests: true });
  const metadataOnly = await discoverCodexlessRelease({
    currentRoot,
    platform: "win32",
    arch: "x64",
    testEndpoint: endpoint,
    tempRoot,
  });
  assert.equal(metadataOnly.status, "update_available");
  assert.equal(metadataOnly.latest.version, targetVersion);
  assert.equal(metadataOnly.asset.name, `codexless-${targetVersion}-windows-x64.zip`);
  assert.equal(metadataOnly.asset.digestSource, "github-asset-digest");
  assert.equal(metadataOnly.asset.verifiedSha256, null);
  assert.equal(Object.hasOwn(metadataOnly.asset, "tempPath"), false, "ordinary check must not return tempPath");
  assert.equal(metadataOnly.releaseManifest.buildId, validTargetManifest.buildId);
  assert.equal(Object.hasOwn(metadataOnly, "verifiedManifest"), false, "ordinary P0-F discovery receipt must not expose the internal full sidecar manifest");
  assert.equal(metadataOnly.requiresHostRefresh, true);
  assert.deepEqual(metadataOnly.network.rateLimit, { limit: 60, remaining: 59, resetEpochSeconds: 2000000000, retryAfterSeconds: null });

  await writeInstalledManifest(currentRoot, makeManifest("0.1.0-preview.0", targetHostContract, "old-same-host"));
  const sameHost = await discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, tempRoot });
  assert.equal(sameHost.requiresHostRefresh, false, "same hostContractVersion must not require Host refresh");

  const verified = await discoverCodexlessRelease({
    currentRoot,
    platform: "win32",
    arch: "x64",
    testEndpoint: endpoint,
    tempRoot,
    downloadArtifact: true,
  });
  assert.equal(verified.asset.verifiedSha256, artifactSha);
  assert.equal(sha256(await readFile(verified.asset.tempPath)), artifactSha);
  await cleanupVerifiedArtifact(verified.asset.tempPath);
  assert.equal((await readdir(tempRoot)).length, 0, "explicit cleanup must remove the verified temp directory");

  serverState.scenario = normalScenario(origin, { githubDigests: false });
  const sidecar = await discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, tempRoot });
  assert.equal(sidecar.asset.digestSource, "release-sha256sums");
  assert.equal(sidecar.verification.manifestDigestSource, "release-sha256sums");

  serverState.scenario = normalScenario(origin, { githubDigests: false, omitChecksumAsset: true });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["ASSET_MISSING", "CHECKSUM_MISSING"]);

  serverState.scenario = normalScenario(origin, { githubDigests: false, checksumText: `${"0".repeat(64)}  codexless-${targetVersion}-windows-x64.zip\n${validTargetSha}  codexless-${targetVersion}-release-manifest.json\n` });
  const conflictWithSidecarOnly = await discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint });
  assert.equal(conflictWithSidecarOnly.asset.digest, "0".repeat(64), "sidecar is authoritative when GitHub digest is absent");

  serverState.scenario = normalScenario(origin, { githubDigests: true, manifestDigest: null, checksumText: `${"f".repeat(64)}  codexless-${targetVersion}-windows-x64.zip\n${validTargetSha}  codexless-${targetVersion}-release-manifest.json\n` });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["CHECKSUM_CONFLICT"]);

  serverState.scenario = normalScenario(origin, { githubDigests: true, artifactDigest: "sha256:not-a-digest" });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["INVALID_ASSET_DIGEST"]);

  serverState.scenario = normalScenario(origin, { githubDigests: true, duplicateArtifact: true });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["ASSET_AMBIGUOUS"]);

  serverState.scenario = normalScenario(origin, { githubDigests: true, omitArtifact: true });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["ASSET_MISSING"]);

  serverState.scenario = normalScenario(origin, { githubDigests: true, artifactState: "processing" });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["ASSET_MISSING"]);

  serverState.scenario = normalScenario(origin, { githubDigests: true, artifactSize: 9999 });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, artifactMaxBytes: 100 }), ["ASSET_TOO_LARGE"]);

  serverState.scenario = normalScenario(origin, { githubDigests: true, artifactDigest: `sha256:${"0".repeat(64)}` });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, tempRoot, downloadArtifact: true }), ["DIGEST_MISMATCH"]);
  assert.equal((await readdir(tempRoot)).length, 0, "failed artifact verification must clean its random temp directory");

  serverState.scenario = normalScenario(origin, { githubDigests: true, malformedManifest: true });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["MALFORMED_RELEASE_MANIFEST"]);

  serverState.scenario = normalScenario(origin, { githubDigests: true, incompatibleState: true });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["STATE_INCOMPATIBLE"]);

  serverState.scenario = normalScenario(origin, { githubDigests: true, artifactPath: "/redirect-artifact" });
  const safeRedirect = await discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, tempRoot, downloadArtifact: true });
  assert.equal(safeRedirect.asset.verifiedSha256, artifactSha);
  await cleanupVerifiedArtifact(safeRedirect.asset.tempPath);

  serverState.scenario = normalScenario(origin, { githubDigests: true, artifactPath: "/redirect-evil" });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, tempRoot, downloadArtifact: true }), ["REDIRECT_HOST_REJECTED"]);
  assert.equal((await readdir(tempRoot)).length, 0);

  serverState.scenario = normalScenario(origin, { githubDigests: true, artifactUrl: "http://example.com/evil.zip" });
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["REDIRECT_HOST_REJECTED"]);

  serverState.scenario = { releases: [] };
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["NO_MATCHING_RELEASE"]);

  serverState.scenario = { ...normalScenario(origin, { githubDigests: true }), malformedMetadata: true };
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint }), ["MALFORMED_JSON"]);

  serverState.scenario = { ...normalScenario(origin, { githubDigests: true }), delayMetadataMs: 100 };
  await expectFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, timeoutMs: 10 }), ["NETWORK_TIMEOUT"]);

  const stallSecret = "ghp_STALL_SECRET_SHOULD_NEVER_APPEAR";
  serverState.scenario = { ...normalScenario(origin, { githubDigests: true }), metadataBodyStall: true };
  const metadataStall = await expectTimedFailure(
    () => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, timeoutMs: 40, githubToken: stallSecret }),
    { secret: stallSecret, tempRoot }
  );
  assert.equal(metadataStall.stage, "metadata");

  serverState.scenario = { ...normalScenario(origin, { githubDigests: true }), manifestBodyStall: true };
  const manifestStall = await expectTimedFailure(
    () => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, timeoutMs: 40, githubToken: stallSecret }),
    { secret: stallSecret, tempRoot }
  );
  assert.equal(manifestStall.stage, "manifest-download");

  serverState.scenario = { ...normalScenario(origin, { githubDigests: false }), checksumBodyStall: true };
  const checksumStall = await expectTimedFailure(
    () => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, timeoutMs: 40, githubToken: stallSecret }),
    { secret: stallSecret, tempRoot }
  );
  assert.equal(checksumStall.stage, "checksum-download");

  serverState.scenario = { ...normalScenario(origin, { githubDigests: true }), artifactBodyStall: true };
  const artifactStall = await expectTimedFailure(
    () => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, tempRoot, timeoutMs: 200, downloadTimeoutMs: 40, downloadArtifact: true, githubToken: stallSecret }),
    { secret: stallSecret, tempRoot }
  );
  assert.equal(artifactStall.stage, "artifact-download");
  assert.equal((await readdir(tempRoot)).length, 0, "artifact body timeout must remove its partial file and random temp directory");

  for (const status of [403, 429]) {
    serverState.scenario = { ...normalScenario(origin, { githubDigests: true }), metadataStatus: status };
    const secret = "ghp_SUPER_SECRET_SHOULD_NEVER_APPEAR";
    const error = await captureFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: endpoint, githubToken: secret }));
    const receipt = buildDiscoveryFailureReceipt(error);
    assert.equal(receipt.errorCode, "GITHUB_RATE_LIMIT");
    assert.equal(JSON.stringify(receipt).includes(secret), false, "GITHUB_TOKEN must never appear in receipts");
    assert.equal(receipt.network.rateLimit.remaining, 0);
  }

  const offlineError = await captureFailure(() => discoverCodexlessRelease({ currentRoot, platform: "win32", arch: "x64", testEndpoint: "http://127.0.0.1:1/releases", timeoutMs: 50 }));
  assert.equal(buildDiscoveryFailureReceipt(offlineError).errorCode, "NETWORK_OFFLINE");

  serverState.scenario = normalScenario(origin, { githubDigests: true, includeMac: true });
  const mac = await discoverCodexlessRelease({ currentRoot, platform: "darwin", arch: "arm64", testEndpoint: endpoint });
  assert.equal(mac.asset.name, `codexless-${targetVersion}-macos-arm64.tar.gz`);

  const releaseForAssets = serverState.scenario.releases[0];
  assert.equal(selectExactAsset(releaseForAssets, `codexless-${targetVersion}-macos-arm64.tar.gz`).name, `codexless-${targetVersion}-macos-arm64.tar.gz`);

  const discoverySource = await readFile(new URL("../src/release-discovery.mjs", import.meta.url), "utf8");
  const cliSource = await readFile(new URL("../scripts/check-release.mjs", import.meta.url), "utf8");
  for (const forbidden of ["install.ps1", "install.sh", "child_process", "spawn(", "exec("]) {
    assert.equal(`${discoverySource}\n${cliSource}`.includes(forbidden), false, `release discovery must not invoke installer/process machinery: ${forbidden}`);
  }

  await delay(0);
  assert.equal(unhandledRejections.length, 0, `release discovery must not leave unhandled rejections: ${unhandledRejections.map(String).join(" | ")}`);
  process.stdout.write(`release discovery PASS ${artifactSha}\n`);
} finally {
  process.off("unhandledRejection", onUnhandledRejection);
  server.close();
  await rm(tempRoot, { recursive: true, force: true });
  await rm(currentRoot, { recursive: true, force: true });
}

function normalScenario(origin, options = {}) {
  let manifestBytes = validTargetBytes;
  if (options.malformedManifest) manifestBytes = Buffer.from("{bad-manifest", "utf8");
  if (options.incompatibleState) {
    const incompatible = JSON.parse(validTargetBytes.toString("utf8"));
    incompatible.stateCompatibility.stores["recent-calls"].schemaVersion = 2;
    manifestBytes = Buffer.from(`${JSON.stringify(incompatible)}\n`, "utf8");
  }
  const manifestSha = sha256(manifestBytes);
  const naming = releaseAssetContract(targetVersion, "win32", "x64");
  const macNaming = releaseAssetContract(targetVersion, "darwin", "arm64");
  const artifactDigest = options.artifactDigest !== undefined
    ? options.artifactDigest
    : options.githubDigests ? `sha256:${artifactSha}` : null;
  const manifestDigest = options.manifestDigest !== undefined
    ? options.manifestDigest
    : options.githubDigests ? `sha256:${manifestSha}` : null;
  const assets = [];
  if (!options.omitArtifact) assets.push(asset(1, naming.artifactName, options.artifactSize ?? artifactBytes.length, artifactDigest, options.artifactUrl ?? `${origin}${options.artifactPath ?? "/artifact"}`, options.artifactState ?? "uploaded"));
  if (options.duplicateArtifact) assets.push(asset(2, naming.artifactName, artifactBytes.length, artifactDigest, `${origin}/artifact`));
  assets.push(asset(3, naming.manifestName, manifestBytes.length, manifestDigest, `${origin}/manifest`));
  if (!options.omitChecksumAsset) assets.push(asset(4, naming.checksumName, 300, null, `${origin}/checksums`));
  if (options.includeMac) assets.push(asset(5, macNaming.artifactName, artifactBytes.length, artifactDigest, `${origin}/artifact`));
  const checksumText = options.checksumText ?? `${artifactSha}  ${naming.artifactName}\n${manifestSha}  ${naming.manifestName}\n`;
  return {
    releases: [releaseFixture(targetVersion, { assets })],
    artifactBytes,
    manifestBytes,
    checksumText,
  };
}

function releaseFixture(version, { draft = false, prerelease = true, assets = [] } = {}) {
  return {
    id: Math.abs(version.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)),
    tag_name: `v${version}`,
    draft,
    prerelease,
    published_at: "2026-08-18T00:00:00Z",
    assets,
  };
}

function asset(id, name, size, digest, url, state = "uploaded") {
  return { id, name, size, digest, state, browser_download_url: url };
}

function makeManifest(version, hostContractVersion, sourceRevision) {
  const stateCompatibility = {
    migration: "none",
    stores: {
      "recent-calls": { schemaVersion: 1 },
      "agent-task-cards": { schemaVersion: 1 },
    },
  };
  const files = [{ path: "payload.bin", sha256: sha256(Buffer.from(`payload:${version}`, "utf8")) }];
  const identity = {
    manifestVersion: RELEASE_MANIFEST_VERSION,
    productId: RELEASE_PRODUCT_ID,
    version,
    sourceRevision,
    hostContractVersion,
    stateCompatibility,
    buildIdAlgorithm: RELEASE_BUILD_ID_ALGORITHM,
    fileHashAlgorithm: RELEASE_FILE_HASH_ALGORITHM,
  };
  return {
    ...identity,
    buildId: computeReleaseBuildId({ ...identity, files }),
    files,
  };
}

async function writeInstalledManifest(root, manifest) {
  await rm(path.join(root, "config"), { recursive: true, force: true });
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "release-manifest.json"), serializeReleaseManifest(manifest), "utf8");
}

async function expectFailure(task, codes) {
  const error = await captureFailure(task);
  assert.ok(codes.includes(error.code), `expected one of ${codes.join(", ")}, got ${error.code}: ${error.message}`);
  return error;
}

async function captureFailure(task) {
  try { await task(); }
  catch (error) { return error; }
  assert.fail("expected task to fail");
}

async function expectTimedFailure(task, { secret, tempRoot }) {
  const started = Date.now();
  const error = await captureFailure(task);
  const elapsed = Date.now() - started;
  assert.equal(error.code, "NETWORK_TIMEOUT", `expected NETWORK_TIMEOUT, got ${error.code}: ${error.message}`);
  assert.ok(elapsed < 1_000, `body-stall timeout must fail promptly; elapsed=${elapsed}ms`);
  const receipt = buildDiscoveryFailureReceipt(error);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(secret), false, "timeout receipt must not contain GITHUB_TOKEN");
  assert.equal(serialized.includes("http://") || serialized.includes("https://"), false, "timeout receipt must not contain URLs");
  assert.equal(serialized.includes(path.resolve(tempRoot)), false, "timeout receipt must not contain absolute temp paths");
  return error;
}

function sendBytes(res, bytes, status = 200) {
  const body = Buffer.from(bytes);
  res.writeHead(status, { "content-type": "application/octet-stream", "content-length": String(body.length) });
  res.end(body);
}

function sendPartialAndStall(res, bytes, contentType = "application/octet-stream") {
  res.writeHead(200, { "content-type": contentType });
  res.write(Buffer.from(bytes));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

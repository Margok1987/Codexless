import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUTO_CHECK_INTERVAL_MS,
  opportunisticCodexlessUpdateCheck,
  probeReleaseMetadata,
  readAutoCheckState,
} from "../src/public-update-check.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "codexless-auto-check-"));
const stateFile = path.join(root, "state", "update-check.json");
const currentRoot = path.join(root, "installed");
const t0 = Date.parse("2026-08-18T00:00:00.000Z");
let metadataCalls = 0;
let discoveryCalls = 0;

const metadataProbe = async ({ etag }) => {
  metadataCalls += 1;
  return etag ? { notModified: true, etag: '"fixture-v1"' } : { notModified: false, etag: '"fixture-v1"' };
};
const discovery = async () => {
  discoveryCalls += 1;
  return {
    ok: true,
    status: "update_available",
    current: { version: "0.1.1-preview.0" },
    latest: { version: "0.1.2-preview.0" },
  };
};

try {
  const first = await opportunisticCodexlessUpdateCheck({ now: t0, stateFile, currentRoot, metadataProbe, discovery });
  assert.equal(first.checked, true);
  assert.equal(first.network, true);
  assert.equal(first.status, "update_available");
  assert.equal(first.advisory?.latestVersion, "0.1.2-preview.0");
  assert.equal(metadataCalls, 1);
  assert.equal(discoveryCalls, 1);
  const persisted = await readAutoCheckState(stateFile);
  assert.equal(persisted.etag, '"fixture-v1"');

  const cached = await opportunisticCodexlessUpdateCheck({ now: t0 + 60 * 60 * 1000, stateFile, currentRoot, metadataProbe, discovery });
  assert.equal(cached.checked, false);
  assert.equal(cached.source, "cache");
  assert.equal(cached.network, false);
  assert.equal(metadataCalls, 1);
  assert.equal(discoveryCalls, 1);

  const expired = await opportunisticCodexlessUpdateCheck({ now: t0 + AUTO_CHECK_INTERVAL_MS + 1, stateFile, currentRoot, metadataProbe, discovery });
  assert.equal(expired.checked, true);
  assert.equal(metadataCalls, 2);
  assert.equal(discoveryCalls, 1, "304 must reuse cached discovery result");

  const beforeDisabled = metadataCalls + discoveryCalls;
  const disabled = await opportunisticCodexlessUpdateCheck({
    env: { CODEXLESS_AUTO_CHECK_DISABLED: "1" },
    now: t0 + AUTO_CHECK_INTERVAL_MS * 2,
    stateFile: path.join(root, "disabled.json"),
    currentRoot,
    metadataProbe,
    discovery,
  });
  assert.equal(disabled.source, "disabled");
  assert.equal(metadataCalls + discoveryCalls, beforeDisabled);

  for (const code of ["NETWORK_OFFLINE", "NETWORK_TIMEOUT", "GITHUB_RATE_LIMIT"]) {
    const neutral = await opportunisticCodexlessUpdateCheck({
      now: t0,
      stateFile: path.join(root, `${code}.json`),
      currentRoot,
      metadataProbe: async () => { const error = new Error(code); error.code = code; throw error; },
      discovery,
    });
    assert.equal(neutral.status, "check_failed");
    assert.equal(neutral.code, code);
    assert.equal(neutral.advisory, null);
  }

  const quiet = await opportunisticCodexlessUpdateCheck({
    now: t0,
    stateFile: path.join(root, "up-to-date.json"),
    currentRoot,
    metadataProbe: async () => ({ notModified: false, etag: '"quiet"' }),
    discovery: async () => ({ ok: true, status: "up_to_date", current: { version: "0.1.1-preview.0" }, latest: { version: "0.1.1-preview.0" } }),
  });
  assert.equal(quiet.advisory, null);

  await assert.rejects(
    () => probeReleaseMetadata({ testEndpoint: "https://example.com/releases", fetchImpl: async () => { throw new Error("must not fetch"); } }),
    (error) => error?.code === "TEST_ENDPOINT_REJECTED"
  );

  const source = await readFile(new URL("../src/public-update-check.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /bootstrap-updater|runBootstrapUpdate|install\.ps1|install\.sh/);
  process.stdout.write("public auto update check PASS first=network cached=zero-network expired=etag-revalidate mutation=0\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

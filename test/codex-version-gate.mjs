import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { acceptedCodexVersionsFor } from "../src/codex-authority-executor.mjs";
import { compareCodexVersions, selectNewestAcceptedVersionedCandidate, selectNewestVersionedCandidate } from "../src/codex-bin.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const windowsAccepted = acceptedCodexVersionsFor({ platform: "win32", arch: "x64" });
const macAccepted = acceptedCodexVersionsFor({ platform: "darwin", arch: "arm64" });

// Explicit allowlists remain available for narrow compatibility probes/tests,
// but the normal public runtime no longer requires a manual version-table update.
assert.ok(windowsAccepted.includes("0.148.0-alpha.15"));
assert.ok(macAccepted.includes("0.148.0-alpha.9"));
assert.deepEqual(acceptedCodexVersionsFor({ platform: "darwin", arch: "x64" }), []);
assert.deepEqual(acceptedCodexVersionsFor({ platform: "linux", arch: "x64" }), []);

assert.ok(compareCodexVersions("0.148.0-alpha.15", "0.148.0-alpha.9") > 0);
assert.ok(compareCodexVersions("0.148.0", "0.148.0-alpha.99") > 0);
assert.equal(
  selectNewestVersionedCandidate([
    { version: "0.148.0-alpha.9", path: "old" },
    { version: "0.148.0-alpha.15", path: "current" },
  ])?.path,
  "current"
);
assert.equal(
  selectNewestAcceptedVersionedCandidate([
    { version: "0.148.0-alpha.15", path: "accepted" },
    { version: "0.148.0-alpha.99", path: "newer-unaccepted" },
  ], windowsAccepted)?.path,
  "accepted",
  "an explicit narrow allowlist may still select the newest accepted installed build"
);

const [doctorSource, resolverSource, runtimeSource, authoritySource, codexBinSource] = await Promise.all([
  readFile(path.join(projectRoot, "scripts", "doctor.mjs"), "utf8"),
  readFile(path.join(projectRoot, "scripts", "resolve-codex.mjs"), "utf8"),
  readFile(path.join(projectRoot, "src", "public-runtime.mjs"), "utf8"),
  readFile(path.join(projectRoot, "src", "codex-authority-executor.mjs"), "utf8"),
  readFile(path.join(projectRoot, "src", "codex-bin.mjs"), "utf8"),
]);

assert.match(resolverSource, /resolveCodexExecutable\(\)/);
assert.doesNotMatch(resolverSource, /acceptedVersions:\s*ACCEPTED_CODEX_VERSIONS/);
assert.match(runtimeSource, /resolveCodexExecutable\(\{ env \}\)/);
assert.match(runtimeSource, /acceptedCodexVersions:\s*null/);
assert.doesNotMatch(runtimeSource, /acceptedVersions:\s*acceptedCodexVersions/);
assert.match(doctorSource, /resolveCodexExecutable\(\)/);
assert.match(doctorSource, /codex-contract-gate/);
assert.match(doctorSource, /acceptedCodexVersions:\s*null/);
assert.doesNotMatch(doctorSource, /codex-version-gate/);
assert.match(authoritySource, /acceptedCodexVersions = null/);
assert.match(authoritySource, /this\.#acceptedCodexVersions && !this\.#acceptedCodexVersions\.has/);
assert.match(codexBinSource, /newestInstalledCodexCandidate/);
assert.match(codexBinSource, /Codex Desktop is optional/i);
assert.match(codexBinSource, /codex-standalone-current/);
assert.match(codexBinSource, /npm-global-package/);

console.log("Codex contract-first compatibility gate and explicit narrow-allowlist fallback PASS");

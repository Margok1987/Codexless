import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { acceptedCodexVersionsFor } from "../src/codex-authority-executor.mjs";
import { compareCodexVersions, selectNewestVersionedCandidate } from "../src/codex-bin.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const windowsAccepted = acceptedCodexVersionsFor({ platform: "win32", arch: "x64" });
const macAccepted = acceptedCodexVersionsFor({ platform: "darwin", arch: "arm64" });

assert.deepEqual(windowsAccepted, ["0.147.0", "0.147.0-alpha.6.6", "0.148.0-alpha.9"]);
assert.deepEqual(macAccepted, ["0.148.0-alpha.9"]);
assert.deepEqual(acceptedCodexVersionsFor({ platform: "darwin", arch: "x64" }), []);
assert.deepEqual(acceptedCodexVersionsFor({ platform: "linux", arch: "x64" }), []);

for (const unsupported of ["0.149.0", "0.148.0-alpha.99"]) {
  assert.equal(windowsAccepted.includes(unsupported), false, `${unsupported} must remain fail-closed on Windows until re-validation`);
  assert.equal(macAccepted.includes(unsupported), false, `${unsupported} must remain fail-closed on macOS until re-validation`);
}

assert.ok(compareCodexVersions("0.148.0-alpha.9", "0.147.0-alpha.6.6") > 0);
assert.ok(compareCodexVersions("0.148.0", "0.148.0-alpha.99") > 0);
assert.equal(
  selectNewestVersionedCandidate([
    { version: "0.147.0-alpha.6.6", path: "old" },
    { version: "0.148.0-alpha.9", path: "current" },
  ])?.path,
  "current"
);

const [doctorSource, resolverSource, codexBinSource] = await Promise.all([
  readFile(path.join(projectRoot, "scripts", "doctor.mjs"), "utf8"),
  readFile(path.join(projectRoot, "scripts", "resolve-codex.mjs"), "utf8"),
  readFile(path.join(projectRoot, "src", "codex-bin.mjs"), "utf8"),
]);

assert.match(doctorSource, /resolveCodexExecutable\(\{ acceptedVersions: ACCEPTED_CODEX_VERSIONS \}\)/);
assert.match(doctorSource, /ACCEPTED_CODEX_VERSIONS\.includes\(parsedVersion\)/);
assert.match(doctorSource, /ACCEPTED_CODEX_VERSIONS\.join\(", "\)/);
assert.match(resolverSource, /resolveCodexExecutable\(\{ acceptedVersions: ACCEPTED_CODEX_VERSIONS \}\)/);
assert.match(codexBinSource, /newestInstalledCodexCandidate/);
assert.match(codexBinSource, /Codex Desktop is optional/i);
assert.match(codexBinSource, /codex-standalone-current/);
assert.match(codexBinSource, /npm-global-package/);

console.log("Codex version gate matrix and public consumer wiring PASS");

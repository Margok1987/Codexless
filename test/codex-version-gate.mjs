import assert from "node:assert/strict";
import path from "node:path";
import { CodexAuthorityExecutor } from "../src/codex-authority-executor.mjs";
import { compareCodexVersions, resolveCodexExecutable } from "../src/codex-bin.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const env = { ...process.env, CODEX_BIN: "" };
const resolved = await resolveCodexExecutable({ env });

assert.match(resolved.path, /codex(?:\.exe)?$/i);
assert.equal(typeof resolved.version, "string");
assert.ok(resolved.version.length > 0);
assert.ok(compareCodexVersions("0.148.0-alpha.9", "0.147.0") > 0);
assert.ok(compareCodexVersions("0.148.0", "0.148.0-alpha.99") > 0);

const cliOnly = await resolveCodexExecutable({
  env: {
    ...process.env,
    CODEX_BIN: "",
    CODEX_CLI_PATH: resolved.path,
    LOCALAPPDATA: "",
    USERPROFILE: "",
    APPDATA: "",
  },
});
assert.equal(path.resolve(cliOnly.path), path.resolve(resolved.path));
assert.equal(cliOnly.source, "CODEX_CLI_PATH");
assert.equal(cliOnly.version, resolved.version);

const explicitOverride = await resolveCodexExecutable({
  env: { ...process.env, CODEX_BIN: resolved.path },
});
assert.equal(path.resolve(explicitOverride.path), path.resolve(resolved.path));
assert.equal(explicitOverride.source, "CODEX_BIN");

const contractFirst = new CodexAuthorityExecutor({
  codexBin: resolved.path,
  defaultCwd: projectRoot,
  allowUntrustedReadOnlyBootstrap: true,
});
const contractValidation = await contractFirst.validate();
assert.equal(contractValidation.codexVersion, resolved.version);
assert.equal(contractValidation.versionPolicy, "contract");
assert.equal(contractValidation.acceptedCodexVersions, null);
assert.equal(contractValidation.compatibilityGate?.status, "pass");
assert.equal(contractValidation.compatibilityGate?.commandExecReadOnly, true);
assert.equal(contractValidation.compatibilityGate?.permissionProfile, ":read-only");

const explicitReject = new CodexAuthorityExecutor({
  codexBin: resolved.path,
  defaultCwd: projectRoot,
  acceptedCodexVersions: ["9.9.9-not-current"],
  allowUntrustedReadOnlyBootstrap: true,
});
await assert.rejects(
  () => explicitReject.validate(),
  /unsupported Codex CLI version.*Accepted versions: 9\.9\.9-not-current/is
);

const explicitAccept = new CodexAuthorityExecutor({
  codexBin: resolved.path,
  defaultCwd: projectRoot,
  acceptedCodexVersions: [resolved.version],
  allowUntrustedReadOnlyBootstrap: true,
});
const explicitValidation = await explicitAccept.validate();
assert.equal(explicitValidation.versionPolicy, "allowlist+contract");
assert.deepEqual(explicitValidation.acceptedCodexVersions, [resolved.version]);
assert.equal(explicitValidation.compatibilityGate?.status, "pass");

console.log(JSON.stringify({
  passed: true,
  resolved,
  checks: {
    dynamicResolution: true,
    cliOnlyResolutionWithoutDesktopPrerequisite: true,
    explicitCodexBinOverrideWins: true,
    contractFirstDefault: true,
    readOnlyCommandExecProbe: true,
    explicitNarrowAllowlistStillAvailable: true,
    untrustedScratchDoesNotRequirePersistentTrust: true,
  },
}, null, 2));

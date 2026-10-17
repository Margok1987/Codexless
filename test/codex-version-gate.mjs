import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAuthorityExecutor, normalizeCodexAuthorityProjection } from "../src/codex-authority-executor.mjs";
import { compareCodexVersions, resolveCodexExecutable } from "../src/codex-bin.mjs";
import { managedLaunchEnv } from "../src/codex-runtime-provider.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const projectionRoot = path.resolve(projectRoot);
for (const [sandboxMode, sandboxType, expectedProfile] of [
  ["read-only", "readOnly", ":read-only"],
  ["workspace-write", "workspaceWrite", ":workspace"],
  ["danger-full-access", "dangerFullAccess", ":danger-full-access"],
]) {
  const projected = normalizeCodexAuthorityProjection({
    started: { activePermissionProfile: null, cwd: projectionRoot, runtimeWorkspaceRoots: [projectionRoot], sandbox: { type: sandboxType } },
    effectiveConfig: { sandbox_mode: sandboxMode, approval_policy: "on-request" },
    allowedProfiles: new Set([":read-only", ":workspace", ":danger-full-access"]),
    authorityRoot: projectionRoot,
  });
  assert.equal(projected.profileId, expectedProfile);
  assert.equal(projected.provenance, "config/read:sandbox_mode+approval_policy");
}
assert.throws(() => normalizeCodexAuthorityProjection({
  started: { activePermissionProfile: null, cwd: projectionRoot, runtimeWorkspaceRoots: [projectionRoot], sandbox: { type: "dangerFullAccess" } },
  effectiveConfig: { sandbox_mode: "danger-full-access", approval_policy: "never" },
  allowedProfiles: new Set([":read-only", ":workspace", ":danger-full-access"]),
  authorityRoot: projectionRoot,
}), /capability gate failed closed/);

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

// Resolver discovery is intentionally host-native. Contract probes use a clean
// home so they cannot inherit real account state or mutate the host sandbox cache.
const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-version-gate-"));
try {
  const codexHome = path.join(stateRoot, "codex-home");
  await mkdir(codexHome);
  await writeFile(path.join(codexHome, "config.toml"),
    `approval_policy = "on-request"\nsandbox_mode = "read-only"\n[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "trusted"\n`);
  const launchEnv = managedLaunchEnv({ ...process.env, HOME: stateRoot, USERPROFILE: stateRoot }, codexHome);
  const contractFirst = new CodexAuthorityExecutor({
    codexBin: resolved.path,
    launchEnv,
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
    launchEnv,
    defaultCwd: projectRoot,
    allowUntrustedReadOnlyBootstrap: true,
    acceptedCodexVersions: ["9.9.9-not-current"],
  });
  await assert.rejects(
    () => explicitReject.validate(),
    /unsupported Codex CLI version.*Accepted versions: 9\.9\.9-not-current/is
  );

  const explicitAccept = new CodexAuthorityExecutor({
    codexBin: resolved.path,
    launchEnv,
    defaultCwd: projectRoot,
    allowUntrustedReadOnlyBootstrap: true,
    acceptedCodexVersions: [resolved.version],
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
    },
  }, null, 2));
} finally {
  await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

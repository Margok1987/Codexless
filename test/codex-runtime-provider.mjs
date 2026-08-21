import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { createDeferredBrowserAdapter } from "../src/deferred-browser-adapter.mjs";
import {
  CodexRuntimeProviderError,
  codexRuntimeSelection,
  createCodexRuntimeProvider,
  managedLoginJourney,
  managedLaunchEnv,
  managedPlatformPackageSpec,
} from "../src/codex-runtime-provider.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function resolvePinnedWinBinary() {
  const packageJson = require.resolve("@openai/codex-win32-x64/package.json");
  return path.join(path.dirname(packageJson), "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
}

function fakeSecretsEnv(extra = {}) {
  return {
    ...process.env,
    OPENAI_API_KEY: "must-not-flow",
    CODEX_API_KEY: "must-not-flow",
    AZURE_OPENAI_API_KEY: "must-not-flow",
    CODEX_BIN: "C:\\definitely-missing\\codex.exe",
    CODEX_CLI_PATH: "C:\\definitely-missing\\desktop-codex.exe",
    ...extra,
  };
}

test("runtime selection defaults to readiness-gated Recommended and rejects unknown lanes", () => {
  assert.equal(codexRuntimeSelection({}), "recommended");
  assert.equal(codexRuntimeSelection({ CODEXLESS_CODEX_RUNTIME: "managed" }), "managed");
  assert.throws(
    () => codexRuntimeSelection({ CODEXLESS_CODEX_RUNTIME: "fallback" }),
    (error) => error instanceof CodexRuntimeProviderError && error.code === "CODEX_RUNTIME_SELECTION_INVALID"
  );
});

test("managed launch env preserves Codexless product policy while stripping resolver/API-key overrides", () => {
  const productOverride = path.join(root, "_work", "managed-product-policy-marker.json");
  const env = managedLaunchEnv(
    fakeSecretsEnv({
      KEEP_ME: "yes",
      CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE: productOverride,
    }),
    path.join(root, "_work", "managed-home-test")
  );
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE, productOverride);
  assert.equal(env.CODEX_BIN, undefined);
  assert.equal(env.CODEX_CLI_PATH, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.AZURE_OPENAI_API_KEY, undefined);
  assert.match(env.CODEX_HOME, /managed-home-test$/i);
});

test("managed package pin and platform lock provenance are exact source inputs", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  let lockBytes;
  try {
    lockBytes = await readFile(path.join(root, "npm-shrinkwrap.json"), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    lockBytes = await readFile(path.join(root, "package-lock.json"), "utf8");
  }
  const lock = JSON.parse(lockBytes);
  assert.equal(pkg.dependencies?.["@openai/codex"], "0.147.0");
  assert.equal(lock.packages?.[""]?.dependencies?.["@openai/codex"], "0.147.0");
  const rootCodex = lock.packages?.["node_modules/@openai/codex"];
  assert.equal(rootCodex?.version, "0.147.0");
  assert.match(rootCodex?.integrity ?? "", /^sha512-/);
  const win = lock.packages?.["node_modules/@openai/codex-win32-x64"];
  assert.equal(win?.version, "0.147.0-win32-x64");
  assert.match(win?.integrity ?? "", /^sha512-/);
  assert.deepEqual(win?.os, ["win32"]);
  assert.deepEqual(win?.cpu, ["x64"]);
  const mac = lock.packages?.["node_modules/@openai/codex-darwin-arm64"];
  assert.equal(mac?.version, "0.147.0-darwin-arm64");
  assert.match(mac?.integrity ?? "", /^sha512-/);
  assert.deepEqual(mac?.os, ["darwin"]);
  assert.deepEqual(mac?.cpu, ["arm64"]);
  assert.deepEqual(managedPlatformPackageSpec({ platform: "win32", arch: "x64" }), {
    packageName: "@openai/codex-win32-x64",
    triple: "x86_64-pc-windows-msvc",
    executable: "codex.exe",
    versionSuffix: "win32-x64",
  });
  assert.deepEqual(managedPlatformPackageSpec({ platform: "darwin", arch: "arm64" }), {
    packageName: "@openai/codex-darwin-arm64",
    triple: "aarch64-apple-darwin",
    executable: "codex",
    versionSuffix: "darwin-arm64",
  });
});

test("managed provider resolves the exact supported-platform official native package and hard-blocks maintenance Managed model invocation", async (t) => {
  const platformSpec = managedPlatformPackageSpec();
  if (!platformSpec) {
    t.skip(`release Managed source probe does not support ${process.platform}/${process.arch}`);
    return;
  }
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "codexless-managed-runtime-"));
  const nativePackageJson = require.resolve(`${platformSpec.packageName}/package.json`);
  const expectedNative = path.join(path.dirname(nativePackageJson), "vendor", platformSpec.triple, "bin", platformSpec.executable);
  try {
    const provider = await createCodexRuntimeProvider({
      env: fakeSecretsEnv({
        CODEXLESS_CODEX_RUNTIME: "managed",
        CODEXLESS_MANAGED_CODEX_HOME: tempHome,
      }),
    });
    assert.equal(provider.selection, "managed");
    assert.equal(provider.modelFree.lane, "managed");
    assert.equal(provider.modelFree.version, "0.147.0");
    assert.equal(provider.modelFree.packageVersion, "0.147.0");
    assert.equal(path.resolve(provider.modelFree.bin).toLowerCase(), path.resolve(expectedNative).toLowerCase());
    assert.equal(provider.modelFree.platformPackageName, platformSpec.packageName);
    assert.equal(provider.modelFree.platformPackageVersion, `0.147.0-${platformSpec.versionSuffix}`);
    assert.equal(provider.modelFree.existingResolverUsed, false);
    assert.equal(provider.modelFree.launchEnv.CODEX_HOME, path.resolve(tempHome));
    assert.equal(provider.modelFree.launchEnv.CODEX_BIN, undefined);
    assert.equal(provider.modelFree.launchEnv.CODEX_CLI_PATH, undefined);
    assert.equal(provider.modelFree.launchEnv.OPENAI_API_KEY, undefined);
    assert.match(provider.modelFree.binarySha256, /^[a-f0-9]{64}$/);
    assert.equal(provider.browserLane, "existing");
    assert.equal(provider.formalAgentLane, "existing");
    assert.equal(provider.formalAgentAvailable, false);
    assert.equal(provider.managedModelInvocation, "blocked");
    assert.equal(provider.noSilentFallback, true);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Recommended pending readiness preserves Existing model-free behavior and Existing Formal Agent lane", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("explicit Windows binary fixture only applies on this host");
    return;
  }
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-recommended-pending-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const pinnedWin = resolvePinnedWinBinary();
  const provider = await createCodexRuntimeProvider({ env: { ...process.env, CODEX_BIN: pinnedWin }, stateRoot });
  assert.equal(provider.selection, "recommended");
  assert.equal(provider.activation, "existing_only_pending_managed");
  assert.equal(provider.modelFree.lane, "existing");
  assert.equal(provider.modelFree.bin.toLowerCase(), path.resolve(pinnedWin).toLowerCase());
  assert.equal(provider.modelFree.launchEnv, null);
  assert.equal(provider.modelFree.version, "0.147.0");
  assert.equal(provider.formalAgentLane, "existing");
  assert.equal(provider.formalAgentAvailable, true);
  assert.equal(provider.managedModelInvocation, "existing-lane");
});

test("managed Browser Existing seam is deferred and does not become a toolbox startup dependency", async () => {
  let browserFactoryCalls = 0;
  const browser = createDeferredBrowserAdapter({
    methods: ["status"],
    factory: async () => {
      browserFactoryCalls += 1;
      return { browser: { async status() { return { status: "ok" }; } }, async close() {} };
    },
  });
  assert.equal(browserFactoryCalls, 0);
  assert.deepEqual(await browser.status({}), { status: "ok" });
  assert.equal(browserFactoryCalls, 1);
  await browser.close();
});

test("managed login journey is sanitized and contains no auth URL/token material", () => {
  const journey = managedLoginJourney({ managedCodexHome: path.join(root, "managed-home") });
  const text = JSON.stringify(journey);
  assert.equal(journey.status, "login_required");
  assert.equal(journey.authType, "chatgpt");
  assert.doesNotMatch(text, /authUrl|accessToken|refreshToken|cookie|bearer/i);
  assert.match(journey.secretHandling, /does not read, copy, link, print, or export/i);
});

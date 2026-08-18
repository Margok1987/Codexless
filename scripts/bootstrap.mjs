import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildBootstrapFailureReceipt,
  runBootstrapUpdate,
} from "../src/bootstrap-updater.mjs";
import { defaultBootstrapRoot } from "../src/bootstrap-persistence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const inferredBootstrapRoot = inferBootstrapRoot(scriptDir);
const args = parseArgs(process.argv.slice(2));
const bootstrapRoot = process.env.CODEXLESS_BOOTSTRAP_ROOT
  ? path.resolve(process.env.CODEXLESS_BOOTSTRAP_ROOT)
  : inferredBootstrapRoot;
const installDir = args.installDir ?? defaultInstallDir();
const testOptions = testDiscoveryOptions();

try {
  const receipt = await runBootstrapUpdate({
    installDir,
    bootstrapRoot,
    verbose: args.verbose,
    tempRoot: testOptions.tempRoot ?? os.tmpdir(),
    stagingBase: testOptions.stagingBase ?? os.tmpdir(),
    stateRoot: testOptions.stateRoot ?? null,
    discoveryOptions: testOptions.discoveryOptions,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(buildBootstrapFailureReceipt(error, { verbose: args.verbose }), null, 2)}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = { installDir: null, verbose: false };
  let index = 0;
  if (argv[0] === "update") index = 1;
  else if (argv[0] && !argv[0].startsWith("-")) throw new Error("bootstrap command must be update");
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--install-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--install-dir requires a path");
      parsed.installDir = path.resolve(value);
      index += 1;
    } else if (arg === "--verbose") parsed.verbose = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: node run.mjs update [--install-dir <path>] [--verbose]\n");
      process.exit(0);
    } else throw new Error(`unknown bootstrap argument: ${arg}`);
  }
  return parsed;
}

function defaultInstallDir() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA is required for the default Windows install path");
    return path.join(localAppData, "Codexless");
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return path.join(os.homedir(), "Library", "Application Support", "Codexless", "app");
  }
  throw new Error(`unsupported bootstrap platform: ${process.platform}/${process.arch}`);
}

function inferBootstrapRoot(currentScriptDir) {
  const generationsDir = path.resolve(currentScriptDir, "..", "..");
  if (path.basename(generationsDir) === "generations") return path.dirname(generationsDir);
  return defaultBootstrapRoot();
}

function testDiscoveryOptions() {
  if (process.env.CODEXLESS_BOOTSTRAP_TEST_MODE !== "1") return { discoveryOptions: {} };
  const endpoint = process.env.CODEXLESS_BOOTSTRAP_TEST_ENDPOINT;
  if (!endpoint) throw new Error("CODEXLESS_BOOTSTRAP_TEST_ENDPOINT is required in bootstrap test mode");
  return {
    discoveryOptions: {
      testEndpoint: endpoint,
      githubToken: process.env.GITHUB_TOKEN ?? null,
      timeoutMs: integerEnv("CODEXLESS_BOOTSTRAP_TEST_TIMEOUT_MS", 2_000),
      downloadTimeoutMs: integerEnv("CODEXLESS_BOOTSTRAP_TEST_DOWNLOAD_TIMEOUT_MS", 2_000),
    },
    tempRoot: process.env.CODEXLESS_BOOTSTRAP_TEST_TEMP_ROOT ? path.resolve(process.env.CODEXLESS_BOOTSTRAP_TEST_TEMP_ROOT) : null,
    stagingBase: process.env.CODEXLESS_BOOTSTRAP_TEST_STAGING_ROOT ? path.resolve(process.env.CODEXLESS_BOOTSTRAP_TEST_STAGING_ROOT) : null,
    stateRoot: process.env.CODEXLESS_BOOTSTRAP_TEST_STATE_ROOT ? path.resolve(process.env.CODEXLESS_BOOTSTRAP_TEST_STATE_ROOT) : null,
  };
}

function integerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 300_000) throw new Error(`${name} is invalid`);
  return value;
}

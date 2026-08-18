import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  commitBootstrapGeneration,
  discardPreparedBootstrap,
  materializeInitialBootstrap,
  prepareBootstrapGeneration,
  validatePreparedBootstrapGeneration,
} from "../src/bootstrap-persistence.mjs";
import { readReleaseManifest } from "../src/release-identity.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const { command, args } = parseArgs(process.argv.slice(2));

try {
  if (command === "materialize") {
    const sourceRoot = args.sourceRoot ?? projectRoot;
    const manifest = await readReleaseManifest(sourceRoot);
    const pointer = await materializeInitialBootstrap({
      sourceRoot,
      bootstrapRoot: args.bootstrapRoot,
      buildId: manifest.buildId,
    });
    emit({ ok: true, buildId: pointer.buildId });
  } else if (command === "prepare") {
    const sourceRoot = args.sourceRoot ?? projectRoot;
    const buildId = args.buildId ?? (await readReleaseManifest(sourceRoot)).buildId;
    const prepared = await prepareBootstrapGeneration({ sourceRoot, bootstrapRoot: args.bootstrapRoot, buildId });
    emit({ ok: true, prepared: publicPrepared(prepared) });
  } else if (command === "validate") {
    const prepared = requiredPrepared(args);
    const validated = await validatePreparedBootstrapGeneration({ bootstrapRoot: args.bootstrapRoot, prepared });
    emit({ ok: true, prepared: publicPrepared(validated) });
  } else if (command === "commit") {
    const prepared = requiredPrepared(args);
    const validated = await validatePreparedBootstrapGeneration({ bootstrapRoot: args.bootstrapRoot, prepared });
    const pointer = await commitBootstrapGeneration({ bootstrapRoot: args.bootstrapRoot, prepared: validated });
    emit({ ok: true, buildId: pointer.buildId });
  } else if (command === "discard") {
    const discarded = await discardPreparedBootstrap(requiredPrepared(args));
    emit({ ok: true, discarded });
  } else {
    throw new Error(`unknown materialize-bootstrap command: ${command}`);
  }
} catch (error) {
  emit({
    ok: false,
    errorCode: typeof error?.code === "string" ? error.code : "BOOTSTRAP_MATERIALIZE_FAILED",
    error: safeMessage(error),
  });
  process.exitCode = 1;
}

function parseArgs(argv) {
  let command = "materialize";
  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    command = argv[0];
    index = 1;
  }
  const args = {
    sourceRoot: null,
    bootstrapRoot: null,
    buildId: null,
    pendingDir: null,
    reused: null,
  };
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-root" || arg === "--bootstrap-root" || arg === "--pending-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      args[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = path.resolve(value);
      index += 1;
    } else if (arg === "--build-id") {
      const value = argv[index + 1];
      if (!value) throw new Error("--build-id requires a SHA-256 build id");
      args.buildId = value.trim().toLowerCase();
      index += 1;
    } else if (arg === "--reused") {
      const value = argv[index + 1];
      if (value !== "true" && value !== "false") throw new Error("--reused must be true or false");
      args.reused = value === "true";
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write([
        "Usage:",
        "  node scripts/materialize-bootstrap.mjs [--source-root <release-root>] [--bootstrap-root <persistent-root>]",
        "  node scripts/materialize-bootstrap.mjs prepare [--source-root <release-root>] [--bootstrap-root <persistent-root>] [--build-id <sha256>]",
        "  node scripts/materialize-bootstrap.mjs validate|commit|discard --bootstrap-root <persistent-root> --build-id <sha256> --reused <true|false> [--pending-dir <path>]",
        "",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`unknown materialize-bootstrap argument: ${arg}`);
    }
  }
  return { command, args };
}

function requiredPrepared(args) {
  if (!args.buildId) throw new Error("--build-id is required");
  if (typeof args.reused !== "boolean") throw new Error("--reused is required");
  if (!args.reused && !args.pendingDir) throw new Error("--pending-dir is required when --reused=false");
  if (args.reused && args.pendingDir) throw new Error("--pending-dir must be omitted when --reused=true");
  return {
    buildId: args.buildId,
    pendingDir: args.reused ? null : args.pendingDir,
    reused: args.reused,
  };
}

function publicPrepared(prepared) {
  return {
    buildId: prepared.buildId,
    pendingDir: prepared.pendingDir ?? null,
    reused: Boolean(prepared.reused),
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeMessage(error) {
  return String(error instanceof Error ? error.message : error ?? "bootstrap materialize failed")
    .replace(/[A-Za-z]:\\[^\r\n]*/g, "<path>")
    .replace(/\/(?!\/)[^\r\n]*/g, "<path>")
    .slice(0, 1000);
}

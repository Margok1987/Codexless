import path from "node:path";
import process from "node:process";
import { resolveManagedRuntime } from "../src/codex-runtime-provider.mjs";
import {
  clearRuntimeInstallPreference,
  defaultCodexlessStateRoot,
  readRuntimeInstallPreference,
  readRuntimeRoutingState,
  writeRuntimeInstallPreference,
} from "../src/runtime-routing-policy.mjs";

await main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    errorCode: error?.code ?? "RUNTIME_INSTALL_STATE_FAILED",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "status") {
    const [preference, routingState] = await Promise.all([
      readRuntimeInstallPreference({ stateRoot: args.stateRoot }),
      readRuntimeRoutingState({ stateRoot: args.stateRoot }),
    ]);
    emit({
      ok: true,
      preference: {
        mode: preference.mode,
        persisted: preference.persisted,
        updatedAt: preference.updatedAt,
      },
      routing: {
        activation: routingState.activation,
        managedReady: routingState.managedReady,
        persisted: routingState.persisted,
        updatedAt: routingState.updatedAt,
      },
      stateRoot: args.stateRoot,
    });
    return;
  }

  if (args.command === "clear-mode") {
    const cleared = await clearRuntimeInstallPreference({ stateRoot: args.stateRoot });
    emit({ ok: true, action: "runtime-mode-preference-cleared", removed: cleared.removed, stateRoot: args.stateRoot });
    return;
  }

  if (args.command === "set-mode") {
    const preference = await writeRuntimeInstallPreference({ stateRoot: args.stateRoot, mode: args.mode });
    emit({ ok: true, action: "runtime-mode-preference-set", mode: preference.mode, stateRoot: args.stateRoot });
    return;
  }

  if (args.command === "verify-managed") {
    const runtime = await resolveManagedRuntime({ stateRoot: args.stateRoot });
    const routingState = await readRuntimeRoutingState({ stateRoot: args.stateRoot });
    emit({
      ok: true,
      action: "managed-runtime-provisioned",
      activationChanged: false,
      activation: routingState.activation,
      managedReady: routingState.managedReady,
      managed: {
        packageName: runtime.packageName,
        packageVersion: runtime.packageVersion,
        platformPackageName: runtime.platformPackageName,
        platformPackageVersion: runtime.platformPackageVersion,
        binarySha256: runtime.binarySha256,
        codexHome: runtime.codexHome,
        source: runtime.source,
      },
      officialLoginRequiredBeforeFirstDualActivation: !routingState.managedReady,
      noExistingCredentialCopy: true,
      noExistingCodexHomeCopy: true,
      noSilentFallback: true,
    });
    return;
  }

  throw new Error(`unknown runtime install state command: ${args.command}`);
}

function parseArgs(argv) {
  const command = argv[0] ?? "status";
  if (!["status", "set-mode", "clear-mode", "verify-managed"].includes(command)) usage();
  const parsed = {
    command,
    stateRoot: defaultCodexlessStateRoot(),
    mode: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--state-root") {
      const value = argv[index + 1];
      if (!value) usage("--state-root requires a path");
      parsed.stateRoot = path.resolve(value);
      index += 1;
    } else if (arg === "--mode") {
      const value = argv[index + 1];
      if (!value) usage("--mode requires recommended or existing");
      parsed.mode = value.toLowerCase();
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write([
        "Usage:",
        "  node scripts/runtime-install-state.mjs status [--state-root <path>]",
        "  node scripts/runtime-install-state.mjs set-mode --mode recommended|existing [--state-root <path>]",
        "  node scripts/runtime-install-state.mjs clear-mode [--state-root <path>]",
        "  node scripts/runtime-install-state.mjs verify-managed [--state-root <path>]",
        "",
        "Provisioning verifies the pinned Managed package/native binary and isolated Managed CODEX_HOME only.",
        "It never marks dual policy ready; only the official managed-login readiness path may do that.",
        "",
      ].join("\n"));
      process.exit(0);
    } else usage(`unknown argument: ${arg}`);
  }
  if (command === "set-mode" && !["recommended", "existing"].includes(parsed.mode)) {
    usage("set-mode requires --mode recommended or existing; Managed-only is not an installer option");
  }
  return parsed;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(message = null) {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(2);
}

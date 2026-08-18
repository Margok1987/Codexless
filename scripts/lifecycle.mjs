import process from "node:process";
import {
  LifecycleContractError,
  acquireInstallerLock,
  buildInstallerLockFailureReceipt,
  buildLifecycleFailureReceipt,
  buildLifecycleReceipt,
  buildOwnershipMarkerFailureReceipt,
  inspectLifecycle,
  readOwnershipMarkerForInstallDir,
  releaseInstallerLock,
  removeOwnershipMarkerForInstallDir,
  restoreOwnershipMarkerSnapshot,
  validateLifecycleReceipt,
  writeOwnershipMarker,
} from "../src/lifecycle-contract.mjs";

const { command, options } = parseArgs(process.argv.slice(2));

try {
  if (command === "preflight") {
    const installDir = options["install-dir"] ?? options["installed-root"] ?? null;
    const plan = await inspectLifecycle({
      targetRoot: requiredOption(options, "target-root"),
      installedRoot: options["installed-root"] ?? null,
      mode: options.mode ?? null,
      stateRoot: options["state-root"] ?? null,
      installDir,
    });
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } else if (command === "receipt") {
    const previousRoot = options["previous-root"] ?? null;
    const installDir = requiredOption(options, "install-dir");
    const plan = await inspectLifecycle({
      targetRoot: requiredOption(options, "target-root"),
      installedRoot: previousRoot,
      mode: options.mode ?? null,
      stateRoot: options["state-root"] ?? null,
      installDir,
    });
    const receipt = buildLifecycleReceipt({
      plan,
      installDir,
      doctorStatus: requiredOption(options, "doctor-status"),
      rollbackPerformed: boolOption(options, "rollback-performed", false),
      backupRetained: boolOption(options, "backup-retained", false),
      backupPath: options["backup-path"] ?? null,
    });
    validateLifecycleReceipt(receipt, { expectOk: true });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else if (command === "failure") {
    const receipt = buildLifecycleFailureReceipt({
      action: options.action ?? "install-failed",
      installDir: requiredOption(options, "install-dir"),
      errorStage: requiredOption(options, "error-stage"),
      errorCode: requiredOption(options, "error-code"),
      error: requiredOption(options, "error"),
      rollbackPerformed: boolOption(options, "rollback-performed", false),
      schemaCompatible: boolOption(options, "state-schema-compatible", false),
    });
    validateLifecycleReceipt(receipt, { expectOk: false });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else if (command === "lock-acquire") {
    const receipt = await acquireInstallerLock({
      stateRoot: options["state-root"] ?? null,
      installDir: requiredOption(options, "install-dir"),
      action: requiredOption(options, "action"),
      ownerPid: integerOption(options, "owner-pid", process.pid),
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else if (command === "lock-release") {
    const receipt = await releaseInstallerLock({
      stateRoot: options["state-root"] ?? null,
      nonce: requiredOption(options, "nonce"),
      ownerPid: integerOption(options, "owner-pid", process.pid),
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else if (command === "marker-write") {
    const marker = await writeOwnershipMarker({
      stateRoot: options["state-root"] ?? null,
      installDir: requiredOption(options, "install-dir"),
      buildId: requiredOption(options, "build-id"),
      version: requiredOption(options, "version"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...marker })}\n`);
  } else if (command === "marker-restore") {
    const marker = await restoreOwnershipMarkerSnapshot({
      stateRoot: options["state-root"] ?? null,
      installDir: requiredOption(options, "install-dir"),
      buildId: requiredOption(options, "build-id"),
      version: requiredOption(options, "version"),
      createdAt: requiredOption(options, "created-at"),
      updatedAt: requiredOption(options, "updated-at"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...marker })}\n`);
  } else if (command === "marker-delete") {
    const result = await removeOwnershipMarkerForInstallDir({
      stateRoot: options["state-root"] ?? null,
      installDir: requiredOption(options, "install-dir"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "marker-read-optional") {
    let marker = null;
    try {
      marker = await readOwnershipMarkerForInstallDir({
        stateRoot: options["state-root"] ?? null,
        installDir: requiredOption(options, "install-dir"),
      });
    } catch (error) {
      if (!(error instanceof LifecycleContractError)
        || !new Set(["REPAIR_OWNERSHIP_UNAVAILABLE", "REPAIR_OWNERSHIP_INVALID", "REPAIR_OWNERSHIP_MISMATCH"]).has(error.code)) throw error;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, marker })}\n`);
  } else {
    throw new Error(`unknown lifecycle command: ${command}`);
  }
} catch (error) {
  if (command === "lock-acquire" || command === "lock-release") {
    process.stdout.write(`${JSON.stringify(buildInstallerLockFailureReceipt(error))}\n`);
  } else if (command === "marker-write" || command === "marker-restore" || command === "marker-delete" || command === "marker-read-optional") {
    process.stdout.write(`${JSON.stringify(buildOwnershipMarkerFailureReceipt(error))}\n`);
  } else {
    const stage = error instanceof LifecycleContractError ? error.stage : "lifecycle-helper";
    const code = error instanceof LifecycleContractError ? error.code : "LIFECYCLE_HELPER_FAILED";
    const payload = buildLifecycleFailureReceipt({
      installDir: options["install-dir"] ?? options["installed-root"] ?? options["target-root"] ?? "<redacted>",
      errorStage: stage,
      errorCode: code,
      error: error instanceof Error ? error.message : String(error),
    });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  process.exitCode = 1;
}

function parseArgs(argv) {
  const command = argv[0] ?? "";
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected lifecycle argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = "true";
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function requiredOption(options, key) {
  const value = options[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required`);
  return value;
}

function boolOption(options, key, fallback) {
  const value = options[key];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${key} must be true or false`);
}

function integerOption(options, key, fallback) {
  const value = options[key];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`--${key} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${key} must be a positive integer`);
  return parsed;
}

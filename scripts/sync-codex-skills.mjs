import path from "node:path";
import process from "node:process";
import {
  checkBrowserRepairSkill,
  CodexSkillSyncError,
  finalizeBrowserRepairSkillSync,
  prepareBrowserRepairSkillSync,
  rollbackBrowserRepairSkillSync,
  syncBrowserRepairSkill,
} from "../src/codex-skill-sync.mjs";

const options = parseArgs(process.argv.slice(2));
try {
  let result;
  if (options.command === "check") result = checkBrowserRepairSkill(options);
  else if (options.command === "sync") result = syncBrowserRepairSkill(options);
  else if (options.command === "prepare") result = prepareBrowserRepairSkillSync(options);
  else if (options.command === "finalize") result = finalizeBrowserRepairSkillSync(options);
  else result = rollbackBrowserRepairSkillSync(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (options.command === "check" && result.action === "blocked") process.exitCode = 2;
} catch (error) {
  const value = error instanceof CodexSkillSyncError
    ? { ok: false, status: "blocked", errorCode: error.code, errorStage: error.stage, error: error.message }
    : { ok: false, status: "failed", errorCode: "CODEXLESS_SKILL_SYNC_FAILED", errorStage: "unknown", error: error instanceof Error ? error.message : String(error) };
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "check";
  if (!new Set(["check", "sync", "prepare", "finalize", "rollback"]).has(command)) usageError("command must be check, sync, prepare, finalize, or rollback");
  const parsed = { command, targetLane: "existing" };
  const rest = argv[0] === command ? argv.slice(1) : argv;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--codex-home") {
      const value = rest[index + 1];
      if (!value) usageError("--codex-home requires a path");
      parsed.codexHome = path.resolve(value);
      index += 1;
    } else if (arg === "--target-lane") {
      const value = rest[index + 1];
      if (!value) usageError("--target-lane requires existing");
      parsed.targetLane = value.toLowerCase();
      index += 1;
    } else if (arg === "--source-dir") {
      const value = rest[index + 1];
      if (!value) usageError("--source-dir requires a path");
      parsed.sourceDir = path.resolve(value);
      index += 1;
    } else if (arg === "--transaction-id") {
      const value = rest[index + 1];
      if (!value) usageError("--transaction-id requires a value");
      parsed.transactionId = value;
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write([
        "Usage:",
        "  node scripts/sync-codex-skills.mjs check|sync|prepare [--target-lane existing] [--codex-home <path>] [--source-dir <path>]",
        "  node scripts/sync-codex-skills.mjs finalize|rollback --transaction-id <id> [--codex-home <path>]",
        "",
        "Only the Codexless-owned codexless-browser-repair Skill is managed, and its target lane is Existing only.",
        "A same-name target without a valid Codexless ownership marker is never overwritten.",
        "prepare/finalize/rollback are the installer transaction hooks; sync is prepare+finalize for ordinary manual use.",
        "",
      ].join("\n"));
      process.exit(0);
    } else usageError(`unknown argument: ${arg}`);
  }
  if (parsed.targetLane !== "existing") usageError("Browser Repair target lane must be existing; Managed/Both are forbidden for this Skill");
  if (new Set(["finalize", "rollback"]).has(command) && !parsed.transactionId) usageError(`${command} requires --transaction-id`);
  return parsed;
}

function usageError(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

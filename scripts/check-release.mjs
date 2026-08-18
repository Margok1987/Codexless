import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildDiscoveryFailureReceipt,
  discoverCodexlessRelease,
} from "../src/release-discovery.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const args = parseArgs(process.argv.slice(2));

try {
  const receipt = await discoverCodexlessRelease({
    currentRoot: args.currentRoot ?? projectRoot,
    downloadArtifact: args.mode === "verify",
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(buildDiscoveryFailureReceipt(error), null, 2)}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = { mode: "check", currentRoot: null };
  if (argv[0] && !argv[0].startsWith("-")) {
    if (!new Set(["check", "verify"]).has(argv[0])) throw new Error("mode must be check or verify");
    parsed.mode = argv[0];
    argv = argv.slice(1);
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--current-root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--current-root requires a path");
      parsed.currentRoot = path.resolve(value);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: node scripts/check-release.mjs [check|verify] [--current-root <installed-root>]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown release discovery argument: ${arg}`);
    }
  }
  return parsed;
}

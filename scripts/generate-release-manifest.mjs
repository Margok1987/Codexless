import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  RELEASE_MANIFEST_RELATIVE_PATH,
  buildReleaseManifest,
  serializeReleaseManifest,
} from "../src/release-identity.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION } from "../src/surface-contracts.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const args = parseArgs(process.argv.slice(2));
const sourceRevision = args.sourceRevision ?? envRevision(process.env.CODEXLESS_SOURCE_REVISION);
const manifest = await buildReleaseManifest({
  root: projectRoot,
  serverVersion: PUBLIC_SERVER_VERSION,
  hostContractVersion: PUBLIC_SURFACE_VERSION,
  sourceRevision,
});
const serialized = serializeReleaseManifest(manifest);

if (args.stdout) {
  process.stdout.write(serialized);
} else {
  const target = path.join(projectRoot, ...RELEASE_MANIFEST_RELATIVE_PATH.split("/"));
  const temp = `${target}.tmp-${process.pid}`;
  await writeFile(temp, serialized, "utf8");
  await rename(temp, target);
  process.stdout.write(`${RELEASE_MANIFEST_RELATIVE_PATH}: ${manifest.version} ${manifest.buildId}\n`);
}

function parseArgs(argv) {
  const parsed = { stdout: false, sourceRevision: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdout") parsed.stdout = true;
    else if (arg === "--source-revision") {
      const value = argv[index + 1];
      if (!value) throw new Error("--source-revision requires a value");
      parsed.sourceRevision = value;
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: node scripts/generate-release-manifest.mjs [--source-revision <revision>] [--stdout]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown release manifest argument: ${arg}`);
    }
  }
  return parsed;
}

function envRevision(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

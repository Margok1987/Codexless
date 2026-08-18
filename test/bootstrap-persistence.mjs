import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_GENERATION_FILES,
  commitBootstrapGeneration,
  materializeInitialBootstrap,
  prepareBootstrapGeneration,
  readBootstrapPointer,
  validatePreparedBootstrapGeneration,
} from "../src/bootstrap-persistence.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const root = await mkdtemp(path.join(os.tmpdir(), "codexless-bootstrap-persistence-"));
const bootstrapRoot = path.join(root, "external-bootstrap");
const isolatedPrepareRoot = path.join(root, "prepare-only");
const sourceB = path.join(root, "source-b");
const buildA = "a".repeat(64);
const buildB = "b".repeat(64);

try {
  const prepareOnly = await prepareBootstrapGeneration({ sourceRoot: projectRoot, bootstrapRoot: isolatedPrepareRoot, buildId: buildA });
  assert.equal(prepareOnly.reused, false);
  assert.equal(await exists(path.join(isolatedPrepareRoot, "run.mjs")), false, "prepare-only must not create the stable launcher before commit");
  assert.equal(await exists(path.join(isolatedPrepareRoot, "current.json")), false, "prepare-only must not create or advance the pointer");
  assert.equal(await exists(path.join(isolatedPrepareRoot, "generations")), false, "prepare-only must write only an external .pending generation");
  const validatedPrepareOnly = await validatePreparedBootstrapGeneration({ bootstrapRoot: isolatedPrepareRoot, prepared: prepareOnly });
  assert.equal(validatedPrepareOnly.buildId, buildA);
  await rm(prepareOnly.pendingDir, { recursive: true, force: true });

  const pointerA = await materializeInitialBootstrap({ sourceRoot: projectRoot, bootstrapRoot, buildId: buildA });
  assert.equal(pointerA.buildId, buildA);
  const launcherPath = path.join(bootstrapRoot, "run.mjs");
  const launcherBefore = await readFile(launcherPath, "utf8");
  const currentAPath = path.join(bootstrapRoot, "generations", buildA, "scripts", "bootstrap.mjs");
  const currentABytes = await readFile(currentAPath, "utf8");

  for (const relative of BOOTSTRAP_GENERATION_FILES) {
    const from = path.join(projectRoot, ...relative.split("/"));
    const to = path.join(sourceB, ...relative.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  await writeFile(path.join(sourceB, "scripts", "bootstrap.mjs"), `${await readFile(path.join(sourceB, "scripts", "bootstrap.mjs"), "utf8")}\n// generation-b-marker\n`, "utf8");

  const prepared = await prepareBootstrapGeneration({ sourceRoot: sourceB, bootstrapRoot, buildId: buildB });
  assert.equal(prepared.reused, false);
  assert.equal((await readBootstrapPointer(bootstrapRoot)).buildId, buildA, "prepare must not switch the running/current bootstrap pointer");
  assert.equal(await readFile(currentAPath, "utf8"), currentABytes, "prepare must not overwrite the currently executing generation");
  assert.equal(await readFile(launcherPath, "utf8"), launcherBefore, "stable launcher must not be overwritten during generation prepare");

  const pointerB = await commitBootstrapGeneration({ bootstrapRoot, prepared });
  assert.equal(pointerB.buildId, buildB);
  assert.equal((await readBootstrapPointer(bootstrapRoot)).buildId, buildB);
  assert.match(await readFile(path.join(bootstrapRoot, "generations", buildB, "scripts", "bootstrap.mjs"), "utf8"), /generation-b-marker/);
  assert.equal(await readFile(currentAPath, "utf8"), currentABytes, "committing a new generation must leave the previous generation byte-for-byte intact");
  assert.equal(await readFile(launcherPath, "utf8"), launcherBefore, "generation commit must atomically switch only current.json, not rewrite run.mjs");

  const duplicatePrepared = await prepareBootstrapGeneration({ sourceRoot: sourceB, bootstrapRoot, buildId: buildB });
  assert.equal(duplicatePrepared.reused, true, "existing generation should use idempotent reuse semantics");
  const pointerB2 = await commitBootstrapGeneration({ bootstrapRoot, prepared: duplicatePrepared });
  assert.deepEqual(pointerB2, pointerB, "same-build commit must be idempotent and leave the pointer unchanged");

  const repeated = await materializeInitialBootstrap({ sourceRoot: projectRoot, bootstrapRoot, buildId: "c".repeat(64) });
  assert.equal(repeated.buildId, buildB, "initial materialize hook must not silently replace an already configured bootstrap generation");

  process.stdout.write("bootstrap persistence PASS\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function exists(target) {
  return Boolean(await stat(target).catch(() => null));
}

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkBrowserRepairSkill,
  CODEXLESS_BROWSER_REPAIR_SKILL,
  CODEXLESS_BROWSER_REPAIR_TARGET_LANE,
  CODEXLESS_MANAGED_SKILL_MARKER,
  CodexSkillSyncError,
  defaultBrowserRepairSkillSource,
  defaultCodexHome,
  finalizeBrowserRepairSkillSync,
  prepareBrowserRepairSkillSync,
  rollbackBrowserRepairSkillSync,
  syncBrowserRepairSkill,
} from "../src/codex-skill-sync.mjs";

function withFixture(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "codexless-skill-sync-"));
  const codexHome = path.join(root, "codex-home");
  const sourceDir = path.join(root, "source", CODEXLESS_BROWSER_REPAIR_SKILL);
  cpSync(defaultBrowserRepairSkillSource(), sourceDir, { recursive: true });
  try {
    return fn({ root, codexHome, sourceDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function targetDir(codexHome) {
  return path.join(codexHome, "skills", CODEXLESS_BROWSER_REPAIR_SKILL);
}

test("default Codex Home honors CODEX_HOME and otherwise stays user-local", () => {
  assert.equal(defaultCodexHome({ CODEX_HOME: "C:\\tmp\\codex-home" }), path.resolve("C:\\tmp\\codex-home"));
  assert.match(defaultCodexHome({}), /[\\/]\.codex$/i);
});

test("Browser Repair is mechanically Existing-specific and refuses the Managed home", () => {
  withFixture(({ root, sourceDir }) => {
    const managedHome = path.join(root, "managed-codex-home");
    assert.equal(CODEXLESS_BROWSER_REPAIR_TARGET_LANE, "existing");
    assert.throws(
      () => checkBrowserRepairSkill({ codexHome: managedHome, managedCodexHome: managedHome, sourceDir }),
      (error) => error instanceof CodexSkillSyncError && error.code === "CODEXLESS_SKILL_MANAGED_HOME_FORBIDDEN"
    );
    assert.throws(
      () => checkBrowserRepairSkill({ codexHome: path.join(root, "existing"), managedCodexHome: managedHome, sourceDir, targetLane: "managed" }),
      (error) => error instanceof CodexSkillSyncError && error.code === "CODEXLESS_SKILL_LANE_UNSUPPORTED"
    );
  });
});

test("fresh sync installs only the Codexless Browser Repair Skill and second sync is a no-op", () => {
  withFixture(({ codexHome, sourceDir }) => {
    const unrelated = path.join(codexHome, "skills", "user-skill", "SKILL.md");
    mkdirSync(path.dirname(unrelated), { recursive: true });
    writeFileSync(unrelated, "user-owned\n", "utf8");

    const before = checkBrowserRepairSkill({ codexHome, sourceDir });
    assert.equal(before.status, "missing");
    assert.equal(before.action, "install");

    const installed = syncBrowserRepairSkill({ codexHome, sourceDir });
    assert.equal(installed.status, "current");
    assert.equal(installed.targetLane, "existing");
    assert.equal(installed.changed, true);
    assert.equal(readFileSync(unrelated, "utf8"), "user-owned\n");
    assert.equal(
      readFileSync(path.join(targetDir(codexHome), "SKILL.md"), "utf8"),
      readFileSync(path.join(sourceDir, "SKILL.md"), "utf8")
    );
    const marker = JSON.parse(readFileSync(path.join(targetDir(codexHome), CODEXLESS_MANAGED_SKILL_MARKER), "utf8"));
    assert.equal(marker.product, "codexless");
    assert.equal(marker.skill, CODEXLESS_BROWSER_REPAIR_SKILL);
    assert.match(marker.contentHash, /^[0-9a-f]{64}$/);

    const second = syncBrowserRepairSkill({ codexHome, sourceDir });
    assert.equal(second.status, "current");
    assert.equal(second.changed, false);
    assert.equal(readFileSync(unrelated, "utf8"), "user-owned\n");
  });
});

test("Codexless-owned Skill updates atomically when canonical Skill content changes", () => {
  withFixture(({ codexHome, sourceDir }) => {
    const first = syncBrowserRepairSkill({ codexHome, sourceDir });
    const firstHash = first.sourceHash;
    const sourceSkill = path.join(sourceDir, "SKILL.md");
    writeFileSync(sourceSkill, `${readFileSync(sourceSkill, "utf8")}\n<!-- fixture update -->\n`, "utf8");

    const pending = checkBrowserRepairSkill({ codexHome, sourceDir });
    assert.equal(pending.status, "update_available");
    assert.equal(pending.action, "update");
    assert.notEqual(pending.sourceHash, firstHash);

    const updated = syncBrowserRepairSkill({ codexHome, sourceDir });
    assert.equal(updated.status, "current");
    assert.equal(updated.changed, true);
    assert.equal(updated.previousStatus, "update_available");
    assert.match(readFileSync(path.join(targetDir(codexHome), "SKILL.md"), "utf8"), /fixture update/);
  });
});

test("same-name user-owned Skill fails closed and is never overwritten", () => {
  withFixture(({ codexHome, sourceDir }) => {
    const target = targetDir(codexHome);
    mkdirSync(target, { recursive: true });
    const userSkill = path.join(target, "SKILL.md");
    writeFileSync(userSkill, "user-owned same-name skill\n", "utf8");

    const check = checkBrowserRepairSkill({ codexHome, sourceDir });
    assert.equal(check.status, "conflict");
    assert.equal(check.action, "blocked");
    assert.equal(check.reason, "target-not-owned-by-codexless");

    assert.throws(
      () => syncBrowserRepairSkill({ codexHome, sourceDir }),
      (error) => error instanceof CodexSkillSyncError && error.code === "CODEXLESS_SKILL_TARGET_CONFLICT"
    );
    assert.equal(readFileSync(userSkill, "utf8"), "user-owned same-name skill\n");
    assert.equal(existsSync(path.join(target, CODEXLESS_MANAGED_SKILL_MARKER)), false);
  });
});

test("locally edited managed Skill is treated as drift and preserved", () => {
  withFixture(({ codexHome, sourceDir }) => {
    syncBrowserRepairSkill({ codexHome, sourceDir });
    const installedSkill = path.join(targetDir(codexHome), "SKILL.md");
    writeFileSync(installedSkill, `${readFileSync(installedSkill, "utf8")}\nlocal edit\n`, "utf8");

    const check = checkBrowserRepairSkill({ codexHome, sourceDir });
    assert.equal(check.status, "drifted");
    assert.equal(check.action, "blocked");
    assert.equal(check.reason, "managed-skill-content-changed-outside-sync");

    assert.throws(
      () => syncBrowserRepairSkill({ codexHome, sourceDir }),
      (error) => error instanceof CodexSkillSyncError && error.code === "CODEXLESS_SKILL_TARGET_CONFLICT"
    );
    assert.match(readFileSync(installedSkill, "utf8"), /local edit/);
  });
});

test("installer transaction rollback removes a fresh prepared Skill", () => {
  withFixture(({ codexHome, sourceDir }) => {
    const prepared = prepareBrowserRepairSkillSync({ codexHome, sourceDir });
    assert.equal(prepared.transactionStatus, "prepared");
    assert.equal(existsSync(targetDir(codexHome)), true);
    const rolledBack = rollbackBrowserRepairSkillSync({ codexHome, transactionId: prepared.transactionId });
    assert.equal(rolledBack.transactionStatus, "rolled_back");
    assert.equal(rolledBack.status, "missing");
    assert.equal(existsSync(targetDir(codexHome)), false);
  });
});

test("installer transaction rollback restores the previous managed Skill on update", () => {
  withFixture(({ codexHome, sourceDir }) => {
    syncBrowserRepairSkill({ codexHome, sourceDir });
    const installedSkill = path.join(targetDir(codexHome), "SKILL.md");
    const oldText = readFileSync(installedSkill, "utf8");
    const sourceSkill = path.join(sourceDir, "SKILL.md");
    writeFileSync(sourceSkill, `${readFileSync(sourceSkill, "utf8")}\n<!-- transaction update -->\n`, "utf8");
    const prepared = prepareBrowserRepairSkillSync({ codexHome, sourceDir });
    assert.match(readFileSync(installedSkill, "utf8"), /transaction update/);
    rollbackBrowserRepairSkillSync({ codexHome, transactionId: prepared.transactionId });
    assert.equal(readFileSync(installedSkill, "utf8"), oldText);
    assert.equal(checkBrowserRepairSkill({ codexHome, sourceDir }).status, "update_available");
  });
});

test("installer transaction finalize keeps the prepared Skill and removes rollback state", () => {
  withFixture(({ codexHome, sourceDir }) => {
    const prepared = prepareBrowserRepairSkillSync({ codexHome, sourceDir });
    const finalized = finalizeBrowserRepairSkillSync({ codexHome, transactionId: prepared.transactionId });
    assert.equal(finalized.transactionStatus, "finalized");
    assert.equal(checkBrowserRepairSkill({ codexHome, sourceDir }).status, "current");
    assert.throws(
      () => rollbackBrowserRepairSkillSync({ codexHome, transactionId: prepared.transactionId }),
      (error) => error instanceof CodexSkillSyncError && error.code === "CODEXLESS_SKILL_TRANSACTION_INVALID"
    );
  });
});

test("package contract ships the Skill source and exposes explicit check/sync scripts", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.files.includes("skills"), true);
  assert.equal(packageJson.scripts["skills:check"], "node scripts/sync-codex-skills.mjs check");
  assert.equal(packageJson.scripts["skills:sync"], "node scripts/sync-codex-skills.mjs sync");
  const refreshTest = existsSync(new URL("./public-skill-refresh.mjs", import.meta.url))
    ? "test/public-skill-refresh.mjs"
    : "test/codex-skill-refresh.mjs";
  assert.equal(packageJson.scripts["test:skills"], `node --test test/codex-skill-sync.mjs ${refreshTest}`);
  const lanePolicy = JSON.parse(readFileSync(new URL("../config/skill-lane-policy.json", import.meta.url), "utf8"));
  assert.equal(lanePolicy.productOwnedSkills[CODEXLESS_BROWSER_REPAIR_SKILL].target, "existing");
  assert.equal(lanePolicy.privateExistingSkillSyncToManaged, "disabled-by-default");
});

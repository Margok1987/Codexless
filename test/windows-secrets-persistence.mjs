import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  process.stdout.write("Windows secrets persistence contract SKIP (not win32)\n");
  process.exit(0);
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const installer = path.join(projectRoot, "scripts", "install.ps1");
const source = await readFile(installer, "utf8");
const root = await mkdtemp(path.join(os.tmpdir(), "codexless-secrets-contract-"));
const probe = path.join(root, "probe.ps1");

try {
  const prepareCall = source.indexOf("\n  Prepare-PersistentSecrets\n");
  const backupCall = source.indexOf("\n    Move-Item -LiteralPath $InstallDir -Destination $BackupDir\n");
  const activateCall = source.indexOf("\n    Move-Item -LiteralPath $StageDir -Destination $InstallDir\n");
  const mountCall = source.indexOf("\n    Mount-PersistentSecrets\n");
  const doctorCall = source.indexOf("\n    $installedDoctor = Run-DoctorJson -Root $InstallDir -Node $node\n");
  assert.ok(prepareCall >= 0 && prepareCall < backupCall, "secrets must leave the replaceable install tree before backup rotation");
  assert.ok(activateCall >= 0 && activateCall < mountCall && mountCall < doctorCall, "persistent secrets junction must mount after activation and before installed doctor");

  const script = String.raw`
param([string]$InstallerPath, [string]$Root)
$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | ForEach-Object Message | Out-String) }
$names = @(
  "Normalize-LocalPath",
  "Get-SecretsLinkTarget",
  "Get-SecretsPreState",
  "Remove-SecretsCompatibilityLink",
  "Prepare-PersistentSecrets",
  "Mount-PersistentSecrets",
  "Dismount-PersistentSecrets",
  "Restore-PersistentSecretsPreState"
)
foreach ($name in $names) {
  $fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $fn) { throw "missing installer function: $name" }
  Invoke-Expression $fn.Extent.Text
}

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Reset-Scenario([string]$Name) {
  $base = Join-Path $Root $Name
  $script:InstallDir = Join-Path $base "Codexless"
  $script:StateRoot = Join-Path $base "home\.config\codexless"
  $script:PersistentSecretsDir = Join-Path $StateRoot "secrets"
  $script:InstallSecretsDir = Join-Path $InstallDir "secrets"
  $script:SecretsPreState = "absent"
  $script:SecretsPrepared = $false
  $script:SecretsMounted = $false
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

Reset-Scenario "legacy"
$legacyFile = Join-Path $InstallSecretsDir "homelab\fixture.secret"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $legacyFile) | Out-Null
[IO.File]::WriteAllText($legacyFile, "harmless-fixture")
Prepare-PersistentSecrets
Assert-True ($SecretsPreState -eq "legacy-directory") "legacy directory was not classified"
Assert-True (-not (Test-Path -LiteralPath $InstallSecretsDir)) "legacy secrets remained in install tree after prepare"
Assert-True (Test-Path -LiteralPath (Join-Path $PersistentSecretsDir "homelab\fixture.secret")) "legacy secret fixture was not migrated"
Mount-PersistentSecrets
Assert-True $SecretsMounted "persistent secrets junction was not mounted"
Assert-True ((Get-SecretsPreState) -eq "persistent-junction") "mounted compatibility path is not the expected junction"
Assert-True ([IO.File]::ReadAllText($legacyFile) -eq "harmless-fixture") "compatibility path did not preserve legacy access"
Dismount-PersistentSecrets
Restore-PersistentSecretsPreState
Assert-True (Test-Path -LiteralPath $legacyFile) "legacy rollback did not restore original path"
Assert-True (-not (Test-Path -LiteralPath $PersistentSecretsDir)) "legacy rollback left migrated state behind"

Reset-Scenario "junction"
$persistentFile = Join-Path $PersistentSecretsDir "homelab\fixture.secret"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $persistentFile) | Out-Null
[IO.File]::WriteAllText($persistentFile, "harmless-fixture")
New-Item -ItemType Junction -Path $InstallSecretsDir -Target $PersistentSecretsDir | Out-Null
Prepare-PersistentSecrets
Assert-True ($SecretsPreState -eq "persistent-junction") "existing junction was not classified"
Assert-True (-not (Test-Path -LiteralPath $InstallSecretsDir)) "existing compatibility junction was not detached before backup"
Mount-PersistentSecrets
Dismount-PersistentSecrets
Restore-PersistentSecretsPreState
Assert-True ((Get-SecretsPreState) -eq "persistent-junction") "junction rollback did not restore compatibility path"
Assert-True ([IO.File]::ReadAllText((Join-Path $InstallSecretsDir "homelab\fixture.secret")) -eq "harmless-fixture") "junction rollback changed fixture data"

Reset-Scenario "absent-with-persistent"
$persistentFile = Join-Path $PersistentSecretsDir "homelab\fixture.secret"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $persistentFile) | Out-Null
[IO.File]::WriteAllText($persistentFile, "harmless-fixture")
Prepare-PersistentSecrets
Assert-True ($SecretsPreState -eq "absent") "absent prestate was not preserved"
Mount-PersistentSecrets
Dismount-PersistentSecrets
Restore-PersistentSecretsPreState
Assert-True (-not (Test-Path -LiteralPath $InstallSecretsDir)) "absent rollback unexpectedly created a compatibility path"
Assert-True (Test-Path -LiteralPath $persistentFile) "absent rollback removed pre-existing persistent state"

Reset-Scenario "conflict"
$legacyFile = Join-Path $InstallSecretsDir "legacy.fixture"
$persistentFile = Join-Path $PersistentSecretsDir "persistent.fixture"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $legacyFile) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $persistentFile) | Out-Null
[IO.File]::WriteAllText($legacyFile, "legacy")
[IO.File]::WriteAllText($persistentFile, "persistent")
$conflict = $false
try { Prepare-PersistentSecrets } catch { $conflict = $_.Exception.Message -like "Both legacy install secrets*" }
Assert-True $conflict "conflicting legacy and persistent state did not fail closed"
Assert-True (Test-Path -LiteralPath $legacyFile) "conflict handling changed legacy data"
Assert-True (Test-Path -LiteralPath $persistentFile) "conflict handling changed persistent data"

[ordered]@{ ok = $true; scenarios = @("legacy", "junction", "absent-with-persistent", "conflict") } | ConvertTo-Json -Compress
`;

  await writeFile(probe, script, "utf8");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probe, "-InstallerPath", installer, "-Root", root],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.scenarios, ["legacy", "junction", "absent-with-persistent", "conflict"]);
  process.stdout.write("Windows secrets persistence contract PASS\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

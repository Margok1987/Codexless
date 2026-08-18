[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Codexless"),
  [switch]$Repair,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$SourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$StateRoot = Join-Path $HOME ".config\codexless"
$BootstrapRoot = if ($env:CODEXLESS_BOOTSTRAP_ROOT) { [System.IO.Path]::GetFullPath($env:CODEXLESS_BOOTSTRAP_ROOT) } else { Join-Path $StateRoot "bootstrap" }
$ParentDir = Split-Path -Parent $InstallDir
$StageDir = Join-Path $ParentDir ("Codexless-stage-" + [guid]::NewGuid().ToString("N"))
$PreviousBackupDir = Join-Path $ParentDir "Codexless-previous"
$PreviousBackupStashDir = $null
$BackupDir = $null
$Installed = $false
$HadExistingInstall = $false
$RollbackPerformed = $false
$StateSchemaCompatible = $false
$LifecycleMode = if ($Repair) { "repair" } else { "install" }
$LifecycleAction = if ($Repair) { "repair-failed" } else { "install-failed" }
$ErrorStage = "preflight"
$ErrorCode = "INSTALL_FAILED"
$node = $null
$SuccessReceipt = $null
$ActivationLock = $null
$BootstrapPrepared = $null
$MarkerWritten = $false
$PreviousMarker = $null
$TransactionCommitted = $false

function Invoke-Checked {
  param(
    [Parameter(Mandatory=$true)][string]$Command,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
  }
}

function Read-JsonCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Command,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
  )
  $text = (& $Command @Arguments | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    try { return ($text | ConvertFrom-Json) } catch { throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')`n$text" }
  }
  return ($text | ConvertFrom-Json)
}

function Get-RequiredCommand {
  param([Parameter(Mandatory=$true)][string[]]$Names, [Parameter(Mandatory=$true)][string]$Label)
  foreach ($name in $Names) {
    $found = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
  }
  throw "$Label was not found on PATH."
}

function Assert-Node22 {
  param([Parameter(Mandatory=$true)][string]$Node)
  $version = (& $Node -p "process.versions.node").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $version) { throw "Unable to read Node.js version." }
  $major = [int]($version.Split('.')[0])
  if ($major -lt 22) { throw "Codexless requires Node.js 22+. Current: v$version" }
  return $version
}

function Copy-ReleaseTree {
  param([Parameter(Mandatory=$true)][string]$From, [Parameter(Mandatory=$true)][string]$To)
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  $entries = @(
    "src", "config", "scripts", "bin",
    "package.json",
    "README.md", "README.zh-CN.md", "SECURITY.md", "EXPORT_SYNC.md",
    "THIRD_PARTY_NOTICES.md", "LICENSE"
  )
  foreach ($entry in $entries) {
    $source = Join-Path $From $entry
    if (-not (Test-Path -LiteralPath $source)) { throw "Release source is missing required entry: $entry" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $To $entry) -Recurse -Force
  }

  $shrinkwrap = Join-Path $From "npm-shrinkwrap.json"
  $packageLock = Join-Path $From "package-lock.json"
  $selfDeletingBatchWrapper = Join-Path $To "bin\codexless-uninstall.cmd"
  if (Test-Path -LiteralPath $selfDeletingBatchWrapper) {
    Remove-Item -LiteralPath $selfDeletingBatchWrapper -Force
  }

  if (Test-Path -LiteralPath $shrinkwrap) {
    Copy-Item -LiteralPath $shrinkwrap -Destination (Join-Path $To "npm-shrinkwrap.json") -Force
  } elseif (Test-Path -LiteralPath $packageLock) {
    Copy-Item -LiteralPath $packageLock -Destination (Join-Path $To "package-lock.json") -Force
  } else {
    throw "Release source is missing a frozen npm lockfile: npm-shrinkwrap.json or package-lock.json"
  }
}

function Run-DoctorJson {
  param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Node)
  $doctor = Join-Path $Root "scripts\doctor.mjs"
  $text = (& $Node $doctor --json | Out-String).Trim()
  $exit = $LASTEXITCODE
  if (-not $text) { throw "Codexless doctor returned no output." }
  $parsed = $text | ConvertFrom-Json
  if ($exit -ne 0 -or $parsed.status -eq "error") {
    throw "Codexless doctor failed in $Root.`n$text"
  }
  return $parsed
}

function Release-ActivationLock {
  if (-not $ActivationLock) { return }
  $release = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "lock-release" "--state-root" $StateRoot "--nonce" ([string]$ActivationLock.nonce) "--owner-pid" ([string]$PID)
  if (-not $release.ok) { throw ([string]$release.error) }
  $script:ActivationLock = $null
}

function Get-BootstrapPreparedArgs {
  if (-not $BootstrapPrepared) { throw "Bootstrap prepared generation is unavailable." }
  $args = @(
    "--bootstrap-root", $BootstrapRoot,
    "--build-id", ([string]$BootstrapPrepared.buildId),
    "--reused", ($(if ($BootstrapPrepared.reused) { "true" } else { "false" }))
  )
  if (-not $BootstrapPrepared.reused) { $args += @("--pending-dir", ([string]$BootstrapPrepared.pendingDir)) }
  return $args
}

function Discard-BootstrapPrepared {
  if (-not $BootstrapPrepared) { return }
  $args = @((Join-Path $SourceRoot "scripts\materialize-bootstrap.mjs"), "discard") + (Get-BootstrapPreparedArgs)
  $result = Read-JsonCommand $node @args
  if (-not $result.ok) { throw ([string]$result.error) }
  $script:BootstrapPrepared = $null
}

function Restore-OwnershipMarker {
  if (-not $MarkerWritten) { return }
  if ($null -ne $PreviousMarker) {
    $restore = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "marker-restore" "--state-root" $StateRoot "--install-dir" $InstallDir "--build-id" ([string]$PreviousMarker.lastKnownBuildId) "--version" ([string]$PreviousMarker.lastKnownVersion) "--created-at" ([string]$PreviousMarker.createdAt) "--updated-at" ([string]$PreviousMarker.updatedAt)
  } else {
    $restore = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "marker-delete" "--state-root" $StateRoot "--install-dir" $InstallDir
  }
  if (-not $restore.ok) { throw ([string]$restore.error) }
  $script:MarkerWritten = $false
}

function Restore-PreviousBackupStash {
  if (-not $PreviousBackupStashDir) { return }
  if (-not (Test-Path -LiteralPath $PreviousBackupStashDir)) { throw "Previous backup rollback stash is missing." }
  if (Test-Path -LiteralPath $PreviousBackupDir) { throw "Previous backup path is occupied during rollback restore." }
  Move-Item -LiteralPath $PreviousBackupStashDir -Destination $PreviousBackupDir
  $script:PreviousBackupStashDir = $null
}

try {
  if ($env:OS -ne "Windows_NT") { throw "Codexless Technical Preview installer currently supports Windows only." }

  $ErrorStage = "prerequisite"
  $ErrorCode = "PREREQUISITE_FAILED"
  $node = Get-RequiredCommand -Names @("node.exe", "node") -Label "Node.js"
  $npm = Get-RequiredCommand -Names @("npm.cmd", "npm") -Label "npm"
  $nodeVersion = Assert-Node22 -Node $node

  $LockAction = if ($Repair) { "repair" } elseif (Test-Path -LiteralPath $InstallDir) { "update" } else { "install" }
  $ErrorStage = "activation-lock"
  $ErrorCode = "INSTALLER_BUSY"
  $ActivationLock = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "lock-acquire" "--state-root" $StateRoot "--install-dir" $InstallDir "--action" $LockAction "--owner-pid" ([string]$PID)
  if (-not $ActivationLock.ok) {
    if ($Json) { $ActivationLock | ConvertTo-Json -Depth 6 }
    else { Write-Error ([string]$ActivationLock.error) }
    exit 1
  }

  $HadExistingInstall = Test-Path -LiteralPath $InstallDir
  if (-not $Repair) {
    $LifecycleMode = if ($HadExistingInstall) { "update" } else { "install" }
    $LifecycleAction = if ($HadExistingInstall) { "update-failed" } else { "install-failed" }
  }

  $ErrorStage = "prerequisite"
  $ErrorCode = "PREREQUISITE_FAILED"
  $codexResolution = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\resolve-codex.mjs")
  if (-not $codexResolution.ok -or -not $codexResolution.path) {
    throw ("Codex prerequisite check failed: " + $codexResolution.error)
  }
  $env:CODEX_BIN = [string]$codexResolution.path

  $ErrorStage = "staging"
  $ErrorCode = "STAGING_FAILED"
  New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null
  Copy-ReleaseTree -From $SourceRoot -To $StageDir

  Push-Location $StageDir
  try {
    $ErrorStage = "dependency-install"
    $ErrorCode = "DEPENDENCY_INSTALL_FAILED"
    Invoke-Checked $npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    $ErrorStage = "staging-doctor"
    $ErrorCode = "STAGING_DOCTOR_FAILED"
    $stageDoctor = Run-DoctorJson -Root $StageDir -Node $node
  } finally {
    Pop-Location
  }

  $ErrorStage = "state-compatibility"
  $ErrorCode = "STATE_INCOMPATIBLE"
  $lifecycleArgs = @(
    (Join-Path $SourceRoot "scripts\lifecycle.mjs"), "preflight",
    "--target-root", $StageDir,
    "--mode", $LifecycleMode,
    "--install-dir", $InstallDir,
    "--state-root", $StateRoot
  )
  if ($HadExistingInstall) { $lifecycleArgs += @("--installed-root", $InstallDir) }
  $lifecyclePlan = Read-JsonCommand $node @lifecycleArgs
  if (-not $lifecyclePlan.ok) {
    $ErrorStage = [string]$lifecyclePlan.errorStage
    $ErrorCode = [string]$lifecyclePlan.errorCode
    throw [string]$lifecyclePlan.error
  }
  $StateSchemaCompatible = $true

  $ErrorStage = "bootstrap-prepare"
  $ErrorCode = "BOOTSTRAP_GENERATION_PREPARE_FAILED"
  $handoffBuild = [string]$env:CODEXLESS_BOOTSTRAP_PREPARED_BUILD_ID
  $handoffReused = [string]$env:CODEXLESS_BOOTSTRAP_PREPARED_REUSED
  $handoffPending = [string]$env:CODEXLESS_BOOTSTRAP_PREPARED_PENDING_DIR
  $handoffPresent = (-not [string]::IsNullOrWhiteSpace($handoffBuild)) -or (-not [string]::IsNullOrWhiteSpace($handoffReused)) -or (-not [string]::IsNullOrWhiteSpace($handoffPending))
  if ($handoffPresent) {
    if ([string]::IsNullOrWhiteSpace($handoffBuild) -or ($handoffReused -ne "true" -and $handoffReused -ne "false")) { throw "External bootstrap handoff is incomplete or invalid." }
    if ($handoffBuild -ne [string]$lifecyclePlan.artifactBuildId) { throw "External bootstrap handoff build does not match staged target build." }
    if ($handoffReused -eq "false" -and [string]::IsNullOrWhiteSpace($handoffPending)) { throw "External bootstrap handoff is missing its pending generation." }
    if ($handoffReused -eq "true" -and -not [string]::IsNullOrWhiteSpace($handoffPending)) { throw "External bootstrap handoff reused generation must not include a pending path." }
    $bootstrapArgs = @(
      (Join-Path $SourceRoot "scripts\materialize-bootstrap.mjs"), "validate",
      "--bootstrap-root", $BootstrapRoot,
      "--build-id", $handoffBuild,
      "--reused", $handoffReused
    )
    if ($handoffReused -eq "false") { $bootstrapArgs += @("--pending-dir", $handoffPending) }
    $bootstrapValidation = Read-JsonCommand $node @bootstrapArgs
    if (-not $bootstrapValidation.ok) { throw ([string]$bootstrapValidation.error) }
    $BootstrapPrepared = $bootstrapValidation.prepared
  } else {
    $bootstrapPrepare = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\materialize-bootstrap.mjs") "prepare" "--source-root" $StageDir "--bootstrap-root" $BootstrapRoot "--build-id" ([string]$lifecyclePlan.artifactBuildId)
    if (-not $bootstrapPrepare.ok) { throw ([string]$bootstrapPrepare.error) }
    $BootstrapPrepared = $bootstrapPrepare.prepared
  }

  $ErrorStage = "ownership-marker-snapshot"
  $ErrorCode = "OWNERSHIP_MARKER_SNAPSHOT_FAILED"
  $markerSnapshot = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "marker-read-optional" "--state-root" $StateRoot "--install-dir" $InstallDir
  if (-not $markerSnapshot.ok) { throw ([string]$markerSnapshot.error) }
  $PreviousMarker = $markerSnapshot.marker

  if ($HadExistingInstall) {
    $ErrorStage = "backup"
    $ErrorCode = "BACKUP_FAILED"
    $BackupDir = Join-Path $ParentDir ("Codexless-backup-" + [guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $InstallDir -Destination $BackupDir
  }

  try {
    $ErrorStage = "activate"
    $ErrorCode = "ACTIVATE_FAILED"
    Move-Item -LiteralPath $StageDir -Destination $InstallDir
    $Installed = $true

    $ErrorStage = "installed-doctor"
    $ErrorCode = "INSTALLED_DOCTOR_FAILED"
    $installedDoctor = Run-DoctorJson -Root $InstallDir -Node $node

    $ErrorStage = "receipt"
    $ErrorCode = "RECEIPT_FAILED"
    $receiptArgs = @(
      (Join-Path $SourceRoot "scripts\lifecycle.mjs"), "receipt",
      "--target-root", $InstallDir,
      "--install-dir", $InstallDir,
      "--doctor-status", [string]$installedDoctor.status,
      "--mode", $LifecycleMode,
      "--state-root", $StateRoot
    )
    if ($HadExistingInstall) {
      $receiptArgs += @("--previous-root", $BackupDir, "--backup-retained", "true", "--backup-path", $PreviousBackupDir)
    }
    $SuccessReceipt = Read-JsonCommand $node @receiptArgs
    if (-not $SuccessReceipt.ok) {
      $ErrorStage = [string]$SuccessReceipt.errorStage
      $ErrorCode = [string]$SuccessReceipt.errorCode
      throw [string]$SuccessReceipt.error
    }

    if ($HadExistingInstall) {
      if (Test-Path -LiteralPath $PreviousBackupDir) {
        $ErrorStage = "previous-stash"
        $ErrorCode = "PREVIOUS_STASH_FAILED"
        $stashCandidate = Join-Path $ParentDir ("Codexless-previous.rollback-" + [string]$ActivationLock.nonce)
        if (Test-Path -LiteralPath $stashCandidate) { throw "Previous backup rollback stash already exists." }
        Move-Item -LiteralPath $PreviousBackupDir -Destination $stashCandidate
        $PreviousBackupStashDir = $stashCandidate
      }
      $ErrorStage = "backup-retention"
      $ErrorCode = "BACKUP_RETENTION_FAILED"
      Move-Item -LiteralPath $BackupDir -Destination $PreviousBackupDir
      $BackupDir = $PreviousBackupDir
    }

    $ErrorStage = "ownership-marker"
    $ErrorCode = "OWNERSHIP_MARKER_WRITE_FAILED"
    $marker = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "marker-write" "--state-root" $StateRoot "--install-dir" $InstallDir "--build-id" ([string]$SuccessReceipt.artifactBuildId) "--version" ([string]$SuccessReceipt.to.version)
    if (-not $marker.ok) {
      $ErrorStage = [string]$marker.errorStage
      $ErrorCode = [string]$marker.errorCode
      throw [string]$marker.error
    }
    $MarkerWritten = $true

    $ErrorStage = "bootstrap-commit"
    $ErrorCode = "BOOTSTRAP_GENERATION_COMMIT_FAILED"
    $bootstrapCommitArgs = @((Join-Path $SourceRoot "scripts\materialize-bootstrap.mjs"), "commit") + (Get-BootstrapPreparedArgs)
    $bootstrapCommit = Read-JsonCommand $node @bootstrapCommitArgs
    if (-not $bootstrapCommit.ok) {
      if ($bootstrapCommit.errorCode) { $ErrorCode = [string]$bootstrapCommit.errorCode }
      throw ([string]$bootstrapCommit.error)
    }
    if ([string]$bootstrapCommit.buildId -ne [string]$SuccessReceipt.artifactBuildId) { throw "Bootstrap commit did not activate the installed build." }

    $BootstrapPrepared = $null
    $MarkerWritten = $false
    $PreviousMarker = $null
    $BackupDir = $null
    $Installed = $false
    $TransactionCommitted = $true

    if ($PreviousBackupStashDir) {
      $ErrorStage = "previous-stash-cleanup"
      $ErrorCode = "PREVIOUS_STASH_CLEANUP_FAILED"
      Remove-Item -LiteralPath $PreviousBackupStashDir -Recurse -Force
      $PreviousBackupStashDir = $null
    }
  } catch {
    $transactionFailure = $_.Exception.Message
    if (-not $TransactionCommitted) {
      if ($Installed -and (Test-Path -LiteralPath $InstallDir)) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        $Installed = $false
      }
      if ($BackupDir -and (Test-Path -LiteralPath $BackupDir) -and -not (Test-Path -LiteralPath $InstallDir)) {
        Move-Item -LiteralPath $BackupDir -Destination $InstallDir
        $BackupDir = $null
        $RollbackPerformed = $true
      }
      if ($PreviousBackupStashDir) {
        try { Restore-PreviousBackupStash } catch {
          $ErrorStage = "previous-restore"
          $ErrorCode = "PREVIOUS_STASH_RESTORE_FAILED"
          $transactionFailure = "Lifecycle rollback could not restore the retained previous install."
        }
      }
      if ($MarkerWritten) {
        try { Restore-OwnershipMarker } catch {
          if ($ErrorCode -ne "PREVIOUS_STASH_RESTORE_FAILED") {
            $ErrorStage = "ownership-marker"
            $ErrorCode = "OWNERSHIP_MARKER_ROLLBACK_FAILED"
            $transactionFailure = "Lifecycle rollback could not restore the previous ownership marker."
          }
        }
      }
      if ($BootstrapPrepared) {
        try { Discard-BootstrapPrepared } catch {
          if ($ErrorCode -ne "PREVIOUS_STASH_RESTORE_FAILED") {
            $ErrorStage = "bootstrap-discard"
            $ErrorCode = "BOOTSTRAP_GENERATION_DISCARD_FAILED"
            $transactionFailure = "Lifecycle rollback could not discard the prepared bootstrap generation."
          }
        }
      }
    }
    throw $transactionFailure
  }

  $ErrorStage = "activation-lock-release"
  $ErrorCode = "INSTALLER_LOCK_RELEASE_FAILED"
  Release-ActivationLock

  if ($Json) { $SuccessReceipt | ConvertTo-Json -Depth 8 }
  else {
    Write-Host "Codexless $($SuccessReceipt.action): $($SuccessReceipt.to.version)"
    Write-Host "Location: $InstallDir"
    Write-Host "Doctor: $(Join-Path $InstallDir 'bin\codexless-doctor.cmd')"
    Write-Host "HTTP:   $(Join-Path $InstallDir 'bin\codexless-http.cmd')"
    if ($SuccessReceipt.rollback.backupRetained) { Write-Host "Previous build retained: $($SuccessReceipt.rollback.backupPath)" }
    Write-Host "No PATH, service, Browser, or Tunnel settings were changed."
  }
} catch {
  $failureMessage = $_.Exception.Message
  if (-not $TransactionCommitted) {
    if (Test-Path -LiteralPath $StageDir) { Remove-Item -LiteralPath $StageDir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($BackupDir -and (Test-Path -LiteralPath $BackupDir) -and -not (Test-Path -LiteralPath $InstallDir)) {
      Move-Item -LiteralPath $BackupDir -Destination $InstallDir -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $InstallDir) { $BackupDir = $null; $RollbackPerformed = $true }
    }
    if ($PreviousBackupStashDir) {
      try { Restore-PreviousBackupStash } catch {
        $ErrorStage = "previous-restore"
        $ErrorCode = "PREVIOUS_STASH_RESTORE_FAILED"
        $failureMessage = "Lifecycle rollback could not restore the retained previous install."
      }
    }
    if ($MarkerWritten) {
      try { Restore-OwnershipMarker } catch {
        if ($ErrorCode -ne "PREVIOUS_STASH_RESTORE_FAILED") {
          $ErrorStage = "ownership-marker"
          $ErrorCode = "OWNERSHIP_MARKER_ROLLBACK_FAILED"
          $failureMessage = "Lifecycle rollback could not restore the previous ownership marker."
        }
      }
    }
    if ($BootstrapPrepared) {
      try { Discard-BootstrapPrepared } catch {
        if ($ErrorCode -ne "PREVIOUS_STASH_RESTORE_FAILED") {
          $ErrorStage = "bootstrap-discard"
          $ErrorCode = "BOOTSTRAP_GENERATION_DISCARD_FAILED"
          $failureMessage = "Lifecycle rollback could not discard the prepared bootstrap generation."
        }
      }
    }
  }
  if ($ActivationLock) {
    try { Release-ActivationLock } catch {}
  }
  if ($Json) {
    $failureOutput = $null
    if ($node -and (Test-Path -LiteralPath (Join-Path $SourceRoot "scripts\lifecycle.mjs"))) {
      try {
        $rollbackText = if ($RollbackPerformed) { "true" } else { "false" }
        $schemaText = if ($StateSchemaCompatible) { "true" } else { "false" }
        $failureArgs = @((Join-Path $SourceRoot "scripts\lifecycle.mjs"), "failure", "--action", $LifecycleAction, "--install-dir", $InstallDir, "--error-stage", $ErrorStage, "--error-code", $ErrorCode, "--error", $failureMessage, "--rollback-performed", $rollbackText, "--state-schema-compatible", $schemaText)
        $failureOutput = (& $node @failureArgs | Out-String).Trim()
      } catch {}
    }
    if ($failureOutput) { Write-Output $failureOutput }
    else {
      [ordered]@{
        ok = $false; receiptVersion = 1; action = $LifecycleAction; installDir = $InstallDir
        from = $null; to = $null; artifactBuildId = $null; doctorStatus = $null
        state = [ordered]@{ preserved = $true; schemaCompatible = $StateSchemaCompatible; migrated = $false }
        rollback = [ordered]@{ performed = $RollbackPerformed; backupRetained = $false; backupPath = $null }
        requiresRuntimeRestart = $false; requiresHostRefresh = $false
        errorStage = $ErrorStage; errorCode = $ErrorCode; error = $failureMessage
      } | ConvertTo-Json -Depth 6
    }
  } else {
    Write-Error $failureMessage
  }
  exit 1
}

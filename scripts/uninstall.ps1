[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Codexless"),
  [switch]$PurgeState,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$StateDir = Join-Path $HOME ".config\codexless"
$PersistentSecretsDir = Join-Path $StateDir "secrets"
$InstallSecretsDir = Join-Path $InstallDir "secrets"
$SecretsPreState = "absent"
$SecretsPrepared = $false

function Normalize-LocalPath {
  param([Parameter(Mandatory=$true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\','/')).ToLowerInvariant()
}

function Get-SecretsLinkTarget {
  param([Parameter(Mandatory=$true)]$Item)
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { return $null }
  $raw = @($Item.Target) | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace([string]$raw)) { throw "Existing secrets reparse point has no readable target." }
  $target = [string]$raw
  if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path $Item.Parent.FullName $target }
  return [System.IO.Path]::GetFullPath($target)
}

function Prepare-SecretsForUninstall {
  if (-not (Test-Path -LiteralPath $InstallSecretsDir)) { return }
  $item = Get-Item -LiteralPath $InstallSecretsDir -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    $target = Get-SecretsLinkTarget -Item $item
    if ((Normalize-LocalPath $target) -ne (Normalize-LocalPath $PersistentSecretsDir)) {
      throw "Existing install secrets reparse point targets an unsupported location."
    }
    $script:SecretsPreState = "persistent-junction"
    Remove-Item -LiteralPath $InstallSecretsDir -Force
    $script:SecretsPrepared = $true
    return
  }
  if (-not $item.PSIsContainer) { throw "Existing install secrets path is not a directory." }
  if (Test-Path -LiteralPath $PersistentSecretsDir) {
    throw "Both legacy install secrets and persistent secrets exist; refusing to guess which state is authoritative."
  }
  $script:SecretsPreState = "legacy-directory"
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  Move-Item -LiteralPath $InstallSecretsDir -Destination $PersistentSecretsDir
  $script:SecretsPrepared = $true
}

function Restore-SecretsAfterFailedUninstall {
  if (-not $SecretsPrepared -or -not (Test-Path -LiteralPath $InstallDir)) { return }
  if (Test-Path -LiteralPath $InstallSecretsDir) { return }
  switch ($SecretsPreState) {
    "legacy-directory" {
      if (Test-Path -LiteralPath $PersistentSecretsDir) {
        Move-Item -LiteralPath $PersistentSecretsDir -Destination $InstallSecretsDir
      }
    }
    "persistent-junction" {
      if (Test-Path -LiteralPath $PersistentSecretsDir) {
        New-Item -ItemType Junction -Path $InstallSecretsDir -Target $PersistentSecretsDir | Out-Null
      }
    }
  }
  $script:SecretsPrepared = $false
}

try {
  if (-not (Test-Path -LiteralPath $InstallDir)) {
    $result = [ordered]@{ ok = $true; action = "already-absent"; installDir = $InstallDir; statePurged = $false }
    if ($Json) { $result | ConvertTo-Json -Depth 4 } else { Write-Host "Codexless is already absent: $InstallDir" }
    exit 0
  }

  $packageFile = Join-Path $InstallDir "package.json"
  if (-not (Test-Path -LiteralPath $packageFile)) {
    throw "Refusing to remove a directory without Codexless package.json: $InstallDir"
  }
  $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
  if ($package.name -ne "codexless") {
    throw "Refusing to remove directory whose package name is not codexless: $InstallDir"
  }

  Prepare-SecretsForUninstall

  # Do not keep the current shell inside the tree it is about to remove.
  Set-Location $env:TEMP
  try {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
  } catch {
    Restore-SecretsAfterFailedUninstall
    throw
  }

  $statePurged = $false
  if ($PurgeState -and (Test-Path -LiteralPath $StateDir)) {
    Remove-Item -LiteralPath $StateDir -Recurse -Force
    $statePurged = $true
  }

  $result = [ordered]@{
    ok = $true
    action = "uninstalled"
    version = $package.version
    installDir = $InstallDir
    statePurged = $statePurged
    notes = @(
      "Codex, Node.js, projects, Browser configuration, and Tunnel configuration were not changed.",
      $(if ($PurgeState) { "Codexless-owned state was purged when present." } else { "Codexless-owned state, including persistent secrets, was preserved. Use -PurgeState only when you intentionally want to remove it." })
    )
  }

  if ($Json) { $result | ConvertTo-Json -Depth 5 }
  else {
    Write-Host "Codexless uninstalled: $InstallDir"
    if ($statePurged) { Write-Host "Codexless state purged: $StateDir" }
    else { Write-Host "Codexless state preserved: $StateDir" }
  }
} catch {
  if ($Json) {
    [ordered]@{ ok = $false; action = "uninstall-failed"; error = $_.Exception.Message } | ConvertTo-Json -Depth 4
  } else {
    Write-Error $_.Exception.Message
  }
  exit 1
}

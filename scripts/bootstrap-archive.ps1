[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet("list", "extract")][string]$Action,
  [Parameter(Mandatory=$true)][string]$Archive,
  [string]$Destination
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Archive = [System.IO.Path]::GetFullPath($Archive)

function Get-EntryType {
  param([Parameter(Mandatory=$true)]$Entry)
  if ($Entry.FullName.EndsWith("/")) { return "directory" }
  $attrs = [uint32]$Entry.ExternalAttributes
  $unixMode = ($attrs -shr 16) -band 0xFFFF
  $typeBits = $unixMode -band 0xF000
  switch ($typeBits) {
    0x0000 { return "file" }
    0x4000 { return "directory" }
    0x8000 { return "file" }
    0xA000 { return "symlink" }
    default { return "special" }
  }
}

function Assert-SafeRelativePath {
  param([Parameter(Mandatory=$true)][string]$Name)
  if (-not $Name -or $Name.IndexOf([char]0) -ge 0) { throw "unsafe archive entry path" }
  if ($Name.StartsWith("/") -or $Name.StartsWith("\") -or $Name -match '^[A-Za-z]:' -or $Name -match '^[/\\]{2}') {
    throw "absolute/drive/UNC archive entry path is not allowed: $Name"
  }
  $parts = $Name -split '[/\\]'
  foreach ($part in $parts) {
    if ($part -eq ".." -or $part -eq ".") { throw "traversal archive entry path is not allowed: $Name" }
  }
}

$stream = [System.IO.File]::OpenRead($Archive)
try {
  $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Read, $false)
  try {
    if ($Action -eq "list") {
      $rows = @()
      foreach ($entry in $zip.Entries) {
        $rows += [ordered]@{
          path = [string]$entry.FullName
          type = Get-EntryType -Entry $entry
          size = [int64]$entry.Length
        }
      }
      $rows | ConvertTo-Json -Depth 4 -Compress
      exit 0
    }

    if (-not $Destination) { throw "Destination is required for extract" }
    $destinationFull = [System.IO.Path]::GetFullPath($Destination)
    [System.IO.Directory]::CreateDirectory($destinationFull) | Out-Null
    $prefix = $destinationFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

    foreach ($entry in $zip.Entries) {
      $entryType = Get-EntryType -Entry $entry
      if ($entryType -ne "file" -and $entryType -ne "directory") { throw "unsafe archive entry type: $entryType" }
      Assert-SafeRelativePath -Name ([string]$entry.FullName)
      $relative = ([string]$entry.FullName).Replace('/', [System.IO.Path]::DirectorySeparatorChar).Replace('\', [System.IO.Path]::DirectorySeparatorChar)
      $target = [System.IO.Path]::GetFullPath((Join-Path $destinationFull $relative))
      if (-not ($target + [System.IO.Path]::DirectorySeparatorChar).StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and
          -not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "archive entry escaped destination"
      }
      if ($entryType -eq "directory") {
        [System.IO.Directory]::CreateDirectory($target) | Out-Null
        continue
      }
      $parent = Split-Path -Parent $target
      if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
      $input = $entry.Open()
      try {
        $output = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $input.CopyTo($output) } finally { $output.Dispose() }
      } finally { $input.Dispose() }
    }
  } finally { $zip.Dispose() }
} finally { $stream.Dispose() }

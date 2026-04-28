# Riptide release installer for Windows.
#
# Public entrypoint once hosted:
#   irm https://riptide.run/install.ps1 | iex
#
# This installs prebuilt release bundles. It deliberately does not build
# from source and does not require Rust, npm, Node, or cargo-build-sbf on
# the end-user machine.

[CmdletBinding()]
param(
  [string]$Version = $(if ($env:RIPTIDE_VERSION) { $env:RIPTIDE_VERSION } else { "latest" }),
  [string]$BinDir = $(if ($env:RIPTIDE_BIN_DIR) { $env:RIPTIDE_BIN_DIR } else { Join-Path $HOME ".local\bin" }),
  [string]$InstallDir = $(if ($env:RIPTIDE_INSTALL_DIR) { $env:RIPTIDE_INSTALL_DIR } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "riptide" } else { Join-Path $HOME ".local\share\riptide" }),
  [string]$ReleaseBaseUrl = $(if ($env:RIPTIDE_RELEASE_BASE_URL) { $env:RIPTIDE_RELEASE_BASE_URL } else { "" }),
  [string]$Repo = $(if ($env:RIPTIDE_GITHUB_REPO) { $env:RIPTIDE_GITHUB_REPO } else { "riptidesim/riptide" }),
  [switch]$DryRun,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Say {
  param([string]$Message)
  Write-Output $Message
}

function Warn {
  param([string]$Message)
  Write-Warning "riptide install: $Message"
}

function Die {
  param([string]$Message)
  Write-Error "riptide install: $Message"
  exit 1
}

function Get-Target {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Die "install-release.ps1 is only for Windows. Linux and macOS use: curl -fsSL https://riptide.run/install | sh"
  }

  try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    $arch = $env:PROCESSOR_ARCHITECTURE
  }

  switch -Regex ($arch) {
    "^(X64|AMD64)$" { return "x86_64-pc-windows-msvc" }
    default {
      Die "no prebuilt Riptide release bundle for Windows $arch yet. Supported: Windows x64."
    }
  }
}

function Get-TagForVersion {
  param([string]$Value)
  if ($Value -eq "latest") {
    return "latest"
  }
  if ($Value.StartsWith("v")) {
    return $Value
  }
  return "v$Value"
}

function Download {
  param(
    [string]$Url,
    [string]$Destination
  )
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
  } catch {
    Die "failed to download $Url"
  }
}

function Verify-Sha256 {
  param(
    [string]$Archive,
    [string]$ChecksumFile
  )
  $line = Get-Content -Path $ChecksumFile -TotalCount 1
  $expected = (($line.Trim()) -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash -Path $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) {
    $name = Split-Path -Path $Archive -Leaf
    Die "sha256 mismatch for ${name}: expected $expected, got $actual"
  }
}

function Ensure-LauncherCanBeManaged {
  param([string]$Launcher)
  if ((Test-Path -LiteralPath $Launcher) -and (-not $Force)) {
    $content = ""
    try {
      $content = Get-Content -LiteralPath $Launcher -Raw
    } catch {
      $content = ""
    }
    if ($content -notmatch "installed by riptide release installer") {
      Die "$Launcher already exists and was not created by this installer. Re-run with -Force to overwrite it."
    }
  }
}

function Write-Launcher {
  param(
    [string]$Launcher,
    [string]$Target
  )
  $tmp = "$Launcher.tmp.$PID"
  $content = "@echo off`r`nREM riptide launcher - installed by riptide release installer`r`n`"$Target`" %*`r`n"
  [System.IO.File]::WriteAllText($tmp, $content, [System.Text.Encoding]::ASCII)
  Move-Item -LiteralPath $tmp -Destination $Launcher -Force
}

function Restore-PreviousInstall {
  param(
    [string]$Current,
    [string]$Previous
  )
  Remove-Item -LiteralPath $Current -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $Previous) {
    Move-Item -LiteralPath $Previous -Destination $Current -Force
  }
}

$target = Get-Target
$asset = "riptide-$target.zip"

if ($ReleaseBaseUrl) {
  $base = $ReleaseBaseUrl.TrimEnd("/")
} elseif ($Version -eq "latest") {
  $base = "https://github.com/$Repo/releases/latest/download"
} else {
  $tag = Get-TagForVersion -Value $Version
  $base = "https://github.com/$Repo/releases/download/$tag"
}

$archiveUrl = "$base/$asset"
$checksumUrl = "$archiveUrl.sha256"
$current = Join-Path $InstallDir "current"
$launcher = Join-Path $BinDir "riptide.cmd"

Say "Riptide release install"
Say "  target:      $target"
Say "  version:     $Version"
Say "  archive:     $archiveUrl"
Say "  install dir: $current"
Say "  launcher:    $launcher"

if ($DryRun) {
  Say "dry-run: no files changed"
  exit 0
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("riptide-install." + [System.Guid]::NewGuid().ToString("N"))
$extractDir = Join-Path $tmp "extract"

try {
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  $archive = Join-Path $tmp $asset
  $checksum = Join-Path $tmp "$asset.sha256"

  Say "downloading release bundle..."
  Download -Url $archiveUrl -Destination $archive
  Download -Url $checksumUrl -Destination $checksum

  Say "verifying sha256..."
  Verify-Sha256 -Archive $archive -ChecksumFile $checksum

  Say "extracting..."
  Expand-Archive -Path $archive -DestinationPath $extractDir -Force

  $bundleLauncher = Get-ChildItem -Path $extractDir -Filter "riptide.cmd" -Recurse |
    Where-Object { $_.FullName -match "[\\/]bin[\\/]riptide\.cmd$" } |
    Select-Object -First 1
  if (-not $bundleLauncher) {
    Die "release archive does not contain bin/riptide.cmd"
  }
  $bundleRoot = Split-Path -Path (Split-Path -Path $bundleLauncher.FullName -Parent) -Parent

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  Ensure-LauncherCanBeManaged -Launcher $launcher

  $staged = Join-Path $InstallDir ".current.tmp.$PID"
  Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $staged -Force | Out-Null
  Get-ChildItem -LiteralPath $bundleRoot -Force | Copy-Item -Destination $staged -Recurse -Force

  $stagedLauncher = Join-Path $staged "bin\riptide.cmd"
  try {
    $stagedVersion = (& $stagedLauncher --version 2>$null | Select-Object -First 1)
  } catch {
    Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
    Die "downloaded bundle was extracted, but staged\bin\riptide.cmd --version failed"
  }

  $previous = Join-Path $InstallDir ".previous.$PID"
  Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $current) {
    Move-Item -LiteralPath $current -Destination $previous -Force
  }

  try {
    Move-Item -LiteralPath $staged -Destination $current -Force
  } catch {
    Restore-PreviousInstall -Current $current -Previous $previous
    Die "failed to activate new install"
  }

  try {
    Write-Launcher -Launcher $launcher -Target (Join-Path $current "bin\riptide.cmd")
  } catch {
    Restore-PreviousInstall -Current $current -Previous $previous
    Die "failed to write launcher at $launcher"
  }

  try {
    $installedVersion = (& $launcher --version 2>$null | Select-Object -First 1)
  } catch {
    Restore-PreviousInstall -Current $current -Previous $previous
    Die "installed launcher exists, but '$launcher --version' failed"
  }

  Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction SilentlyContinue
  Say "installed: $installedVersion"
  Say "staged bundle: $stagedVersion"

  $normalizedBin = $BinDir.TrimEnd("\")
  $pathEntries = @()
  if ($env:Path) {
    $pathEntries = $env:Path.Split(";") | ForEach-Object { $_.TrimEnd("\") }
  }

  if ($pathEntries -contains $normalizedBin) {
    Say "ready: riptide is on PATH"
  } else {
    Warn "$BinDir is not on PATH"
    Warn "add it for future shells with:"
    Warn "  setx PATH `"$BinDir;%PATH%`""
  }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

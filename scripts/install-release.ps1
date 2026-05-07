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
  [switch]$Force,
  [switch]$NoAgentSkills
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:StartTime = Get-Date

# Style is on when the host supports color, NO_COLOR / RIPTIDE_NO_BANNER
# are unset, and we are not in CI.
$script:UseColor = (
  -not $env:NO_COLOR -and
  -not $env:RIPTIDE_NO_BANNER -and
  -not $env:CI -and
  $Host -and $Host.UI -and $Host.UI.RawUI
)

function Write-Styled {
  param(
    [string]$Message,
    [System.ConsoleColor]$Color = [System.ConsoleColor]::Gray,
    [switch]$NoNewline
  )
  if ($script:UseColor) {
    if ($NoNewline) {
      Write-Host $Message -ForegroundColor $Color -NoNewline
    } else {
      Write-Host $Message -ForegroundColor $Color
    }
  } else {
    if ($NoNewline) {
      Write-Host $Message -NoNewline
    } else {
      Write-Host $Message
    }
  }
}

function Print-Banner {
  if (-not $script:UseColor) { return }
  $cyan = [System.ConsoleColor]::Cyan
  Write-Host ""
  Write-Styled "  .......   ...   ......    .......  ...   .......   ......." -Color $cyan
  Write-Styled "  ..   ..   ...   ..   ..     ..     ...   ..   ...  ...    " -Color $cyan
  Write-Styled "  .......   ...   ..  ...     ..     ...   ..   ...  ......." -Color $cyan
  Write-Styled "  ..  ..    ...   ..          ..     ...   ..   ...  ...    " -Color $cyan
  Write-Styled "  ..   ..   ...   ..          ..     ...   .......   ......." -Color $cyan
  Write-Host ""
  Write-Styled "  Deterministic Solana simulation evidence." -Color DarkGray
  Write-Host ""
}

function Rule {
  Write-Styled "  ─────────────────────────────────────────────────────" -Color DarkGray
}

function Step {
  param([string]$Message)
  Write-Host ""
  Write-Styled "→ " -Color Cyan -NoNewline
  Write-Styled $Message -Color White
}

function Ok {
  param([string]$Message)
  Write-Styled "  ✓ " -Color Green -NoNewline
  Write-Host $Message
}

function Info {
  param([string]$Message)
  Write-Styled "  · " -Color DarkGray -NoNewline
  Write-Styled $Message -Color DarkGray
}

function Warn-Styled {
  param([string]$Message)
  Write-Styled "  ! " -Color Yellow -NoNewline
  Write-Styled $Message -Color Yellow
}

function Die {
  param([string]$Message)
  Write-Host ""
  Write-Styled "  ✗ " -Color Red -NoNewline
  Write-Styled "riptide install: $Message" -Color Red
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

function Get-HumanSize {
  param([string]$Path)
  try {
    $bytes = (Get-Item -LiteralPath $Path).Length
  } catch {
    return ""
  }
  if ($bytes -ge 1MB) { return ("{0:N1} MiB" -f ($bytes / 1MB)) }
  if ($bytes -ge 1KB) { return ("{0:N0} KiB" -f ($bytes / 1KB)) }
  return "$bytes B"
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

function Test-AgentSkillsEnabled {
  if ($NoAgentSkills) { return $false }
  if (-not $env:RIPTIDE_INSTALL_AGENT_SKILLS) { return $true }
  return ($env:RIPTIDE_INSTALL_AGENT_SKILLS -notmatch "^(0|false|no|off)$")
}

function Install-AgentSkillForAgent {
  param(
    [string]$AgentLabel,
    [string]$SkillsDir,
    [string]$SkillSource,
    [string]$SkillName
  )

  $target = Join-Path $SkillsDir $SkillName
  $marker = ".riptide-managed-skill"
  try {
    New-Item -ItemType Directory -Path $SkillsDir -Force | Out-Null

    if (Test-Path -LiteralPath $target) {
      $markerPath = Join-Path $target $marker
      if (Test-Path -LiteralPath $markerPath) {
        Remove-Item -LiteralPath $target -Recurse -Force
      } else {
        Warn-Styled "$AgentLabel skill exists and is not Riptide-managed; leaving it unchanged: $target"
        return
      }
    }

    Copy-Item -LiteralPath $SkillSource -Destination $target -Recurse -Force
    Set-Content `
      -LiteralPath (Join-Path $target $marker) `
      -Value @("installed by riptide release installer", "source: $SkillSource") `
      -Encoding ASCII
    Ok "installed $AgentLabel skill: $SkillName"
    Info $target
  } catch {
    Warn-Styled "could not install $AgentLabel skill $SkillName into ${SkillsDir}: $($_.Exception.Message)"
  }
}

function Install-AgentSkills {
  param([string]$CurrentRoot)

  if (-not (Test-AgentSkillsEnabled)) {
    Info "agent skill install disabled"
    return
  }

  $sourceRoot = Join-Path $CurrentRoot "skills"
  if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    Warn-Styled "release bundle has no skills directory; skipping agent skill install"
    return
  }

  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  $claudeHome = if ($env:CLAUDE_HOME) { $env:CLAUDE_HOME } else { Join-Path $HOME ".claude" }
  $codexSkills = Join-Path $codexHome "skills"
  $claudeSkills = Join-Path $claudeHome "skills"
  $found = $false

  Get-ChildItem -LiteralPath $sourceRoot -Directory | ForEach-Object {
    $skillPath = $_.FullName
    if (-not (Test-Path -LiteralPath (Join-Path $skillPath "SKILL.md") -PathType Leaf)) {
      return
    }
    $found = $true
    Install-AgentSkillForAgent -AgentLabel "Codex" -SkillsDir $codexSkills -SkillSource $skillPath -SkillName $_.Name
    Install-AgentSkillForAgent -AgentLabel "Claude" -SkillsDir $claudeSkills -SkillSource $skillPath -SkillName $_.Name
  }

  if (-not $found) {
    Warn-Styled "release bundle has no installable skills; expected directories with SKILL.md under $sourceRoot"
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

Print-Banner
Rule
Write-Styled ("  target       {0}" -f $target) -Color Gray
Write-Styled ("  version      {0}" -f $Version) -Color Gray
Write-Styled ("  archive      {0}" -f $archiveUrl) -Color Gray
Write-Styled ("  install dir  {0}" -f $current) -Color Gray
Write-Styled ("  launcher     {0}" -f $launcher) -Color Gray
Write-Styled ("  agent skills {0}" -f ($(if (Test-AgentSkillsEnabled) { "enabled" } else { "disabled" }))) -Color Gray
Rule

if ($DryRun) {
  Step "dry run"
  Ok "no files changed"
  exit 0
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("riptide-install." + [System.Guid]::NewGuid().ToString("N"))
$extractDir = Join-Path $tmp "extract"

try {
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  $archive = Join-Path $tmp $asset
  $checksum = Join-Path $tmp "$asset.sha256"

  Step "downloading release bundle"
  Info $archiveUrl
  Download -Url $archiveUrl -Destination $archive
  Download -Url $checksumUrl -Destination $checksum
  $sizeText = Get-HumanSize -Path $archive
  if ($sizeText) {
    Ok "downloaded ($sizeText)"
  } else {
    Ok "downloaded"
  }

  Step "verifying sha256"
  Verify-Sha256 -Archive $archive -ChecksumFile $checksum
  Ok "checksum matches"

  Step "extracting"
  Expand-Archive -Path $archive -DestinationPath $extractDir -Force
  Ok "unpacked to staging"

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

  Step "activating release"
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
  Ok "installed: $installedVersion"
  Info "staged bundle: $stagedVersion"

  Step "installing agent skills"
  Install-AgentSkills -CurrentRoot $current

  $normalizedBin = $BinDir.TrimEnd("\")
  $pathEntries = @()
  if ($env:Path) {
    $pathEntries = $env:Path.Split(";") | ForEach-Object { $_.TrimEnd("\") }
  }

  $pathHint = $false
  if ($pathEntries -contains $normalizedBin) {
    Ok "$BinDir is on PATH"
  } else {
    Warn-Styled "$BinDir is not on PATH"
    Warn-Styled "add it for future shells with:"
    Warn-Styled "  setx PATH `"$BinDir;%PATH%`""
    $pathHint = $true
  }

  $elapsed = (Get-Date) - $script:StartTime
  $elapsedText = "{0}m {1:00}s" -f [int]$elapsed.TotalMinutes, $elapsed.Seconds

  Write-Host ""
  Rule
  Write-Styled "  ✓ " -Color Green -NoNewline
  Write-Styled "Riptide installed " -Color White -NoNewline
  Write-Styled ("in {0}" -f $elapsedText) -Color DarkGray
  Rule
  Write-Host ""
  Write-Styled "  Next:" -Color White
  if ($pathHint) {
    Write-Styled "    (open a new shell or update PATH first)" -Color DarkGray
  }
  Write-Styled "    1. " -Color White -NoNewline
  Write-Styled "riptide doctor" -Color Cyan -NoNewline
  Write-Styled "          # verify your toolchain" -Color DarkGray
  Write-Styled "    2. " -Color White -NoNewline
  Write-Styled "cd <your-program>" -Color Cyan -NoNewline
  Write-Styled "       # the Solana program you want to simulate" -Color DarkGray
  Write-Styled "    3. " -Color White -NoNewline
  Write-Styled "riptide init" -Color Cyan -NoNewline
  Write-Styled "            # thin .riptide/ bootstrap" -Color DarkGray
  Write-Styled "    4. " -Color White -NoNewline
  Write-Styled "/riptide-config" -Color Cyan -NoNewline
  Write-Styled "         # configure adapter, harness, scenarios, campaign readiness" -Color DarkGray
  Write-Host ""
  Write-Styled "  New to Riptide? " -Color DarkGray -NoNewline
  Write-Styled "riptide --help" -Color White -NoNewline
  Write-Styled " walks through the full surface." -Color DarkGray
  Write-Host ""
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

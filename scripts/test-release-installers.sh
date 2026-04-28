#!/usr/bin/env bash
# Script-level smoke tests for release installers. These tests avoid real
# downloads and file mutations by using dry-run modes and fake platform probes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/riptide-installer-tests.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN" "$TMP/home"

cat > "$FAKE_BIN/uname" <<'EOF'
#!/usr/bin/env sh
case "$1" in
  -s) printf '%s\n' "$RIPTIDE_TEST_UNAME_S" ;;
  -m) printf '%s\n' "$RIPTIDE_TEST_UNAME_M" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/uname"

run_posix_case() {
  local os="$1"
  local arch="$2"
  local target="$3"
  local output

  output="$(
    PATH="$FAKE_BIN:$PATH" \
    HOME="$TMP/home" \
    RIPTIDE_TEST_UNAME_S="$os" \
    RIPTIDE_TEST_UNAME_M="$arch" \
    RIPTIDE_RELEASE_BASE_URL="https://example.test/releases" \
    sh "$ROOT/scripts/install-release.sh" --dry-run
  )"

  grep -F "target:      $target" <<<"$output" >/dev/null
  grep -F "archive:     https://example.test/releases/riptide-$target.tar.gz" <<<"$output" >/dev/null
  grep -F "dry-run: no files changed" <<<"$output" >/dev/null
}

run_unsupported_posix_case() {
  local output
  if output="$(
    PATH="$FAKE_BIN:$PATH" \
    HOME="$TMP/home" \
    RIPTIDE_TEST_UNAME_S="FreeBSD" \
    RIPTIDE_TEST_UNAME_M="x86_64" \
    sh "$ROOT/scripts/install-release.sh" --dry-run 2>&1
  )"; then
    printf '%s\n' "$output"
    printf 'expected unsupported platform to fail\n' >&2
    exit 1
  fi

  grep -F "Supported: Linux x86_64, macOS x86_64, macOS arm64" <<<"$output" >/dev/null
}

run_windows_static_checks() {
  local ps1="$ROOT/scripts/install-release.ps1"

  grep -F 'riptide-$target.zip' "$ps1" >/dev/null
  grep -F 'x86_64-pc-windows-msvc' "$ps1" >/dev/null
  grep -F 'Get-FileHash' "$ps1" >/dev/null
  grep -F 'Expand-Archive' "$ps1" >/dev/null
  grep -F 'riptide.cmd' "$ps1" >/dev/null
}

run_windows_powershell_parse_check() {
  local ps1="$ROOT/scripts/install-release.ps1"

  if ! command -v pwsh >/dev/null 2>&1; then
    printf 'pwsh not found; skipping PowerShell parse check\n' >&2
    return
  fi

  RIPTIDE_TEST_PS1="$ps1" pwsh -NoLogo -NoProfile -Command '
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($env:RIPTIDE_TEST_PS1, [ref]$null, [ref]$errors) > $null
    if ($errors.Count -gt 0) {
      $errors | Format-List | Out-String | Write-Error
      exit 1
    }
  '
}

run_packager_contract_checks() {
  local output
  output="$(bash "$ROOT/scripts/package-release.sh" --help)"

  grep -F 'x86_64-unknown-linux-gnu' <<<"$output" >/dev/null
  grep -F 'x86_64-apple-darwin' <<<"$output" >/dev/null
  grep -F 'aarch64-apple-darwin' <<<"$output" >/dev/null
  grep -F 'x86_64-pc-windows-msvc' <<<"$output" >/dev/null
}

run_packager_checksum_fallback_checks() {
  local script="$ROOT/scripts/package-release.sh"

  grep -F 'command -v shasum' "$script" >/dev/null
  grep -F 'shasum -a 256' "$script" >/dev/null
  if grep -F 'require sha256sum' "$script" >/dev/null; then
    printf 'package-release still requires GNU sha256sum instead of falling back to shasum\n' >&2
    exit 1
  fi
}

run_packager_host_probe_check() {
  local fake_path="$TMP/packager-bin"
  local output status
  mkdir -p "$fake_path"

  cat > "$fake_path/rustc" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'rustc 1.91.1'
printf '%s\n' 'binary: rustc'
printf '%s\n' 'commit-hash: test'
printf '%s\n' 'commit-date: test'
printf '%s\n' 'host: x86_64-unknown-linux-gnu'
for _ in $(seq 1 2000); do
  printf '%s\n' 'extra metadata after host line'
done
EOF

  cat > "$fake_path/node" <<'EOF'
#!/usr/bin/env bash
printf '%s' '0.6.0'
EOF

  for cmd in npm cargo curl tar; do
    cat > "$fake_path/$cmd" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  done
  cat > "$fake_path/sha256sum" <<'EOF'
#!/usr/bin/env bash
if [ "$#" -gt 0 ]; then
  printf '%s  %s\n' '60e3b0a8500819514aca603487c254298cd776de0698d3cd08f11dba5b8289a8' "$1"
fi
exit 0
EOF
  chmod +x "$fake_path"/*

  set +e
  output="$(
    PATH="$fake_path:$PATH" \
    bash "$ROOT/scripts/package-release.sh" \
      --out-dir "$TMP/package-out" \
      --skip-builds \
      --skip-sbf 2>&1
  )"
  status=$?
  set -e

  if [ "$status" -eq 141 ]; then
    printf '%s\n' "$output"
    printf 'package-release host target probe regressed with SIGPIPE exit 141\n' >&2
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    grep -F 'missing' <<<"$output" >/dev/null
  fi
}

run_posix_case Linux x86_64 x86_64-unknown-linux-gnu
run_posix_case Darwin x86_64 x86_64-apple-darwin
run_posix_case Darwin arm64 aarch64-apple-darwin
run_unsupported_posix_case
run_windows_static_checks
run_windows_powershell_parse_check
run_packager_contract_checks
run_packager_checksum_fallback_checks
run_packager_host_probe_check

printf 'release installer tests passed\n'

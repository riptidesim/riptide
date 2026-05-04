#!/usr/bin/env sh
# Riptide release installer.
#
# Public entrypoint once hosted:
#   curl -fsSL https://riptide.run/install | sh
#
# This installs prebuilt release bundles. It deliberately does not build
# from source and does not require Rust, npm, or cargo-build-sbf on the
# end-user machine. Keep ./install.sh as the source-checkout installer.
# Windows uses scripts/install-release.ps1 instead.

set -eu

REPO="${RIPTIDE_GITHUB_REPO:-riptidesim/riptide}"
VERSION="${RIPTIDE_VERSION:-latest}"
BIN_DIR="${RIPTIDE_BIN_DIR:-$HOME/.local/bin}"
INSTALL_DIR="${RIPTIDE_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/riptide}"
BASE_URL="${RIPTIDE_RELEASE_BASE_URL:-}"
DRY_RUN=0
FORCE=0
START_TS="$(date +%s 2>/dev/null || echo 0)"

# ---------- cosmetic helpers ----------
# POSIX-portable color/style. Active only when stdout is a TTY, NO_COLOR
# is unset, RIPTIDE_NO_BANNER is unset, CI is unset, and TERM is sane.
# RGB cyan #22F0E6 matches the brand accent used by `riptide init`.
if [ -t 1 ] \
  && [ -z "${NO_COLOR:-}" ] \
  && [ -z "${RIPTIDE_NO_BANNER:-}" ] \
  && [ -z "${CI:-}" ] \
  && [ "${TERM:-dumb}" != "dumb" ]; then
  C_BOLD="$(printf '\033[1m')"
  C_DIM="$(printf '\033[2m')"
  C_RED="$(printf '\033[31m')"
  C_GREEN="$(printf '\033[32m')"
  C_YELLOW="$(printf '\033[33m')"
  C_CYAN="$(printf '\033[38;2;83;213;209m')"
  C_RESET="$(printf '\033[0m')"
else
  C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_RESET=''
fi

print_banner() {
  [ -n "$C_CYAN" ] || return 0
  printf '\n'
  printf '%s  .......   ...   ......    .......  ...   .......   .......%s\n' "$C_CYAN" "$C_RESET"
  printf '%s  ..   ..   ...   ..   ..     ..     ...   ..   ...  ...    %s\n' "$C_CYAN" "$C_RESET"
  printf '%s  .......   ...   ..  ...     ..     ...   ..   ...  .......%s\n' "$C_CYAN" "$C_RESET"
  printf '%s  ..  ..    ...   ..          ..     ...   ..   ...  ...    %s\n' "$C_CYAN" "$C_RESET"
  printf '%s  ..   ..   ...   ..          ..     ...   .......   .......%s\n' "$C_CYAN" "$C_RESET"
  printf '\n'
  printf '  %sDeterministic Solana simulation evidence.%s\n' "$C_DIM" "$C_RESET"
  printf '\n'
}

rule() {
  printf '%s  ─────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
}

step()  { printf '\n%s→%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
ok()    { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info()  { printf '  %s·%s %s%s%s\n' "$C_DIM" "$C_RESET" "$C_DIM" "$*" "$C_RESET"; }
warn()  { printf '  %s!%s %s%s%s\n' "$C_YELLOW" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()   { printf '\n  %s✗%s %s%sriptide install: %s%s\n' "$C_RED" "$C_RESET" "$C_BOLD" "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

# Legacy shims kept so existing call sites stay structurally readable.
say() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
Riptide release installer

Usage:
  curl -fsSL https://riptide.run/install | sh
  curl -fsSL https://riptide.run/install | sh -s -- --version 0.7.0

Options:
  --version <version>     Install a specific release. Accepts 0.7.0 or v0.7.0.
                          Defaults to latest.
  --bin-dir <dir>         Directory for the riptide launcher.
                          Defaults to $HOME/.local/bin.
  --install-dir <dir>     Directory for the unpacked release bundle.
                          Defaults to $XDG_DATA_HOME/riptide or
                          $HOME/.local/share/riptide.
  --dry-run               Print what would happen without downloading.
  --force                 Overwrite an existing unmanaged launcher.
  -h, --help              Show this help.

Environment:
  RIPTIDE_VERSION
  RIPTIDE_BIN_DIR
  RIPTIDE_INSTALL_DIR
  RIPTIDE_RELEASE_BASE_URL  Override the GitHub Release download base.
  RIPTIDE_GITHUB_REPO       Defaults to riptidesim/riptide.
  NO_COLOR                  Disable ANSI styling.
  RIPTIDE_NO_BANNER         Disable banner + ANSI styling.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || die "--bin-dir requires a value"
      BIN_DIR="$2"
      shift 2
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || die "--install-dir requires a value"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || die "required tool not found on PATH: $1"
}

detect_target() {
  os="$(uname -s 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"
  case "$os:$arch" in
    Linux:x86_64|Linux:amd64)
      printf '%s\n' "x86_64-unknown-linux-gnu"
      ;;
    Darwin:x86_64|Darwin:amd64)
      printf '%s\n' "x86_64-apple-darwin"
      ;;
    Darwin:arm64|Darwin:aarch64)
      printf '%s\n' "aarch64-apple-darwin"
      ;;
    *)
      die "no prebuilt Riptide release bundle for $os/$arch yet. Supported: Linux x86_64, macOS x86_64, macOS arm64. Windows uses: irm https://riptide.run/install.ps1 | iex"
      ;;
  esac
}

tag_for_version() {
  case "$1" in
    latest)
      printf '%s\n' "latest"
      ;;
    v*)
      printf '%s\n' "$1"
      ;;
    *)
      printf 'v%s\n' "$1"
      ;;
  esac
}

download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    die "curl or wget is required to download release artifacts"
  fi
}

# Best-effort human-readable file size (KiB / MiB). Pure POSIX arithmetic
# so we don't pull in numfmt, awk float, or bc.
human_size() {
  path="$1"
  bytes="$(wc -c < "$path" 2>/dev/null | tr -d ' ' || echo 0)"
  [ -n "$bytes" ] || bytes=0
  if [ "$bytes" -ge 1048576 ]; then
    whole="$((bytes / 1048576))"
    frac="$(((bytes * 10 / 1048576) % 10))"
    printf '%s.%s MiB' "$whole" "$frac"
  elif [ "$bytes" -ge 1024 ]; then
    printf '%s KiB' "$((bytes / 1024))"
  else
    printf '%s B' "$bytes"
  fi
}

verify_sha256() {
  archive="$1"
  checksum_file="$2"
  archive_name="$(basename "$archive")"
  checksum_name="$(basename "$checksum_file")"
  checksum_dir="$(dirname "$checksum_file")"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$checksum_dir" && sha256sum -c "$checksum_name" >/dev/null 2>&1) \
      || die "sha256 mismatch for $archive_name"
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    expected="$(awk '{print $1}' "$checksum_file")"
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
    [ "$expected" = "$actual" ] || die "sha256 mismatch for $archive_name: expected $expected, got $actual"
    return
  fi

  die "sha256sum or shasum is required to verify $archive_name"
}

write_launcher() {
  launcher="$1"
  target="$2"

  tmp_launcher="${launcher}.tmp.$$"
  cat > "$tmp_launcher" <<EOF
#!/usr/bin/env sh
# riptide launcher - installed by riptide release installer
exec "$target" "\$@"
EOF
  chmod +x "$tmp_launcher" || return 1
  mv -f "$tmp_launcher" "$launcher" || return 1
}

ensure_launcher_can_be_managed() {
  launcher="$1"
  if [ -e "$launcher" ] && ! grep -q "installed by riptide release installer" "$launcher" 2>/dev/null; then
    if [ "$FORCE" -ne 1 ]; then
      die "$launcher already exists and was not created by this installer. Re-run with --force to overwrite it."
    fi
  fi
}

restore_previous_install() {
  current="$1"
  previous="$2"
  rm -rf "$current"
  if [ -e "$previous" ]; then
    mv "$previous" "$current"
  fi
}

target="$(detect_target)"
asset="riptide-${target}.tar.gz"

if [ -n "$BASE_URL" ]; then
  base="${BASE_URL%/}"
elif [ "$VERSION" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  tag="$(tag_for_version "$VERSION")"
  base="https://github.com/${REPO}/releases/download/${tag}"
fi

archive_url="${base}/${asset}"
checksum_url="${archive_url}.sha256"

print_banner
rule
printf '  %starget%s       %s\n' "$C_DIM" "$C_RESET" "$target"
printf '  %sversion%s      %s\n' "$C_DIM" "$C_RESET" "$VERSION"
printf '  %sarchive%s      %s\n' "$C_DIM" "$C_RESET" "$archive_url"
printf '  %sinstall dir%s  %s\n' "$C_DIM" "$C_RESET" "$INSTALL_DIR/current"
printf '  %slauncher%s     %s\n' "$C_DIM" "$C_RESET" "$BIN_DIR/riptide"
rule

if [ "$DRY_RUN" -eq 1 ]; then
  step "dry run"
  ok "no files changed"
  exit 0
fi

need tar
need mktemp
need mkdir
need chmod
need mv
need rm
need cp
need find

tmp="$(mktemp -d "${TMPDIR:-/tmp}/riptide-install.XXXXXX")"
mkdir -p "$tmp/extract"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

archive="$tmp/$asset"
checksum="$tmp/${asset}.sha256"

step "downloading release bundle"
info "$archive_url"
download "$archive_url" "$archive"
download "$checksum_url" "$checksum"
ok "downloaded ($(human_size "$archive"))"

step "verifying sha256"
verify_sha256 "$archive" "$checksum"
ok "checksum matches"

step "extracting"
tar -xzf "$archive" -C "$tmp/extract"
ok "unpacked to staging"

bundle_bin="$(find "$tmp/extract" -type f -path "*/bin/riptide" | head -n 1)"
[ -n "$bundle_bin" ] || die "release archive does not contain bin/riptide"
bundle_root="$(cd "$(dirname "$bundle_bin")/.." && pwd)"
[ -x "$bundle_root/bin/riptide" ] || chmod +x "$bundle_root/bin/riptide"

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
launcher="$BIN_DIR/riptide"
ensure_launcher_can_be_managed "$launcher"

staged="$INSTALL_DIR/.current.tmp.$$"
rm -rf "$staged"
mkdir -p "$staged"
cp -R "$bundle_root/." "$staged/"

step "activating release"
if "$staged/bin/riptide" --version >/dev/null 2>&1; then
  staged_version="$("$staged/bin/riptide" --version 2>/dev/null | head -n 1)"
else
  rm -rf "$staged"
  die "downloaded bundle was extracted, but staged/bin/riptide --version failed"
fi

previous="$INSTALL_DIR/.previous.$$"
current="$INSTALL_DIR/current"
rm -rf "$previous"
if [ -e "$current" ]; then
  mv "$current" "$previous"
fi

if ! mv "$staged" "$current"; then
  restore_previous_install "$current" "$previous"
  die "failed to activate new install"
fi

if ! write_launcher "$launcher" "$current/bin/riptide"; then
  restore_previous_install "$current" "$previous"
  die "failed to write launcher at $launcher"
fi

if "$launcher" --version >/dev/null 2>&1; then
  installed_version="$("$launcher" --version 2>/dev/null | head -n 1)"
else
  restore_previous_install "$current" "$previous"
  die "installed launcher exists, but '$launcher --version' failed"
fi

rm -rf "$previous"
ok "installed: $installed_version"
info "staged bundle: $staged_version"

case ":$PATH:" in
  *":$BIN_DIR:"*)
    ok "$BIN_DIR is on PATH"
    PATH_HINT=""
    ;;
  *)
    warn "$BIN_DIR is not on your PATH"
    warn "add this to your shell rc (~/.bashrc, ~/.zshrc, …):"
    warn "  export PATH=\"$BIN_DIR:\$PATH\""
    PATH_HINT="path-not-set"
    ;;
esac

# ---------- completion ----------
END_TS="$(date +%s 2>/dev/null || echo 0)"
ELAPSED=0
if [ "$START_TS" -gt 0 ] && [ "$END_TS" -ge "$START_TS" ]; then
  ELAPSED="$((END_TS - START_TS))"
fi
ELAPSED_MIN="$((ELAPSED / 60))"
ELAPSED_SEC="$((ELAPSED % 60))"

printf '\n'
rule
if [ "$ELAPSED" -gt 0 ]; then
  printf '  %s✓%s %sRiptide installed%s %sin %dm %02ds%s\n' \
    "$C_GREEN" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_DIM" "$ELAPSED_MIN" "$ELAPSED_SEC" "$C_RESET"
else
  printf '  %s✓%s %sRiptide installed%s\n' "$C_GREEN" "$C_RESET" "$C_BOLD" "$C_RESET"
fi
rule
printf '\n  %sNext:%s\n' "$C_BOLD" "$C_RESET"
if [ -n "$PATH_HINT" ]; then
  printf '    %s%s%s\n' "$C_DIM" "(open a new shell or update PATH first)" "$C_RESET"
fi
printf '    1. %sriptide doctor%s          %s# verify your toolchain%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
printf '    2. %scd <your-program>%s       %s# the Solana program you want to simulate%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
printf '    3. %sriptide init%s            %s# thin .riptide/ bootstrap%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
printf '    4. %s/riptide-config%s         %s# configure adapter, harness, scenarios, campaign readiness%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
printf '\n  %sNew to Riptide?%s %sriptide --help%s walks through the full surface.\n' "$C_DIM" "$C_RESET" "$C_BOLD" "$C_RESET"
printf '\n'

#!/usr/bin/env sh
# Riptide release installer.
#
# Public entrypoint once hosted:
#   curl -fsSL https://riptide.run/install | sh
#
# This installs prebuilt release bundles. It deliberately does not build
# from source and does not require Rust, npm, or cargo-build-sbf on the
# end-user machine. Keep ./install.sh as the source-checkout installer.

set -eu

REPO="${RIPTIDE_GITHUB_REPO:-riptidesim/riptide}"
VERSION="${RIPTIDE_VERSION:-latest}"
BIN_DIR="${RIPTIDE_BIN_DIR:-$HOME/.local/bin}"
INSTALL_DIR="${RIPTIDE_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/riptide}"
BASE_URL="${RIPTIDE_RELEASE_BASE_URL:-}"
DRY_RUN=0
FORCE=0

say() { printf '%s\n' "$*"; }
warn() { printf 'riptide install: %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

usage() {
  cat <<'EOF'
Riptide release installer

Usage:
  curl -fsSL https://riptide.run/install | sh
  curl -fsSL https://riptide.run/install | sh -s -- --version 0.6.0

Options:
  --version <version>     Install a specific release. Accepts 0.6.0 or v0.6.0.
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
    *)
      die "no prebuilt Riptide release bundle for $os/$arch yet. Supported: Linux x86_64. Use the source installer: git clone https://github.com/$REPO && cd riptide && ./install.sh"
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

verify_sha256() {
  archive="$1"
  checksum_file="$2"
  archive_name="$(basename "$archive")"
  checksum_name="$(basename "$checksum_file")"
  checksum_dir="$(dirname "$checksum_file")"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$checksum_dir" && sha256sum -c "$checksum_name")
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

say "Riptide release install"
say "  target:      $target"
say "  version:     $VERSION"
say "  archive:     $archive_url"
say "  install dir: $INSTALL_DIR/current"
say "  launcher:    $BIN_DIR/riptide"

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry-run: no files changed"
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

say "downloading release bundle..."
download "$archive_url" "$archive"
download "$checksum_url" "$checksum"

say "verifying sha256..."
verify_sha256 "$archive" "$checksum"

say "extracting..."
tar -xzf "$archive" -C "$tmp/extract"

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
say "installed: $installed_version"
say "staged bundle: $staged_version"

case ":$PATH:" in
  *":$BIN_DIR:"*)
    say "ready: riptide is on PATH"
    ;;
  *)
    warn "$BIN_DIR is not on PATH"
    warn "add this to your shell rc:"
    warn "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

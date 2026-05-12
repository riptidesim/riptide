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

DEFAULT_REPO="riptidesim/riptide"
REPO="${RIPTIDE_GITHUB_REPO:-$DEFAULT_REPO}"
VERSION="${RIPTIDE_VERSION:-latest}"
BIN_DIR="${RIPTIDE_BIN_DIR:-$HOME/.local/bin}"
INSTALL_DIR="${RIPTIDE_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/riptide}"
BASE_URL="${RIPTIDE_RELEASE_BASE_URL:-}"
RELEASE_PROXY_BASE="${RIPTIDE_RELEASE_PROXY_BASE:-https://riptide.run/releases}"
DRY_RUN=0
FORCE=0
INSTALL_AGENT_SKILLS="${RIPTIDE_INSTALL_AGENT_SKILLS:-1}"
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
  curl -fsSL https://riptide.run/install | sh -s -- --version 0.9.1

Options:
  --version <version>     Install a specific release. Accepts 0.9.1 or v0.9.1.
                          Defaults to latest.
  --bin-dir <dir>         Directory for the riptide launcher.
                          Defaults to $HOME/.local/bin.
  --install-dir <dir>     Directory for the unpacked release bundle.
                          Defaults to $XDG_DATA_HOME/riptide or
                          $HOME/.local/share/riptide.
  --dry-run               Print what would happen without downloading.
  --force                 Overwrite an existing unmanaged launcher.
  --no-agent-skills       Do not install bundled Codex/Claude agent skills.
  -h, --help              Show this help.

Environment:
  RIPTIDE_VERSION
  RIPTIDE_BIN_DIR
  RIPTIDE_INSTALL_DIR
  RIPTIDE_RELEASE_BASE_URL  Override the release download base.
  RIPTIDE_RELEASE_PROXY_BASE
                            Defaults to https://riptide.run/releases for
                            official Riptide release downloads.
  RIPTIDE_GITHUB_REPO       Defaults to riptidesim/riptide.
  RIPTIDE_INSTALL_AGENT_SKILLS
                            Set to 0/false/no to skip agent skill install.
  CODEX_HOME                Defaults to $HOME/.codex.
  CLAUDE_HOME               Defaults to $HOME/.claude.
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
    --no-agent-skills)
      INSTALL_AGENT_SKILLS=0
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
    retry_connrefused=""
    if curl --help all 2>/dev/null | grep -q -- '--retry-connrefused'; then
      retry_connrefused="--retry-connrefused"
    fi
    if curl -fsSL --retry 3 --retry-delay 2 --retry-max-time 90 $retry_connrefused "$url" -o "$dest"; then
      return 0
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q --tries=3 --waitretry=2 -O "$dest" "$url"; then
      return 0
    fi
  else
    die "curl or wget is required to download release artifacts"
  fi
  die "failed to download $url. Retry in a moment, check access to the release host, or set RIPTIDE_RELEASE_BASE_URL to a mirror containing $asset and $asset.sha256"
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

agent_skills_enabled() {
  case "$INSTALL_AGENT_SKILLS" in
    0|false|FALSE|False|no|NO|No|off|OFF|Off)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

install_skill_for_agent() {
  agent_label="$1"
  skills_dir="$2"
  skill_src="$3"
  skill_name="$4"
  target="$skills_dir/$skill_name"
  marker=".riptide-managed-skill"

  if ! mkdir -p "$skills_dir" 2>/dev/null; then
    warn "could not create $skills_dir; skipping $agent_label skill $skill_name"
    return 0
  fi

  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ -L "$target" ]; then
      link_dest="$(readlink "$target" 2>/dev/null || true)"
      if [ "$link_dest" = "$skill_src" ]; then
        ok "$agent_label skill already installed: $skill_name"
        return 0
      fi
      warn "$agent_label skill symlink points elsewhere; leaving it unchanged: $target"
      return 0
    elif [ -f "$target/$marker" ]; then
      if ! rm -rf "$target" 2>/dev/null; then
        warn "could not replace managed $agent_label skill at $target"
        return 0
      fi
    else
      warn "$agent_label skill exists and is not Riptide-managed; leaving it unchanged: $target"
      return 0
    fi
  fi

  if ln -s "$skill_src" "$target" 2>/dev/null; then
    ok "installed $agent_label skill: $skill_name"
    info "$target -> $skill_src"
    return 0
  fi

  rm -rf "$target" 2>/dev/null || true
  if cp -R "$skill_src" "$target" 2>/dev/null; then
    {
      printf '%s\n' 'installed by riptide release installer'
      printf 'source: %s\n' "$skill_src"
    } > "$target/$marker" 2>/dev/null || true
    ok "installed $agent_label skill: $skill_name"
    info "$target"
  else
    rm -rf "$target" 2>/dev/null || true
    warn "could not install $agent_label skill $skill_name into $skills_dir"
  fi
}

install_agent_skills() {
  current_root="$1"

  if ! agent_skills_enabled; then
    info "agent skill install disabled"
    return 0
  fi

  source_root="$current_root/skills"
  if [ ! -d "$source_root" ]; then
    warn "release bundle has no skills directory; skipping agent skill install"
    return 0
  fi

  found=0
  for skill_src in "$source_root"/*; do
    [ -d "$skill_src" ] || continue
    [ -f "$skill_src/SKILL.md" ] || continue
    found=1
    skill_src_abs="$(cd "$skill_src" && pwd)"
    skill_name="$(basename "$skill_src")"
    install_skill_for_agent "Codex" "${CODEX_HOME:-$HOME/.codex}/skills" "$skill_src_abs" "$skill_name"
    install_skill_for_agent "Claude" "${CLAUDE_HOME:-$HOME/.claude}/skills" "$skill_src_abs" "$skill_name"
  done

  if [ "$found" -eq 0 ]; then
    warn "release bundle has no installable skills; expected directories with SKILL.md under $source_root"
  fi
}

target="$(detect_target)"
asset="riptide-${target}.tar.gz"

if [ -n "$BASE_URL" ]; then
  base="${BASE_URL%/}"
elif [ "$REPO" = "$DEFAULT_REPO" ]; then
  release_base="${RELEASE_PROXY_BASE%/}"
  if [ "$VERSION" = "latest" ]; then
    base="${release_base}/latest/download"
  else
    tag="$(tag_for_version "$VERSION")"
    base="${release_base}/download/${tag}"
  fi
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
if agent_skills_enabled; then
  printf '  %sagent skills%s  enabled\n' "$C_DIM" "$C_RESET"
else
  printf '  %sagent skills%s  disabled\n' "$C_DIM" "$C_RESET"
fi
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

step "installing agent skills"
current_abs="$(cd "$current" && pwd)"
install_agent_skills "$current_abs"

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
if agent_skills_enabled; then
  printf '    %s%s%s\n' "$C_DIM" "(start a new Codex/Claude session before using /riptide-config)" "$C_RESET"
fi
printf '    1. %sriptide --help%s          %s# verify the launcher%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
printf '    2. %scd <your-program>%s       %s# the Solana program you want to simulate%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
printf '    3. %sriptide init%s            %s# thin .riptide/ bootstrap%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
printf '    4. %s/riptide-config%s         %s# configure adapter, harness, scenarios, campaign readiness%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
printf '    5. %sriptide doctor%s          %s# check the configured workspace%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
printf '\n  %sNew to Riptide?%s %sriptide --help%s walks through the full surface.\n' "$C_DIM" "$C_RESET" "$C_BOLD" "$C_RESET"
printf '\n'

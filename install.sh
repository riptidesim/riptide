#!/usr/bin/env bash
# Riptide install.sh
# ------------------
# Single-command bootstrap for Riptide on Linux.
#
# Scope:
# - Linux only. Assumes Rust (rustup) and Node.js are already installed.
# - macOS is not tested. It may work because every step is POSIX-ish,
#   but nothing here is validated on Darwin.
# - Windows is explicitly out of scope.
#
# What it does:
# 1. Detects required toolchains and prints actionable hints on the
#    ones it cannot find (rustc, cargo, node, npm, cargo-build-sbf).
# 2. Installs CLI dependencies and builds the TypeScript CLI.
# 3. Installs a `riptide` launcher into $HOME/.local/bin.
# 4. Verifies the CLI responds to `--version`/`--help` and runs
#    `riptide doctor` as a toolchain self-check.
#
# Riptide runs deterministic guided simulations: `riptide sim generate`
# scaffolds a project-owned Rust crate that builds against the vendored
# `riptide-sim` runtime, so there is no separate engine binary to build
# or ship. You bring your own Solana program; the SBF toolchain builds
# its `.so`.
#
# Idempotent: running it twice is safe. npm handles its own incremental
# builds; the launcher step uses an atomic rewrite so it never errors on
# an existing target.
#
# Never runs sudo. If a dependency is missing the script tells you the
# exact command to run yourself and exits.

set -euo pipefail

# Resolve repo root (where this script lives) and move there so every
# build command is rooted the same way regardless of the caller's cwd.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# ---------- cosmetic helpers ----------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; RESET=''
fi

ts() { date +%H:%M:%S; }
log()   { printf '%s[%s]%s %s\n' "$DIM" "$(ts)" "$RESET" "$*"; }
info()  { printf '%s[%s]%s %s%s%s\n' "$DIM" "$(ts)" "$RESET" "$CYAN" "$*" "$RESET"; }
ok()    { printf '%s[%s]%s %s%s%s\n' "$DIM" "$(ts)" "$RESET" "$GREEN" "$*" "$RESET"; }
warn()  { printf '%s[%s]%s %s%s%s\n' "$DIM" "$(ts)" "$RESET" "$YELLOW" "$*" "$RESET"; }
fail()  { printf '%s[%s]%s %s%s%s\n' "$DIM" "$(ts)" "$RESET" "$RED"   "$*" "$RESET" >&2; }

TOTAL_STEPS=5
STEP_NUM=0
CURRENT_STEP="startup"
banner() {
  STEP_NUM=$((STEP_NUM + 1))
  CURRENT_STEP="$1"
  printf '\n%s==> Step %d/%d: %s%s\n' "$BOLD" "$STEP_NUM" "$TOTAL_STEPS" "$1" "$RESET"
}

on_error() {
  local exit_code=$?
  local lineno=${1:-?}
  fail "install failed at step: ${CURRENT_STEP} (line ${lineno}, exit ${exit_code})"
  fail "see the output above for the underlying error. fixes to try:"
  fail "  * re-run ./install.sh — transient network errors (npm) usually clear on retry"
  fail "  * if a toolchain is wrong, check riptide/TOOLCHAIN.md for the pinned versions"
  fail "  * if cargo-build-sbf is missing, see https://solana.com/docs/intro/installation"
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

# ---------- Step 1: detect toolchains ----------
banner "detecting toolchains"

have() { command -v "$1" >/dev/null 2>&1; }

require_or_hint() {
  local bin="$1" hint="$2"
  if ! have "$bin"; then
    fail "required tool not found on PATH: $bin"
    fail "$hint"
    exit 1
  fi
}

log "running: rustc --version"
require_or_hint rustc \
  "Rust not installed — install rustup from https://rustup.rs/, then re-run ./install.sh"
RUSTC_VER="$(rustc --version || true)"
ok   "rustc: ${RUSTC_VER}"

log "running: cargo --version"
require_or_hint cargo \
  "cargo not found — reinstall rustup (https://rustup.rs/) and re-run ./install.sh"
CARGO_VER="$(cargo --version || true)"
ok   "cargo: ${CARGO_VER}"

log "running: node --version"
require_or_hint node \
  "Node.js not installed — install node >=20 (https://nodejs.org/) and re-run ./install.sh"
NODE_VER="$(node --version || true)"
ok   "node: ${NODE_VER}"

log "running: npm --version"
require_or_hint npm \
  "npm not found — it ships with Node.js; reinstall node and re-run ./install.sh"
NPM_VER="$(npm --version || true)"
ok   "npm: ${NPM_VER}"

# Solana SBF toolchain detection. `riptide sim run` builds a generated
# guided-sim crate with regular cargo, but you still need cargo-build-sbf
# to build the Solana program you are simulating into its `.so`. The
# script never installs it for you because the Solana installer writes
# into $HOME/.local/share/solana and edits PATH.
log "running: cargo-build-sbf --version"
SBF_VER=""
if have cargo-build-sbf; then
  SBF_VER="$(cargo-build-sbf --version 2>&1 | head -n1 || true)"
elif cargo +solana build-sbf --version >/dev/null 2>&1; then
  SBF_VER="$(cargo +solana build-sbf --version 2>&1 | head -n1 || true)"
fi
if [ -z "$SBF_VER" ]; then
  fail "Solana SBF toolchain not found (cargo-build-sbf missing)"
  fail "install it once via:"
  fail "  sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
  fail "or see https://solana.com/docs/intro/installation for alternatives."
  fail "after install, ensure \$HOME/.local/share/solana/install/active_release/bin is on PATH,"
  fail "then re-run ./install.sh"
  exit 1
fi
ok   "cargo-build-sbf: ${SBF_VER}"

# Package manager presence (informational only — nothing in the build
# path requires apt/dnf, but it helps downstream debugging messages).
PKG_MGR=""
if have apt-get; then PKG_MGR="apt-get"
elif have dnf;     then PKG_MGR="dnf"
fi
if [ -n "$PKG_MGR" ]; then
  info "package manager: ${PKG_MGR} (informational — not invoked)"
else
  warn "no apt-get or dnf detected. the build path does not use either; this is only a note."
fi

# ---------- Step 2: npm install ----------
banner "installing CLI dependencies (npm install --ignore-scripts)"
log "running: (cd cli && npm install --no-audit --no-fund --ignore-scripts)"
( cd cli && npm install --no-audit --no-fund --ignore-scripts )
ok   "npm install done"

# ---------- Step 3: npm run build ----------
banner "building CLI (npm run build)"
log "running: (cd cli && npm run build)"
( cd cli && npm run build )
CLI_ENTRY="$REPO_ROOT/cli/dist/src/index.js"
if [ ! -f "$CLI_ENTRY" ]; then
  fail "CLI build reported success but entry point is missing:"
  fail "  $CLI_ENTRY"
  fail "check 'bin' field in cli/package.json and the tsc output."
  exit 1
fi
# The built file ships a `#!/usr/bin/env node` shebang; make it
# executable so direct invocation works too. The launcher path below
# uses a bash shim so this chmod is not load-bearing, but it costs
# nothing and keeps direct-path usage working.
chmod +x "$CLI_ENTRY" || true
ok   "CLI build done (entry: $CLI_ENTRY)"

# ---------- Step 4: install riptide shim into ~/.local/bin ----------
banner "installing riptide launcher into \$HOME/.local/bin"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/riptide"
mkdir -p "$BIN_DIR"

# We write a tiny bash shim instead of a raw symlink to the JS file so
# the launcher stays stable across node versions and does not depend on
# chmod semantics of the tsc output. The shim is rewritten every run
# (it is tiny and idempotent).
TMP_LAUNCHER="${LAUNCHER}.tmp.$$"
cat > "$TMP_LAUNCHER" <<EOF
#!/usr/bin/env bash
# Riptide CLI launcher — installed by riptide/install.sh
set -euo pipefail

CLI_ROOT="$REPO_ROOT/cli"
CLI_ENTRY="$CLI_ENTRY"

if [ ! -f "\$CLI_ENTRY" ]; then
  printf 'riptide: CLI build artifact is missing: %s\n' "\$CLI_ENTRY" >&2
  if ! command -v npm >/dev/null 2>&1; then
    printf 'riptide: npm is not on PATH, so the source checkout launcher cannot rebuild the CLI.\n' >&2
    printf 'riptide: fix: cd %s && npm install --no-audit --no-fund --ignore-scripts && npm run build\n' "\$CLI_ROOT" >&2
    exit 127
  fi
  printf 'riptide: rebuilding CLI from source with npm run build...\n' >&2
  if ! ( cd "\$CLI_ROOT" && npm run build >&2 ); then
    printf 'riptide: rebuild failed. Try: cd %s && npm install --no-audit --no-fund --ignore-scripts && npm run build\n' "\$CLI_ROOT" >&2
    exit 127
  fi
fi

exec node "\$CLI_ENTRY" "\$@"
EOF
chmod +x "$TMP_LAUNCHER"
mv -f "$TMP_LAUNCHER" "$LAUNCHER"
ok   "launcher installed: $LAUNCHER -> $CLI_ENTRY"

case ":$PATH:" in
  *":$BIN_DIR:"*)
    info "\$HOME/.local/bin is already on PATH"
    ;;
  *)
    warn "\$HOME/.local/bin is NOT on your PATH."
    warn "add this to your shell rc (~/.bashrc or ~/.zshrc):"
    warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    warn "then reopen the shell or: source ~/.bashrc"
    ;;
esac

# ---------- Step 5: verify & toolchain self-check ----------
banner "verifying install"
log "running: $LAUNCHER --version"
if ! VERSION_OUT="$("$LAUNCHER" --version 2>&1)"; then
  fail "'$LAUNCHER --version' failed. output:"
  printf '%s\n' "$VERSION_OUT" >&2
  fail "check that node can execute $CLI_ENTRY directly:"
  fail "  node $CLI_ENTRY --version"
  exit 1
fi
ok   "riptide --version: ${VERSION_OUT}"

log "running: $LAUNCHER --help"
if ! "$LAUNCHER" --help >/dev/null 2>&1; then
  fail "'$LAUNCHER --help' failed."
  fail "  node $CLI_ENTRY --help"
  exit 1
fi
ok   "riptide --help responded"

# `riptide doctor` is the toolchain self-check. It is static (no build,
# no network, no simulation) and exits non-zero on a hard toolchain
# failure; a WARN verdict (e.g. a Solana version drift) is acceptable for
# a successful install, so do not treat exit 1 as fatal here.
log "running: $LAUNCHER doctor"
DOCTOR_EXIT=0
"$LAUNCHER" doctor || DOCTOR_EXIT=$?
if [ "$DOCTOR_EXIT" -ge 2 ]; then
  fail "'riptide doctor' reported a hard failure (exit ${DOCTOR_EXIT})."
  fail "address the FAIL rows above, then re-run: riptide doctor"
  exit 1
fi
ok   "riptide doctor passed (exit ${DOCTOR_EXIT})"

# ---------- completion ----------
ELAPSED=$SECONDS
MIN=$((ELAPSED / 60))
SEC=$((ELAPSED % 60))
printf '\n%s=====================================================%s\n' "$BOLD" "$RESET"
printf '%sRiptide install complete in %dm %02ds%s\n' "$GREEN" "$MIN" "$SEC" "$RESET"
printf '%s=====================================================%s\n' "$BOLD" "$RESET"
printf '\nnext steps:\n'
printf '  1. %sriptide doctor%s                        # verify your toolchain\n' "$BOLD" "$RESET"
printf '  2. %scd <your-program>%s                     # the Solana program you want to simulate\n' "$BOLD" "$RESET"
printf '  3. %sriptide init%s                          # thin .riptide/ bootstrap\n' "$BOLD" "$RESET"
printf '  4. %s/riptide-config%s                       # finish the adapter and author the guided simulation\n' "$BOLD" "$RESET"
printf '\n%sNew to Riptide?%s %sriptide --help%s walks through the full surface.\n' "$DIM" "$RESET" "$BOLD" "$RESET"

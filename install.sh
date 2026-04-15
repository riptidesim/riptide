#!/usr/bin/env bash
# Riptide install.sh
# ------------------
# Single-command bootstrap for Riptide on Linux.
#
# Scope (Sprint 5 Phase 0):
#   - Linux only. Assumes Rust (rustup) and Node.js are already installed.
#   - macOS is not tested. It may work because every step is POSIX-ish,
#     but nothing here is validated on Darwin.
#   - Windows is explicitly out of scope.
#
# What it does:
#   1. Detects required toolchains and prints actionable hints on the
#      ones it cannot find.
#   2. Builds the Rust engine (release), both shipped on-chain programs
#      (lending_pool.so + resource_grinder.so via cargo-build-sbf), and
#      the TypeScript CLI.
#   3. Installs a `riptide` launcher into $HOME/.local/bin.
#   4. Verifies the CLI responds to --help, runs
#      `riptide run demo/configs/safe.json` as the lending smoke test,
#      and runs a short resource-grinder simulation as the generic
#      adapter smoke test.
#
# Idempotent: running it twice is safe. Cargo and npm handle their own
# incremental builds; the symlink step uses `ln -sfn` so it never errors
# on an existing target.
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

TOTAL_STEPS=8
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
  fail "  * re-run ./install.sh — transient network errors (cargo/npm) usually clear on retry"
  fail "  * if a toolchain is wrong, check riptide/TOOLCHAIN.md for the pinned versions"
  fail "  * if cargo-build-sbf fails, confirm you are on solana-cli 3.0.13 (solana --version)"
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

# Solana SBF toolchain detection. The script never installs it on your
# behalf without an explicit opt-in because the Solana installer writes
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

# ---------- Step 2: cargo build engine ----------
banner "building engine (cargo build --release -p riptide-engine)"
log "running: cargo build --release -p riptide-engine"
cargo build --release -p riptide-engine
ok   "engine build done"

# ---------- Step 3: cargo build-sbf (all shipped on-chain programs) ----------
banner "building on-chain programs (cargo build-sbf — shipped programs)"

# Helper: build a single program with a clear banner and an existence
# assertion on the resulting .so.
build_program_so() {
  local prog_dir="$1" so_name="$2"
  local so_path="$REPO_ROOT/programs/$prog_dir/target/deploy/$so_name"
  if [ -f "$so_path" ]; then
    info "existing $so_name detected — cargo-build-sbf will fast-forward if up to date"
  fi
  log "running: cargo build-sbf --manifest-path programs/$prog_dir/Cargo.toml"
  if have cargo-build-sbf; then
    cargo build-sbf --manifest-path "programs/$prog_dir/Cargo.toml"
  else
    cargo +solana build-sbf --manifest-path "programs/$prog_dir/Cargo.toml"
  fi
  if [ ! -f "$so_path" ]; then
    fail "cargo build-sbf reported success but $so_name is missing at:"
    fail "  $so_path"
    fail "re-run:  cd programs/$prog_dir && cargo build-sbf"
    fail "and inspect the output for SBF toolchain errors."
    exit 1
  fi
  ok   "$so_name ready at $so_path"
}

build_program_so lending_pool     lending_pool.so
build_program_so resource_grinder resource_grinder.so

LENDING_SO_PATH="$REPO_ROOT/programs/lending_pool/target/deploy/lending_pool.so"
GENERIC_SO_PATH="$REPO_ROOT/programs/resource_grinder/target/deploy/resource_grinder.so"

# ---------- Step 4: npm install ----------
banner "installing CLI dependencies (npm install)"
log "running: (cd cli && npm install --no-audit --no-fund)"
( cd cli && npm install --no-audit --no-fund )
ok   "npm install done"

# ---------- Step 5: npm run build ----------
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
# executable so direct invocation works too. The symlink path below
# uses a bash shim so this chmod is not load-bearing, but it costs
# nothing and keeps direct-path usage working.
chmod +x "$CLI_ENTRY" || true
ok   "CLI build done (entry: $CLI_ENTRY)"

# ---------- Step 6: install riptide shim into ~/.local/bin ----------
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
exec node "$CLI_ENTRY" "\$@"
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

# ---------- Step 7: verify & smoke test ----------
banner "verifying install"
log "running: $LAUNCHER --help"
if ! HELP_OUT="$("$LAUNCHER" --help 2>&1)"; then
  fail "'$LAUNCHER --help' failed. output:"
  printf '%s\n' "$HELP_OUT" >&2
  fail "check that node can execute $CLI_ENTRY directly:"
  fail "  node $CLI_ENTRY --help"
  exit 1
fi
ok   "riptide --help responded"

log "running safe lending smoke test: riptide run demo/configs/safe.json"
SMOKE_OUT_DIR="$REPO_ROOT/demo/outputs/safe"
mkdir -p "$REPO_ROOT/demo/outputs"
rm -rf "$SMOKE_OUT_DIR"

# Shock knob matches demo/run-demo.sh — the canonical demo runs this way
# and we want our smoke test to execute the same path.
export RIPTIDE_PRICE_SHOCK_DROP=0.5
unset RIPTIDE_ENGINE_BIN RIPTIDE_POOL_LTV_BPS RIPTIDE_POOL_LIQ_THRESHOLD_BPS \
      RIPTIDE_POOL_LIQ_BONUS_BPS RIPTIDE_SEED_COLLATERAL RIPTIDE_STARTING_BALANCE || true

# The spec's exact phrasing is `riptide run demo/configs/safe.json`.
# The `run` subcommand reads the JSON config, applies the shipped
# solend-fork adapter by default, and dispatches the simulate flow.
if ! ( cd "$REPO_ROOT" && "$LAUNCHER" run demo/configs/safe.json ); then
  fail "smoke test failed: 'riptide run demo/configs/safe.json' did not exit cleanly."
  fail "try reproducing manually from the repo root:"
  fail "  riptide run demo/configs/safe.json"
  fail "  bash demo/run-demo.sh      # fuller demo"
  fail "if either passes, this is an install-flow bug; open an issue with the full output."
  exit 1
fi

if [ ! -f "$SMOKE_OUT_DIR/simulation-result.json" ]; then
  fail "smoke test exited 0 but no simulation-result.json was written at:"
  fail "  $SMOKE_OUT_DIR/simulation-result.json"
  fail "this usually means the CLI's --output plumbing changed shape."
  exit 1
fi
ok   "lending smoke test green (artifact: $SMOKE_OUT_DIR/simulation-result.json)"

# ---------- Step 8: generic adapter smoke test ----------
banner "verifying the shipped generic adapter (resource-grinder)"
# The generic smoke bypasses the CLI persona compiler and invokes the
# engine binary directly with the shipped `generic-demo.run.json` + the
# `resource-grinder.toml` adapter. The engine's generic primitive pulls
# personas straight from the adapter TOML (unlike the CLI simulate
# path, which compiles personas via the LLM/fallback catalog and does
# not know about custom generic persona names).
GENERIC_OUT_DIR="$REPO_ROOT/demo/outputs/generic-smoke"
rm -rf "$GENERIC_OUT_DIR"
mkdir -p "$GENERIC_OUT_DIR"
GENERIC_RESULT="$GENERIC_OUT_DIR/simulation-result.json"
# Generic adapters source their personas from the adapter TOML, so the
# engine accepts an empty external-policies array for this path.
GENERIC_POLICIES="$GENERIC_OUT_DIR/policies.json"
printf '[]' > "$GENERIC_POLICIES"
ENGINE_BIN="$REPO_ROOT/target/release/riptide-engine"
log "running: $ENGINE_BIN --adapter fixtures/adapters/resource-grinder.toml --config fixtures/generic-demo.run.json"
if ! ( cd "$REPO_ROOT" && "$ENGINE_BIN" \
        --adapter "$REPO_ROOT/fixtures/adapters/resource-grinder.toml" \
        --config  "$REPO_ROOT/fixtures/generic-demo.run.json" \
        --policies "$GENERIC_POLICIES" \
        --output  "$GENERIC_RESULT" ); then
  fail "generic smoke test failed: the engine did not accept the resource-grinder adapter cleanly."
  fail "reproduce manually from the repo root:"
  fail "  echo '[]' > /tmp/empty-policies.json"
  fail "  target/release/riptide-engine \\"
  fail "    --adapter fixtures/adapters/resource-grinder.toml \\"
  fail "    --config  fixtures/generic-demo.run.json \\"
  fail "    --policies /tmp/empty-policies.json \\"
  fail "    --output  demo/outputs/generic-smoke/simulation-result.json"
  fail "common cause: $GENERIC_SO_PATH missing or stale. Re-run install.sh."
  exit 1
fi

if [ ! -f "$GENERIC_RESULT" ]; then
  fail "generic smoke test exited 0 but no simulation-result.json was written at:"
  fail "  $GENERIC_RESULT"
  exit 1
fi
ok   "generic smoke test green (artifact: $GENERIC_RESULT)"

# ---------- completion ----------
ELAPSED=$SECONDS
MIN=$((ELAPSED / 60))
SEC=$((ELAPSED % 60))
printf '\n%s=====================================================%s\n' "$BOLD" "$RESET"
printf '%sRiptide install complete in %dm %02ds%s\n' "$GREEN" "$MIN" "$SEC" "$RESET"
printf '%s=====================================================%s\n' "$BOLD" "$RESET"
printf '\nnext steps:\n'
printf '  - %sriptide --help%s                         # CLI overview\n' "$BOLD" "$RESET"
printf '  - %sbash demo/run-demo.sh%s                  # safe vs risky lending headline\n' "$BOLD" "$RESET"
printf '  - browse %sdemo/configs/%s and %sfixtures/%s for more runs\n' "$BOLD" "$RESET" "$BOLD" "$RESET"
printf '  - see README.md for the full tour\n'

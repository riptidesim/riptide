#!/usr/bin/env bash
set -euo pipefail

EXPECTED_FLAGSHIP_HASH="d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb"
EXPECTED_PROOF_REVIEW_EXIT=1

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_SHA="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
TMP_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/riptide-cli-clean-checkout.XXXXXX")"
CHECKOUT="$TMP_PARENT/checkout"
ARTIFACTS="$TMP_PARENT/artifacts"
DOCTOR_WORKSPACE="$TMP_PARENT/doctor-workspace"
SETUP_LOG_DIR="$TMP_PARENT/setup-logs"
SETUP_STEP=0

dirty_status="$(git -C "$SOURCE_ROOT" status --porcelain=v1 -uall)"
if [[ -n "$dirty_status" ]]; then
  if [[ "${RIPTIDE_CLEAN_CHECKOUT_REQUIRE_CLEAN:-0}" == "1" ]]; then
    printf 'dirty worktree: refusing to run clean-checkout smoke against stale HEAD\n' >&2
    printf 'The gate clones and tests git HEAD only. Commit, stash, or set RIPTIDE_CLEAN_CHECKOUT_REQUIRE_CLEAN=0 for an explicit development run.\n' >&2
    printf '%s\n' "$dirty_status" >&2
    exit 2
  fi
  CLEAN_CHECKOUT_DIRTY_NOTE="yes"
else
  CLEAN_CHECKOUT_DIRTY_NOTE="no"
fi

cleanup() {
  if [[ "${RIPTIDE_CLEAN_CHECKOUT_KEEP:-0}" == "1" ]]; then
    printf 'kept temp root: %s\n' "$TMP_PARENT"
  else
    rm -rf "$TMP_PARENT"
  fi
}
trap cleanup EXIT

run_setup() {
  SETUP_STEP=$((SETUP_STEP + 1))
  local label="$1"
  shift
  local log="$SETUP_LOG_DIR/${SETUP_STEP}.log"
  printf '\n$ %s\n' "$*"
  if "$@" >"$log" 2>&1; then
    printf '[ok] %s\n' "$label"
  else
    local status=$?
    printf '[exit %s] %s\n' "$status" "$label"
    printf '%s\n' "--- setup log: $log ---"
    cat "$log"
    exit "$status"
  fi
}

run_checked() {
  local cwd="$1"
  local expected="$2"
  shift 2
  printf '\n$ (cd %s && %s)\n' "$cwd" "$*"
  set +e
  (
    cd "$cwd"
    NO_COLOR=1 RIPTIDE_ENGINE_BIN="$CHECKOUT/target/release/riptide-engine" "$@"
  ) 2>&1
  local status=$?
  set -e
  printf '[exit %s]\n' "$status"
  if [[ "$status" -ne "$expected" ]]; then
    printf 'expected exit %s, got %s\n' "$expected" "$status" >&2
    exit 1
  fi
}

printf '== Riptide CLI clean-checkout smoke ==\n'
printf 'source: %s\n' "$SOURCE_ROOT"
printf 'source commit: %s\n' "$SOURCE_SHA"
printf 'temp checkout: %s\n' "$CHECKOUT"
printf 'expected flagship canonical hash: %s\n' "$EXPECTED_FLAGSHIP_HASH"
printf 'accepted proof review exit: %s\n' "$EXPECTED_PROOF_REVIEW_EXIT"
printf 'network boundary: npm/cargo may use configured package caches or registries; no RPC, mainnet writes, secrets, push, or publish.\n'
if [[ "$CLEAN_CHECKOUT_DIRTY_NOTE" == "yes" ]]; then
  printf 'warning: source worktree is dirty; this smoke clones and tests git HEAD only. Set RIPTIDE_CLEAN_CHECKOUT_REQUIRE_CLEAN=1 to fail closed.\n'
  printf '%s\n' "$dirty_status"
fi

mkdir -p "$CHECKOUT" "$ARTIFACTS" "$DOCTOR_WORKSPACE/.riptide/adapters" "$SETUP_LOG_DIR"
git clone --quiet --no-checkout "$SOURCE_ROOT" "$CHECKOUT"
git -C "$CHECKOUT" checkout --quiet --detach "$SOURCE_SHA"

cd "$CHECKOUT"

run_setup "install CLI dependencies" npm --prefix cli ci --ignore-scripts --no-audit --no-fund
run_setup "build CLI" npm --prefix cli run build
run_setup "build riptide-engine" cargo build --release -p riptide-engine
run_setup "build lending_pool SBF program" cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml
run_setup "build admin_mock_oracle SBF program" cargo build-sbf --manifest-path programs/admin_mock_oracle/Cargo.toml
run_setup "build liquid_staking SBF program" cargo build-sbf --manifest-path programs/liquid-staking/Cargo.toml

cp fixtures/adapters/lending.toml "$DOCTOR_WORKSPACE/.riptide/adapters/lending.toml"

RIPTIDE=(node "$CHECKOUT/cli/dist/src/index.js")
FLAGSHIP_PACK=".riptide/pack/replay-multi-lst-lending-contagion-proof-upstream"
FLAGSHIP_MANIFEST="$FLAGSHIP_PACK/manifest.json"

run_checked "$DOCTOR_WORKSPACE" 0 "${RIPTIDE[@]}" doctor --quiet
run_checked "$CHECKOUT" 0 "${RIPTIDE[@]}" run examples/configs/safe.json --adapter fixtures/adapters/lending.toml --output-dir "$ARTIFACTS/run-safe" --quiet
run_checked "$CHECKOUT" 0 "${RIPTIDE[@]}" campaign run fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml --max-runs 1 --out "$ARTIFACTS/campaign"
run_checked "$CHECKOUT" 0 "${RIPTIDE[@]}" replay fixtures/replays/lst-lending-contagion-proof/config.json --allow-invariant-violations --quiet
run_checked "$CHECKOUT" 0 ./scripts/ci/assert-canonical-hash.sh "$FLAGSHIP_MANIFEST" "$EXPECTED_FLAGSHIP_HASH"
run_checked "$CHECKOUT" "$EXPECTED_PROOF_REVIEW_EXIT" "${RIPTIDE[@]}" review "$FLAGSHIP_PACK" --quiet

printf '\ncli clean-checkout smoke passed\n'

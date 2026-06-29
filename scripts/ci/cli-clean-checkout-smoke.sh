#!/usr/bin/env bash
set -euo pipefail

# Riptide CLI clean-checkout smoke.
#
# Proves the engine-free install path works from a pristine clone of
# git HEAD: clone the current commit into a temp dir, run `./install.sh`
# (detect toolchains -> npm install -> npm build -> install launcher ->
# verify), then re-assert the read-only CLI surface from a clean shell:
#   - `riptide --version`
#   - `riptide --help`
#   - `riptide doctor`  (exit >= 2 is a hard failure; a WARN verdict at
#                         exit 1 is acceptable, matching install.sh)
#
# Network boundary: npm/cargo may use configured package caches or
# registries; no RPC, mainnet writes, secrets, push, or publish.

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_SHA="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
TMP_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/riptide-cli-clean-checkout.XXXXXX")"
CHECKOUT="$TMP_PARENT/checkout"
# Keep install.sh's launcher + any per-user state inside the temp root
# so the smoke never writes to the runner's real $HOME/.local/bin.
HOME="$TMP_PARENT/home"
export HOME
LOCAL_BIN="$HOME/.local/bin"
LAUNCHER="$LOCAL_BIN/riptide"

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

run_checked() {
  local expected="$1"
  shift
  printf '\n$ %s\n' "$*"
  set +e
  NO_COLOR=1 "$@"
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
printf 'temp HOME: %s\n' "$HOME"
printf 'network boundary: npm/cargo may use configured package caches or registries; no RPC, mainnet writes, secrets, push, or publish.\n'
if [[ "$CLEAN_CHECKOUT_DIRTY_NOTE" == "yes" ]]; then
  printf 'warning: source worktree is dirty; this smoke clones and tests git HEAD only. Set RIPTIDE_CLEAN_CHECKOUT_REQUIRE_CLEAN=1 to fail closed.\n'
  printf '%s\n' "$dirty_status"
fi

mkdir -p "$CHECKOUT" "$LOCAL_BIN"
git clone --quiet --no-checkout "$SOURCE_ROOT" "$CHECKOUT"
git -C "$CHECKOUT" checkout --quiet --detach "$SOURCE_SHA"

# install.sh does the full engine-free bootstrap: detect toolchains,
# npm install + build, install the launcher into $HOME/.local/bin, and
# verify --version / --help / doctor. A clean exit here already proves
# the install path; the explicit assertions below re-check the
# read-only CLI surface from a fresh shell.
printf '\n$ (cd %s && ./install.sh)\n' "$CHECKOUT"
( cd "$CHECKOUT" && ./install.sh )

if [[ ! -x "$LAUNCHER" ]]; then
  printf 'install.sh did not produce an executable launcher at %s\n' "$LAUNCHER" >&2
  exit 1
fi

run_checked 0 "$LAUNCHER" --version
run_checked 0 "$LAUNCHER" --help

# `riptide doctor` is the toolchain self-check. It exits 1 on a WARN
# verdict (acceptable) and >= 2 on a hard failure. Mirror install.sh:
# only exit >= 2 fails the smoke.
printf '\n$ %s doctor\n' "$LAUNCHER"
set +e
NO_COLOR=1 "$LAUNCHER" doctor
DOCTOR_EXIT=$?
set -e
printf '[exit %s]\n' "$DOCTOR_EXIT"
if [[ "$DOCTOR_EXIT" -ge 2 ]]; then
  printf 'riptide doctor reported a hard failure (exit %s)\n' "$DOCTOR_EXIT" >&2
  exit 1
fi

printf '\ncli clean-checkout smoke passed\n'

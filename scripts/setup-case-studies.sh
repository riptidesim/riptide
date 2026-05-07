#!/usr/bin/env bash
set -euo pipefail

# Bootstrap sibling case-study workspaces for Studio manual smoke.
#
# Prerequisite: build the CLI first so cli/dist/src/index.js exists:
#   cd cli && npm run build

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_ROOT/cli/dist/src/index.js"
CASE_ROOT="$REPO_ROOT/../case-studies"

if [[ ! -f "$CLI" ]]; then
  echo "missing $CLI"
  echo "run: cd cli && npm run build"
  exit 1
fi

mkdir -p "$CASE_ROOT"

setup_one() {
  local slug="$1"
  local protocol="$2"
  local target="$CASE_ROOT/$slug"
  mkdir -p "$target"
  if [[ -d "$target/.riptide" ]]; then
    echo "case-study $slug already has .riptide/; skipping init"
  else
    echo "scaffolding $slug ($protocol)"
    (cd "$target" && node "$CLI" init --blank --quiet --protocol "$protocol" --name "$slug")
  fi
}

setup_one "lending" "lending"
setup_one "amm" "amm"
setup_one "perpetuals" "perpetuals"

echo "running one-seed lending smoke"
set +e
(cd "$CASE_ROOT/lending" && node "$CLI" run --quiet --seeds 1)
SMOKE_STATUS=$?
set -e

if ! find "$CASE_ROOT/lending/.riptide/runs" -name simulation-result.json -type f -print -quit | grep -q .; then
  echo "lending smoke did not produce a simulation-result.json"
  exit "$SMOKE_STATUS"
fi
if [[ "$SMOKE_STATUS" -ne 0 ]]; then
  echo "lending smoke exited $SMOKE_STATUS after producing artifacts; keeping the failure evidence for Studio."
fi

echo "case-study tree:"
for slug in lending amm perpetuals; do
  echo "== $slug =="
  find "$CASE_ROOT/$slug/.riptide" \
    -maxdepth 2 \
    \( -name target -o -name node_modules -o -name outputs \) -prune \
    -o \( -type d -o -type f \) -print | sort
  if [[ -d "$CASE_ROOT/$slug/.riptide/runs" ]]; then
    find "$CASE_ROOT/$slug/.riptide/runs" -name simulation-result.json -type f | sort | sed -n '1,20p'
  fi
done

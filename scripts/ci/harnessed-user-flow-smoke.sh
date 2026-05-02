#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ ! -x target/release/riptide-engine ]]; then
  cargo build --release -p riptide-engine
fi

if [[ ! -f programs/amm/target/deploy/amm.so ]]; then
  cat >&2 <<'EOF'
programs/amm/target/deploy/amm.so is missing.
Build it before running the harnessed user-flow smoke:
  cargo build-sbf --manifest-path programs/amm/Cargo.toml
EOF
  exit 2
fi

cd cli
npm run build
RIPTIDE_HARNESSED_USER_FLOW_SMOKE=1 node --test dist/test/harness.test.js --test-name-pattern='harnessed generic user flow runs one deterministic seed'

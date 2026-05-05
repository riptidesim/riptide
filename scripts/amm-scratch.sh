#!/usr/bin/env bash
# AMM persona scratch runner.
#
# Mirrors the `scripts/perpetuals-scratch.sh` sidecar pattern:
# read persona TOMLs from disk, merge them into a runtime copy of the
# adapter, run one 20-agent, 30-tick simulation twice with a fixed
# seed, sha256 the outputs, assert byte-identical across replays.
#
# This is a throwaway determinism gate — ships the persona files
# and this script as the bundle's end-to-end shape check. The runtime
# copy strips additive [semantics] metadata so the Sprint 6 raw scratch
# hash remains a stable pre-semantics canary; semantic-pack behavior is
# covered by the dedicated semantics tests.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENGINE="${RIPTIDE_ENGINE_BIN:-$REPO_ROOT/target/release/riptide-engine}"
BASE_ADAPTER="fixtures/adapters/amm.toml"
PERSONAS_DIR="fixtures/personas"
PERSONA_IDS=(lp-provider arbitrageur sandwich-attacker swapper rug-puller)
AGENTS=20
TICKS=30
SEED=42
SCENARIO="baseline"

if [[ ! -x "$ENGINE" ]]; then
  echo "error: riptide-engine not built at $ENGINE" >&2
  echo "build with: cargo build --release -p riptide-engine" >&2
  exit 1
fi
if [[ ! -f "$BASE_ADAPTER" ]]; then
  echo "error: base adapter missing at $BASE_ADAPTER" >&2
  exit 1
fi
for pid in "${PERSONA_IDS[@]}"; do
  if [[ ! -f "$PERSONAS_DIR/$pid.toml" ]]; then
    echo "error: persona file missing: $PERSONAS_DIR/$pid.toml" >&2
    exit 1
  fi
done

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# --- Build the runtime adapter: truncate the shipping amm.toml
# at the `# === SIDECAR-CUT ===` marker (everything above stays except
# the additive [semantics] block; the smoke-test personas below it are
# dropped), then append each persona file so the [personas.*] block is
# the AMM library.
# Relative program_so / idl_path are rewritten to absolute repo
# paths because the adapter file lives in $WORK_DIR/ at runtime.
RUNTIME_ADAPTER="$WORK_DIR/amm.runtime.toml"
PROGRAM_SO_ABS="$REPO_ROOT/programs/amm/target/deploy/amm.so"
IDL_PATH_ABS="$REPO_ROOT/fixtures/idls/amm.json"
awk '/^# === SIDECAR-CUT ===$/ { exit } { print }' "$BASE_ADAPTER" \
  | awk '
      /^\[semantics\]$/ { skip = 1; next }
      skip && /^\[\[?semantics[.\]]/ { next }
      skip && /^\[/ { skip = 0 }
      !skip { print }
    ' \
  | sed -e "s|^program_so *=.*|program_so = \"$PROGRAM_SO_ABS\"|" \
        -e "s|^idl_path *=.*|idl_path = \"$IDL_PATH_ABS\"|" \
  > "$RUNTIME_ADAPTER"
echo "# --- AMM persona library (sidecar merge) ---" >> "$RUNTIME_ADAPTER"
for pid in "${PERSONA_IDS[@]}"; do
  echo "" >> "$RUNTIME_ADAPTER"
  cat "$PERSONAS_DIR/$pid.toml" >> "$RUNTIME_ADAPTER"
done

# --- Build run-config: 20 agents evenly spread across the 5 personas,
# 30 ticks, baseline scenario, fixed seed.
python3 - "$WORK_DIR" "$AGENTS" "$TICKS" "$SEED" "$SCENARIO" "${PERSONA_IDS[@]}" <<'PY'
import json, sys
from pathlib import Path

work_dir, agents, ticks, seed, scenario, *persona_ids = sys.argv[1:]
agents = int(agents); ticks = int(ticks); seed = int(seed)

# Rotate persona slots across agents so the mix is deterministic and
# every persona gets ≥1 slot at agents=20, personas=5 (4 each).
slots = [persona_ids[i % len(persona_ids)] for i in range(agents)]

# output_path is a FIXED string (not the tmpdir) so the serialized
# SimulationResult is byte-identical across invocations. This makes
# the sha256 determinism gate reproducible across runs, not just
# within a single invocation.
run_config = {
    "agents": agents,
    "ticks": ticks,
    "scenario": scenario,
    "seed": seed,
    "personas": slots,
    "validator_url": "unused",
    "output_path": "amm-scratch",
}
Path(work_dir, "run-config.json").write_text(
    json.dumps(run_config, indent=2, sort_keys=True) + "\n"
)
# Empty policies — generic path uses inline adapter personas.
Path(work_dir, "policies.json").write_text("[]\n")
PY

run_once() {
  local output="$1"
  env -u RIPTIDE_POOL_LTV_BPS \
      -u RIPTIDE_POOL_LIQ_THRESHOLD_BPS \
      -u RIPTIDE_POOL_LIQ_BONUS_BPS \
      -u RIPTIDE_SEED_COLLATERAL \
      -u RIPTIDE_STARTING_BALANCE \
      -u RIPTIDE_PRICE_SHOCK_DROP \
    "$ENGINE" \
      --config "$WORK_DIR/run-config.json" \
      --policies "$WORK_DIR/policies.json" \
      --output "$output" \
      --adapter "$RUNTIME_ADAPTER" \
      >"$WORK_DIR/engine.log" 2>&1 \
    || { tail -20 "$WORK_DIR/engine.log" >&2; echo "FAIL: engine exited non-zero" >&2; exit 1; }
}

echo ">>> amm scratch run: agents=$AGENTS ticks=$TICKS seed=$SEED personas=${PERSONA_IDS[*]}"
run_once "$WORK_DIR/run-a.json"
HASH_A=$(sha256sum "$WORK_DIR/run-a.json" | awk '{print $1}')
echo "    run A: $HASH_A"

run_once "$WORK_DIR/run-b.json"
HASH_B=$(sha256sum "$WORK_DIR/run-b.json" | awk '{print $1}')
echo "    run B: $HASH_B"

if [[ "$HASH_A" != "$HASH_B" ]]; then
  echo "FAIL: determinism gate — hashes differ" >&2
  diff <(jq -S . "$WORK_DIR/run-a.json") <(jq -S . "$WORK_DIR/run-b.json") | head -40 >&2 || true
  exit 1
fi

echo ">>> OK — amm scratch scenario is deterministic across two replays"
echo "    hash: $HASH_A"

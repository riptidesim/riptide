#!/usr/bin/env bash
# Solend-fork whale-share x shock-magnitude hero grid driver.
#
# Runs a 3x3 whale-share x shock-magnitude sweep against the Solend fork
# adapter with a fixed seed and a fixed non-whale population. Cells land
# under fixtures/scenarios/solend-fork/hero-grid/w<whale>-s<shock>/.
#
# Intentionally dumb: no grid framework, no reuse, one script invocation
# per cell. Reads fixtures/personas/whale.toml as the single source of
# truth for the whale policy and builds each cell's policies.json /
# run-config.json inline via tomllib.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ENGINE="${RIPTIDE_ENGINE_BIN:-$REPO_ROOT/target/release/riptide-engine}"
ADAPTER="$REPO_ROOT/fixtures/adapters/solend-fork.toml"
WHALE_TOML="$REPO_ROOT/fixtures/personas/whale.toml"
OUT_BASE="$REPO_ROOT/fixtures/scenarios/solend-fork/hero-grid"

if [[ ! -x "$ENGINE" ]]; then
  echo "error: riptide-engine not built at $ENGINE" >&2
  echo "build with: cargo build --release -p riptide-engine" >&2
  exit 1
fi
if [[ ! -f "$WHALE_TOML" ]]; then
  echo "error: whale persona TOML missing at $WHALE_TOML" >&2
  exit 1
fi

AGENTS=20
TICKS=20
SEED=42
SCENARIO="price-shock"
WHALE_SHARES=(5 15 25)       # percent of agents that are whales
SHOCK_BPS=(20 30 40)         # percent price drop applied at ticks/2

mkdir -p "$OUT_BASE"

# Emit policies.json + run-config.json for a single cell using the whale
# TOML as the single source of truth for whale params. Called once per
# cell below.
build_cell_configs() {
  local cell_dir="$1" whale_count="$2"
  python3 - "$WHALE_TOML" "$cell_dir" "$whale_count" "$AGENTS" "$TICKS" "$SEED" "$SCENARIO" <<'PY'
import json, sys, tomllib
from pathlib import Path

whale_toml, cell_dir, whale_count, agents, ticks, seed, scenario = sys.argv[1:]
whale_count = int(whale_count)
agents = int(agents)
ticks = int(ticks)
seed = int(seed)

with open(whale_toml, "rb") as f:
    whale = tomllib.load(f)

# Baseline non-whale population: a single cautious-yield-farmer clone
# shared across all non-whale agents. Identical for every cell so the
# only variables are whale_share and shock_bps.
steady = {
    "persona_id": "steady-lp",
    "persona_label": "Steady LP",
    "action_rate_multiplier": 1.0,
    "risk_tolerance": 0.25,
    # Liquidate weight is tuned high deliberately: pre-shock the engine
    # pins Liquidate to 0 via `can_liquidate=false`, so deposit still
    # dominates. Post-shock can_liquidate flips on and liquidate becomes
    # the dominant action — without this, underwater whales sit untouched
    # and the pool never realizes bad debt.
    "action_weights": {
        "deposit": 0.85,
        "borrow": 0.15,
        "withdraw": 0.2,
        "repay": 0.6,
        "liquidate": 1.5,
    },
    "triggers": [
        {
            "condition": {"type": "health_factor_below", "threshold": 1.25},
            "response": "repay",
            "severity": 7,
            "cooldown_ticks": 3,
        }
    ],
    # Fixed-amount sizing so each post-shock liquidation call asks for a
    # repay large enough to run the borrower's collateral to the floor.
    # The lending program flags `borrower.liquidated = true` after the
    # first successful partial liq, so the single call that lands per
    # whale must itself be big enough to realize shortfall — otherwise
    # liquidations succeed cleanly and bad debt stays at zero even when
    # the position is structurally underwater.
    "position_sizing": {"strategy": "fixed", "params": {"amount": 6500.0}},
    "max_exposure": 0.35,
}

policies = [whale, steady]

# Build a personas list of length == agents so build_agent_personas maps
# 1:1 (i % personas.len() == i). Whale slots spread evenly across the
# population so ordering effects stay neutral.
slots = ["steady-lp"] * agents
if whale_count > 0:
    stride = agents / whale_count
    for k in range(whale_count):
        slots[int(k * stride)] = "whale"

run_config = {
    "agents": agents,
    "ticks": ticks,
    "scenario": scenario,
    "seed": seed,
    "personas": slots,
    "validator_url": "unused",
    "output_path": cell_dir,
}

Path(cell_dir).mkdir(parents=True, exist_ok=True)
with open(Path(cell_dir) / "policies.json", "w") as f:
    json.dump(policies, f, indent=2, sort_keys=True)
    f.write("\n")
with open(Path(cell_dir) / "run-config.json", "w") as f:
    json.dump(run_config, f, indent=2, sort_keys=True)
    f.write("\n")
PY
}

echo ">>> hero grid sweep: agents=$AGENTS ticks=$TICKS seed=$SEED scenario=$SCENARIO"

for whale in "${WHALE_SHARES[@]}"; do
  whale_count=$(( AGENTS * whale / 100 ))
  # whale=5 -> 1, whale=15 -> 3, whale=25 -> 5 at agents=20
  if (( whale_count < 1 )); then whale_count=1; fi
  for shock in "${SHOCK_BPS[@]}"; do
    cell="w${whale}-s${shock}"
    cell_dir="$OUT_BASE/$cell"
    mkdir -p "$cell_dir"
    build_cell_configs "$cell_dir" "$whale_count"

    shock_float=$(python3 -c "print(f'{$shock/100:.3f}')")
    echo ">>> cell $cell (whales=$whale_count/$AGENTS, shock=$shock_float)"

    # Scrub ambient engine knobs — keep only the shock magnitude and
    # default LTV/threshold/bonus/seed so every cell sees identical pool
    # config. Same discipline as demo/run-demo.sh.
    env -u RIPTIDE_POOL_LTV_BPS \
        -u RIPTIDE_POOL_LIQ_THRESHOLD_BPS \
        -u RIPTIDE_POOL_LIQ_BONUS_BPS \
        -u RIPTIDE_SEED_COLLATERAL \
        -u RIPTIDE_STARTING_BALANCE \
      RIPTIDE_PRICE_SHOCK_DROP="$shock_float" \
      "$ENGINE" \
        --config "$cell_dir/run-config.json" \
        --policies "$cell_dir/policies.json" \
        --output "$cell_dir/simulation-result.json" \
        --adapter "$ADAPTER" \
        >"$cell_dir/engine.stderr.log" 2>&1 \
      || { tail -40 "$cell_dir/engine.stderr.log" >&2; echo "FAIL $cell" >&2; exit 1; }
  done
done

echo ">>> grid sweep complete: $OUT_BASE"

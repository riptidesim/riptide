#!/usr/bin/env bash
# Riptide demo: run the safe and risky configs against the in-process
# LiteSVM backend and print a side-by-side headline-metric diff.
#
# Preconditions (see demo/README.md for details):
#   - engine built:  cargo build --release -p riptide-engine
#   - lending built: cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml
#   - cli built:     (cd cli && npm run build)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# CLI invocation is split into a node binary + a script path so neither
# can be repurposed to execute an arbitrary shell string via the
# environment. The previous `RIPTIDE_CLI` variable was expanded unquoted
# and would execute whatever a rogue env set it to, in the context of a
# funded RIPTIDE_PAYER. Both overrides are explicit file paths now;
# anything else must be wired in via a new discrete var, not a shell
# command.
RIPTIDE_NODE_BIN="${RIPTIDE_NODE_BIN:-node}"
RIPTIDE_CLI_JS="${RIPTIDE_CLI_JS:-$REPO_ROOT/cli/dist/src/index.js}"

# Scrub any ambient engine knobs so a stale export in the operator's
# shell cannot silently falsify the demo's numbers. The README documents
# the tuning the demo applies; anything else should either be opted into
# explicitly via a flag or not present at all. RIPTIDE_PRICE_SHOCK_DROP
# is re-exported below (the one knob the demo owns); RIPTIDE_ENGINE_BIN
# is cleared because the demo must exercise the real binary, not an
# orchestrator-unit-test override.
unset \
  RIPTIDE_ENGINE_BIN \
  RIPTIDE_POOL_LTV_BPS \
  RIPTIDE_POOL_LIQ_THRESHOLD_BPS \
  RIPTIDE_POOL_LIQ_BONUS_BPS \
  RIPTIDE_SEED_COLLATERAL \
  RIPTIDE_STARTING_BALANCE

# Tuning knobs — see demo/README.md for rationale. The only knob the demo
# turns is the shock magnitude, large enough that leveraged borrowers
# trip the on-chain liquidation check while cautious personas (who never
# open borrows) ride the MTM loss without insolvency.
export RIPTIDE_PRICE_SHOCK_DROP=0.5

mkdir -p demo/outputs

run_one() {
  local label="$1"
  local config="$2"
  local out_dir="demo/outputs/$label"

  # Extract flags from the JSON config using node (always available
  # because the cli itself is Node).
  read -r agents ticks scenario seed personas < <(
    node -e '
      const fs = require("fs");
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(
        [c.agents, c.ticks, c.scenario, c.seed, c.personas.join(",")].join(" ") + "\n"
      );
    ' -- "$REPO_ROOT/$config"
  )

  echo ">>> running $label: agents=$agents ticks=$ticks scenario=$scenario seed=$seed personas=$personas"
  rm -rf "$out_dir"
  "$RIPTIDE_NODE_BIN" "$RIPTIDE_CLI_JS" simulate \
    --agents "$agents" \
    --ticks "$ticks" \
    --scenario "$scenario" \
    --seed "$seed" \
    --personas "$personas" \
    --output "$out_dir"
}

run_one safe  demo/configs/safe.json
run_one risky demo/configs/risky.json

echo
echo "============================================================"
echo "  Riptide demo — safe vs risky (same shock, same seed)"
echo "============================================================"
node -e '
  const fs = require("fs");
  const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  const safe  = load("demo/outputs/safe/simulation-result.json");
  const risky = load("demo/outputs/risky/simulation-result.json");

  const row = (label, a, b) =>
    label.padEnd(28) + String(a).padStart(16) + String(b).padStart(16);

  const drawdown = (r) => {
    let worst = 0;
    for (let i = 1; i < r.timeseries.length; i++) {
      const d = r.timeseries[i - 1].tvl - r.timeseries[i].tvl;
      if (d > worst) worst = d;
    }
    return worst.toFixed(2);
  };

  console.log(row("metric", "safe", "risky"));
  console.log("-".repeat(60));
  console.log(row("final TVL",            safe.summary.final_tvl.toFixed(2),        risky.summary.final_tvl.toFixed(2)));
  console.log(row("final utilization",    safe.summary.final_utilization.toFixed(3), risky.summary.final_utilization.toFixed(3)));
  console.log(row("total liquidations",   safe.summary.total_liquidations,           risky.summary.total_liquidations));
  console.log(row("total bad debt",       safe.summary.total_bad_debt.toFixed(2),    risky.summary.total_bad_debt.toFixed(2)));
  console.log(row("surviving agents",     safe.summary.agents_active,                risky.summary.agents_active));
  console.log(row("liquidated agents",    safe.summary.agents_liquidated,            risky.summary.agents_liquidated));
  console.log(row("largest tick drawdown", drawdown(safe),                           drawdown(risky)));
  console.log(row("event count",          safe.events.length,                       risky.events.length));
'
echo "============================================================"
echo "artifacts: demo/outputs/safe/simulation-result.json"
echo "           demo/outputs/risky/simulation-result.json"

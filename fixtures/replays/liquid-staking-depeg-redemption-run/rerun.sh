#!/bin/sh
# Riptide — reviewer-ready rerun recipe.
#
# Simulation evidence with explicit boundaries.
# Regenerates the accompanying simulation-result.json from committed inputs.
# Expects to be run from this file's directory or anywhere; it cds to the repo
# root and then executes the documented invocation. POSIX sh only — no bashisms.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../../.."

# scenario: replay:liquid-staking-depeg-redemption-run (kind inferred from the SimulationResult)
# canonical hash: 5bdc5f7c7bd8bef8b1a350c76ebaa0b8fbfc3954d3b26882aa89ab54e9fda704

exec riptide replay fixtures/replays/liquid-staking-depeg-redemption-run/config.json \
  --allow-invariant-violations

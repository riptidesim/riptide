#!/bin/sh
# Riptide — reviewer-ready rerun recipe.
#
# Simulation evidence with explicit boundaries.
# Regenerates the accompanying simulation-result.json from committed inputs.
# Expects to be run from this file's directory or anywhere; it cds to the pack
# root and then executes the documented invocation. POSIX sh only — no bashisms.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

# scenario: replay:loopscale-collateral-mispricing (kind inferred from the SimulationResult)
# canonical hash: d6d71b3b79be760d486f510606866bdccb4be4d9ab8c2df19e45409ad7b386ff

exec riptide replay config.json \
  --allow-invariant-violations

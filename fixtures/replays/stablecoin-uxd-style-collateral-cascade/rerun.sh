#!/bin/sh
# Riptide — reviewer-ready rerun recipe.
#
# Simulation evidence — not audit signoff.
# Regenerates the accompanying simulation-result.json from committed inputs.
# Expects to be run from this file's directory or anywhere; it cds to the repo
# root and then executes the documented invocation. POSIX sh only — no bashisms.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../../.."

# scenario: replay:stablecoin-uxd-style-collateral-cascade (kind inferred from the SimulationResult)
# canonical hash: ef99f49ecf5581e11652d22a287f72cb257dbc8e036000c82d634c3d86f6bb6c

exec riptide replay fixtures/replays/stablecoin-uxd-style-collateral-cascade/config.json \
  --allow-invariant-violations

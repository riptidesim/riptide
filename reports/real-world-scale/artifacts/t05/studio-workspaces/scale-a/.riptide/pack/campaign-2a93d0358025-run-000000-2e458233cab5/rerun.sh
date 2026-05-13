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

# scenario: price-shock (kind inferred from the SimulationResult)
# canonical hash: 4bb439963d9884d05c4e772927f5f73cc7901edefd4a1e384521cad955efc8fd

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000000_2e458233cab5/run-config.json --adapter fixtures/adapters/lending.toml

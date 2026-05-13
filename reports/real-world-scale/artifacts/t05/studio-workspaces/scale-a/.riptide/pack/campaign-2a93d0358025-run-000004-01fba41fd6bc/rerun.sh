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
# canonical hash: 0864a4d39894f56aa322b31ce9941f23be77b3785c8452ae2b9b27002bd15113

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000004_01fba41fd6bc/run-config.json --adapter fixtures/adapters/lending.toml

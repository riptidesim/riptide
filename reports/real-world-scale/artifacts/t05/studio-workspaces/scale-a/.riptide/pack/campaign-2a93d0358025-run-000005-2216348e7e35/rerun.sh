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
# canonical hash: da12378653714011ddd1146ada987f3be306bd844b5830b89681af00798b946e

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000005_2216348e7e35/run-config.json --adapter fixtures/adapters/lending.toml

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
# canonical hash: 21a95aa2431227df55f5da172e85ef76b0af045cea04162a8169c09b290b3891

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000013_09601a35a28f/run-config.json --adapter fixtures/adapters/lending.toml

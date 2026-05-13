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
# canonical hash: 01782117b96458bd590feec2f44cdeb79d6bf967778a67a8cc1819398e73dc30

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000012_772800f663a1/run-config.json --adapter fixtures/adapters/lending.toml

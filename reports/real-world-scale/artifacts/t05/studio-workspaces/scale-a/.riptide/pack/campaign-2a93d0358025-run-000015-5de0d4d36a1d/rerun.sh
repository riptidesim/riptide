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
# canonical hash: 81030eab1e58bdf525efcdfcd88faa9ae792ed2099a4bcaab8c90df87e912709

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000015_5de0d4d36a1d/run-config.json --adapter fixtures/adapters/lending.toml

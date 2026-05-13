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
# canonical hash: 12ecfb23b6f9fc81d8d065df898a9b9b56fcf2bde9f837b3b5e5bc9647c537bf

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000010_456d84ed46f9/run-config.json --adapter fixtures/adapters/lending.toml

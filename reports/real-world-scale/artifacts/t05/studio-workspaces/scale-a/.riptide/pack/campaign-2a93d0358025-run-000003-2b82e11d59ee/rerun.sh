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
# canonical hash: ede8a0b1ce723075d8cba82536a8e09fa4f5b2ac7ff323ca97d6219056bc9a32

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000003_2b82e11d59ee/run-config.json --adapter fixtures/adapters/lending.toml

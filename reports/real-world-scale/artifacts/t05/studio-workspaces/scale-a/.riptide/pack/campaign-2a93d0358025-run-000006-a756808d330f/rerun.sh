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
# canonical hash: c4205b4fe9c02c04783a774824bd7aae6ddd2f99ecdb4c620843892b7fdb4215

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000006_a756808d330f/run-config.json --adapter fixtures/adapters/lending.toml

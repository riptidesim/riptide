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
# canonical hash: 3bc731be173e50a2ae433c949ba37d88b34669eabccdd5a7549e665ae41e1ac3

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000008_6c1296b2ff28/run-config.json --adapter fixtures/adapters/lending.toml

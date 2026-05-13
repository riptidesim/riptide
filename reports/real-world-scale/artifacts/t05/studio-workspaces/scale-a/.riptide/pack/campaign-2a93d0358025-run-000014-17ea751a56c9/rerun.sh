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
# canonical hash: 80fb1370f4099e7fb96bf267d3d9ca86c38dda5f14ea79fc781dcb650fe14dbc

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000014_17ea751a56c9/run-config.json --adapter fixtures/adapters/lending.toml

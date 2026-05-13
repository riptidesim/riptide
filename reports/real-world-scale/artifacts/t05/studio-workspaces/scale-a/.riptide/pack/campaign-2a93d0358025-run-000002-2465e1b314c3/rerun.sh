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
# canonical hash: 8046345668b964751250d6db2ce7d35b50eb21f516dead54410e9eaae4612f2d

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000002_2465e1b314c3/run-config.json --adapter fixtures/adapters/lending.toml

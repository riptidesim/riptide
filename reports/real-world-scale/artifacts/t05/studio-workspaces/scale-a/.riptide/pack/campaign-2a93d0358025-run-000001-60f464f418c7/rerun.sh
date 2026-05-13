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
# canonical hash: fb118552bfc247096d5a11a774ee5be2354eeb9706ac37a2b6d62436f6331621

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000001_60f464f418c7/run-config.json --adapter fixtures/adapters/lending.toml

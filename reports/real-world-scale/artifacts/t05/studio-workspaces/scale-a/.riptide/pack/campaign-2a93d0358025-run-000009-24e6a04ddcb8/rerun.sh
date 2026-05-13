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

# scenario: bank-run (kind inferred from the SimulationResult)
# canonical hash: ac357804eb78124e5de774a0bcdb8be302c4f32769cb07e599d647f4a0fa713d

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000009_24e6a04ddcb8/run-config.json --adapter fixtures/adapters/lending.toml

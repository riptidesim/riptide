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
# canonical hash: 18aa834175f858b2e4dec800000e7e2b858fa8a7c2fcc2187dac6b8174fd24f2

exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000007_381d169f4cb7/run-config.json --adapter fixtures/adapters/lending.toml

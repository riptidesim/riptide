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

# scenario: replay:drift-fake-collateral-vault-drain (kind inferred from the SimulationResult)
# canonical hash: 84c4a8e9a83a79298de3f350535e3cb793b2dac1cc5028481b4f57142d8b9702

exec riptide replay fixtures/replays/drift-fake-collateral-vault-drain/config.json \
  --allow-invariant-violations

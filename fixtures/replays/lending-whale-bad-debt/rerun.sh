#!/bin/sh
# Riptide — reviewer-ready rerun recipe.
#
# Simulation evidence — not audit signoff.
# Regenerates the accompanying simulation-result.json from committed inputs.
# Expects to be run from this file's directory or anywhere; it cds to the pack
# root and then executes the documented invocation. POSIX sh only — no bashisms.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

# scenario: replay:lending-whale-bad-debt (kind inferred from the SimulationResult)
# canonical hash: 6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1

exec riptide replay config.json \
  --allow-invariant-violations

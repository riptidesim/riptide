#!/bin/sh
# Riptide — reviewer-ready rerun recipe.
#
# Simulation evidence with explicit boundaries.
# Regenerates the accompanying simulation-result.json from committed inputs.
# Expects to be run from this file's directory or anywhere; it cds to the pack
# root and then executes the documented invocation. POSIX sh only — no bashisms.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

# scenario: replay:kelpdao-unbacked-rseth (kind inferred from the SimulationResult)
# canonical hash: ff46b6a1bbcddc4064f1f6eae58c65c291b4856167e800c1c475825c788d0b09

exec riptide replay config.json \
  --allow-invariant-violations

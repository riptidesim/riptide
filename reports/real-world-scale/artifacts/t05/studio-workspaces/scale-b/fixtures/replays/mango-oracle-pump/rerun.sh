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

# scenario: replay:mango-oracle-pump (kind inferred from the SimulationResult)
# canonical hash: d2344f727c7b84ea9eb11573089c77bef6b66131d485ec90fbf65842e7c920e6

exec riptide replay config.json \
  --allow-invariant-violations

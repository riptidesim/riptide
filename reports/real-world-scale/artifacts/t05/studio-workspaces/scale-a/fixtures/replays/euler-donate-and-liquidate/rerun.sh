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

# scenario: replay:euler-donate-and-liquidate (kind inferred from the SimulationResult)
# canonical hash: 03de00e2d2ba97344b1572ae79679d43473a27a136447c6b1a28691eda14a2f8

exec riptide replay config.json \
  --allow-invariant-violations

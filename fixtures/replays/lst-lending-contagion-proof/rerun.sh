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

# scenario: replay:multi:lst-lending-contagion-proof-upstream (kind inferred from the SimulationResult)
# canonical hash: d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb

exec riptide replay fixtures/replays/lst-lending-contagion-proof/config.json \
  --allow-invariant-violations

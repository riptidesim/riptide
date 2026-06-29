# Reviewer Command

`riptide review <path>` validates Riptide evidence without running a
simulation, touching the network, or mutating the input. The path is a
guided-sim artifact directory containing `guided-sim-run.json` (and usually
`rerun.sh`).

For a guided simulation artifact:

```sh
riptide sim review .riptide/sim/artifacts/run-001
riptide review .riptide/sim/artifacts/run-001
```

The guided review reads `guided-sim-run.json`, checks `rerun.sh` with
`sh -n` when present, and prints retained failing seed, flow counts,
labelled transaction outcomes, failure reason, and rerun command. It is
the guided artifact review path; it validates one emitted run and does
not claim broader coverage.

After command-level validation, use
[Protocol assessment workflow](protocol-assessment.md) when you need to combine
guided-sim artifacts into a protocol-level coverage matrix or assessment
report (`riptide assess <guided-sim-root>`).

For machine consumption:

```sh
riptide review .riptide/sim/artifacts/run-001 --json
```

The guided-sim JSON uses `schema_version = "guided-sim-review.v1"` and includes
artifact status, retained seed, flow counts, transaction outcomes, failure
reason, rerun command, validation results, and the original artifact. Exit
codes are `0` for fully validated artifacts, `1` for warnings-only artifacts,
and `2` for malformed artifacts.

This command is simulation-evidence tooling, not audit signoff. It proves that
the artifact's committed output is well-formed and that the rerun recipe is
syntactically valid; it does not execute the recipe or certify the underlying
program.

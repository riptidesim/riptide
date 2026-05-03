# Reviewer Command

`riptide review <path>` validates Riptide evidence without running the engine, touching the network, or mutating the input. The path can be an evidence pack, a campaign root, or a retained campaign case.

For campaign evidence:

```sh
riptide review /tmp/riptide-campaign-demo/campaign_2a93d0358025
```

The campaign review reads `campaign-summary.json`, `retention-manifest.json`, and retained `case.json` files, then maps retained labels to run IDs, sampled parameters, risk results, and rerun commands. See [Campaign Runner](campaigns.md) for the full campaign artifact map.

For a single evidence pack, `riptide review <pack-path>` reads the pack manifest, resolves the input and output path indexes, verifies the canonical hash from the indexed `simulation_result`, checks that `rerun.sh` is POSIX-sh parseable with `sh -n`, and emits a reviewer-facing markdown summary.

```sh
riptide review fixtures/replays/lending-whale-bad-debt/
```

The Solend-shape lending pack should report proof level 3, the `no_bad_debt` invariant fire, the canonical hash `6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1`, and the rerun recipe. The verifier follows `outputs/paths.json`; packs do not need a literal `outputs/simulation-result.json` file.

For machine consumption:

```sh
riptide review fixtures/replays/lending-whale-bad-debt/ --json
```

The JSON payload includes the manifest digest, validation results, invariant fires, the canonical hash verification result, and the raw SHA256 of the indexed result file. Exit codes are `0` for fully validated packs, `1` for warnings-only packs, and `2` for malformed packs or canonical hash mismatches.

This command is simulation-evidence tooling, not audit signoff. It proves that the pack's committed output matches its canonical hash and that the rerun recipe is syntactically valid; it does not execute the recipe or certify the underlying program.

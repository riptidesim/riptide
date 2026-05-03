# Campaign Runner

Campaign Runner expands one Campaign TOML into a deterministic set of scenario runs. The output connects sampled parameters, run IDs, retained evidence, and review commands so another person can inspect the result without reading the source.

Use campaigns when you want more than one scenario smoke test: a campaign can sweep shock profiles, oracle lag, whale concentration, seeds, and retention labels while keeping the inputs and artifacts stable on disk.

## Worked Example

Run the shipped lending campaign from the repository root:

```bash
riptide campaign validate fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml
```

```bash
riptide campaign plan fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml --out /tmp/riptide-campaign-demo
```

```bash
riptide campaign run fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml --out /tmp/riptide-campaign-demo
```

```bash
riptide review /tmp/riptide-campaign-demo/campaign_2a93d0358025
```

The campaign ID is derived from the Campaign TOML digest, so the path above is stable for this fixture. If you change the Campaign TOML, use the `campaign id:` line printed by `validate`, `plan`, or `run`.

The example is Solend-shaped because it uses a local lending fixture and stress coordinates that resemble liquidation-safety questions. It is not a Solend mainnet replay.

## What The Commands Do

| Command | Purpose |
| --- | --- |
| `riptide campaign validate <campaign.toml>` | Parse and validate the Campaign TOML without materializing configs or running simulations. |
| `riptide campaign plan <campaign.toml> --out <dir>` | Expand deterministic run IDs, seeds, scenario families, sampled parameters, and output paths without executing simulations. |
| `riptide campaign run <campaign.toml> --out <dir>` | Materialize generated run configs, execute each run through `riptide run`, aggregate risk signals, and retain selected cases. |
| `riptide review <campaign-root>` | Validate retained campaign evidence and print reviewer Markdown mapping labels to runs, parameters, risk results, and rerun commands. |

## Artifact Map

The worked example writes under `/tmp/riptide-campaign-demo/campaign_2a93d0358025/`:

| Path | Contents |
| --- | --- |
| `campaign-canonical.json` | Canonical campaign digest input. |
| `runs/run_*/run-config.json` | Effective generated configs. These contain the materialized sampled parameters for each run. |
| `runs/run_*/metadata.json` | Run ID, seed, scenario family, sampled parameters, status, and artifact pointers. |
| `runs/` | Per-run `simulation-result.json`, `report.md`, and evidence packs emitted by the existing run path. |
| `runs.jsonl` | One record per generated run. |
| `parameters.csv` | Tabular run coordinates and headline lending risk metrics. |
| `campaign-summary.md` | Human summary with outcome, key risk signal, scenario-family table, retained evidence, and boundary language. |
| `campaign-summary.json` | Stable machine-readable summary. Artifact entries are campaign-root-relative where practical. |
| `retention-manifest.json` | Retained labels mapped to run IDs, sampled parameters, risk signals, rerun commands, and retained case paths. |
| `retained/<label>-<run-id>/case.json` | Digestable retained-case handoff record. |
| `retained/<label>-<run-id>/rerun.sh` | POSIX-sh-parseable rerun recipe for the retained case. |

## What This Proves

A campaign result proves that Riptide executed the declared local inputs, sampled the listed coordinates, and observed the reported metrics or invariant signals within that run budget.

It does not prove complete protocol safety, production solvency, or historical mainnet behavior. A no-failure campaign means no declared invariant fired inside those inputs. A failing campaign means at least one reproducible point in the declared experiment produced the reported signal.

## Troubleshooting

`campaign run` exits non-zero when invariant failures are observed. The artifacts are still written; use `riptide review <campaign-root>` to inspect retained evidence.

If `campaign run` refuses to resume, the existing generated config differs from the deterministic expansion. Choose a new `--out` directory or move the old campaign output before rerunning.

`riptide campaign run --serve` is intentionally unsupported for now. Run the campaign without `--serve`, then review the campaign root. For the scenario dashboard, use `riptide run --serve`.

`riptide doctor` may warn that optional fixture `.so` files are not built in a source checkout. Build the fixture you plan to run, use `./install.sh`, or stay on the shipped lending campaign path above.

Paths inside retained campaign indexes are campaign-root-relative where possible. A few commands and rerun scripts intentionally keep absolute local paths when the output root is outside the repo, such as `/tmp`, so the handoff remains runnable from the same machine.

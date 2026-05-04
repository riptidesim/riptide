# Campaign Runner

Campaign Runner expands one Campaign TOML into a deterministic set of scenario runs. The output connects sampled parameters, run IDs, retained evidence, and review commands so another person can inspect the result without reading the source.

Use campaigns when you want more than one scenario smoke test: a campaign can sweep shock profiles, oracle lag, whale concentration, seeds, and retention labels while keeping the inputs and artifacts stable on disk.

Agent-assisted repo setup is intentionally one flow:

```text
riptide init -> /riptide-config -> riptide campaign run -> riptide review
```

`riptide-config` prepares or repairs the adapter, harness, scenarios,
and Campaign TOML before you run the campaign. It validates campaign
readiness; executing the campaign remains a separate
`riptide campaign run ...` step.

Guided Rust simulations are a separate evidence path for dynamic
`remaining_accounts`, multi-instruction flows, and project-owned
external dependency services. Run them with `riptide sim run --out
<artifact-dir>` and review the artifact with `riptide sim review
<artifact-dir>` or `riptide review <artifact-dir>`. Do not treat
`riptide campaign run` as a hidden guided-sim scheduler; a future
guided scheduler should use an explicit command shape.

## Repo-local campaign

Create the campaign in the repo that owns the program under test. A
typical path is `.riptide/campaigns/<risk>.campaign.toml`, next to the
adapter and scenarios created or repaired by `/riptide-config`.

Use this as a starting shape and replace the adapter, class, objective,
scenario family names, and parameter ranges with the risk you want to
measure:

```toml
# .riptide/campaigns/liquidation-safety.campaign.toml
[campaign]
name = "liquidation-safety"
adapter = "../adapters/<program-name>.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 16
seed_policy = "fixed:1337"
replay_retention = ["first_failure", "worst_liquidity", "median"]

[campaign.scenarios]
selection = "weighted"
families = ["baseline", "stress"]

[campaign.scenarios.baseline]
source = "../scenarios/baseline"
weight = 1
parameters = ["oracle_lag_ticks"]

[campaign.scenarios.stress]
source = "../scenarios/<experiment>"
weight = 2
parameters = ["oracle_lag_ticks"]

[campaign.personas]
base = "."
families = []

[campaign.parameters.oracle_lag_ticks]
distribution = "discrete"
values = [0, 2, 4]
unit = "ticks"
```

When `families = []`, Campaign Runner keeps the personas already present
in each scenario's `run-config.json` or inline adapter persona tables.

Validate the Campaign TOML:

```bash
riptide campaign validate .riptide/campaigns/liquidation-safety.campaign.toml
```

Preview the generated run set without executing simulations:

```bash
riptide campaign plan .riptide/campaigns/liquidation-safety.campaign.toml --max-runs 4
```

Run the campaign:

```bash
riptide campaign run .riptide/campaigns/liquidation-safety.campaign.toml
```

Review the campaign root printed by `campaign run`:

```bash
riptide review <campaign-root>
```

The campaign ID is derived from the Campaign TOML digest. If you change
the Campaign TOML, use the new `campaign id:` and `output dir:` lines
printed by `validate`, `plan`, or `run`.

## What The Commands Do

| Command | Purpose |
| --- | --- |
| `riptide campaign validate <campaign.toml>` | Parse and validate the Campaign TOML without materializing configs or running simulations. |
| `riptide campaign plan <campaign.toml> --out <dir>` | Expand deterministic run IDs, seeds, scenario families, sampled parameters, and output paths without executing simulations. |
| `riptide campaign run <campaign.toml> --out <dir>` | Materialize generated run configs, execute each run through `riptide run`, aggregate risk signals, and retain selected cases. |
| `riptide review <campaign-root>` | Validate retained campaign evidence and print reviewer Markdown mapping labels to runs, parameters, risk results, and rerun commands. |
| `riptide sim review <artifact-dir>` | Validate a guided-sim artifact directory and print retained seed, flow counts, transaction labels, failure reason, and rerun command. This is not campaign scheduling. |

## Artifact Map

By default, a repo-local campaign writes under
`.riptide/campaigns/campaign_<id>/`:

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

Guided-sim campaign scheduling is also intentionally separate for now.
A future command should be explicit, for example
`riptide campaign run --guided-sim .riptide/sim --sim-iterations <n>
--sim-flows <n>`. That is a future shape, not a supported command in the
current CLI.

`riptide doctor` may warn that the `.so` or IDL referenced by your
adapter is missing. Build your program, regenerate the IDL, or update the
adapter paths before running the campaign.

Paths inside retained campaign indexes are campaign-root-relative where possible. A few commands and rerun scripts intentionally keep absolute local paths when the output root is outside the repo, such as `/tmp`, so the handoff remains runnable from the same machine.

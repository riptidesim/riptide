# QA Benchmarks

The Sprint 26 QA benchmark suite is a reusable stress and developer-UX harness for Riptide. It measures supported CLI workflows, campaign behavior, failure messages, determinism, runtime, peak process-tree RSS, and artifact growth.

This is not an audit proof. A green run means the local Riptide checkout completed the declared benchmark workload under the local toolchain and inputs. It does not prove protocol safety, complete campaign coverage, or historical mainnet behavior.

## Run

From the Riptide repo root:

```bash
node scripts/qa/s26-benchmark.mjs --profile smoke --out /tmp/riptide-s26-bench-smoke
```

For the full max-stress path:

```bash
node scripts/qa/s26-benchmark.mjs --profile max --out /tmp/riptide-s26-bench-manual
```

When `--out` is omitted, the runner writes to `/tmp/riptide-s26-bench-<timestamp>`. Every run creates these roots:

| Path | Purpose |
| --- | --- |
| `<out>/outputs` | Benchmark result files, command logs, generated campaign TOMLs, and campaign outputs. |
| `<out>/home` | Temporary HOME for normal benchmark commands. |
| `<out>/case-studies` | Thin temporary copies of case-study repos. |

The runner also copies `outputs/report.md` to:

```text
/home/ailton/Documents/Obsidian Vault/Riptide/QA - Sprint 26 Benchmark And Dev UX.md
```

Pass `--skip-obsidian` to suppress that copy.

## Profiles

`smoke` is intended for quick local validation. It runs CLI discoverability, the flagship lending campaign with a small `--max-runs` cap, perpetuals readiness/direct-run checks, and intentional failure UX checks.

`max` runs every workload in `scripts/qa/s26-workloads.json`, including case-study init/dev-UX sweeps, larger campaign budgets, perps stress variants, and the cold developer path through `./install.sh`.

Use a targeted subset while iterating:

```bash
node scripts/qa/s26-benchmark.mjs --profile smoke --only cli-discoverability,failure-recovery-ux
```

List workload names:

```bash
node scripts/qa/s26-benchmark.mjs --list
```

## Outputs

The runner writes:

| File | Contents |
| --- | --- |
| `results.json` | Full structured results, command metadata, warning classifications, UX scores, and report summary. |
| `summary.csv` | One row per command/workload. |
| `artifacts.csv` | Artifact byte and file-count metrics for commands with an artifact root. |
| `determinism.json` | Stable artifact comparisons for repeated campaign runs. |
| `stdout/` | Capped stdout logs, one file per command. |
| `stderr/` | Capped stderr logs, one file per command. |
| `report.md` | Human summary copied into the Obsidian vault unless `--skip-obsidian` is set. |

`summary.csv` uses these columns:

```text
workload,command_label,exit_code,expected_exit_code,wall_ms,max_rss_kb,avg_cpu_pct,artifact_bytes,artifact_files,stdout_bytes,stderr_bytes,warning_count,verdict
```

`max_rss_kb` is sampled from the spawned process tree with `ps`. `artifact_bytes` and `artifact_files` are computed by traversing the command's artifact root after the command exits.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `pass` | Exit code and assertions matched expectations. |
| `expected-finding` | A non-zero or warning-producing path was intentional and produced actionable output. |
| `fail` | Unexpected exit code, missing assertion, weak intentional-failure UX, timeout, or determinism mismatch. |
| `skipped` | The local checkout lacks a declared optional surface, such as a case-study harness. |

The final report groups failed and expected findings into:

| Category | Use |
| --- | --- |
| `Riptide bug` | Unexpected CLI, campaign, review, resume, determinism, or artifact behavior. |
| `unsupported case study` | The workflow is outside the committed supported surface. |
| `expected scaffold blocker` | An init-generated stub or intentionally incomplete adapter blocked execution with recovery guidance. |
| `environment/tooling issue` | Local toolchain, missing build artifact, install, PATH, or filesystem prerequisites blocked execution. |

## Workload Matrix

The declarative workload matrix lives in:

```text
scripts/qa/s26-workloads.json
```

The runner owns dynamic setup that JSON cannot express cleanly: creating temporary campaign TOMLs, copying case-study repos into `/tmp`, mutating malformed inputs, comparing deterministic artifacts, and finding retained `rerun.sh` scripts.

Generated benchmark outputs are intentionally outside the repo and should not be committed.

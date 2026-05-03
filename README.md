# Riptide

<p align="center">
  <img src="docs/assets/riptide-logo.svg" alt="Riptide" width="100%">
</p>

<p align="center">
  <a href="TOOLCHAIN.md"><img src="https://img.shields.io/badge/Rust-1.91.1-orange?style=flat-square&amp;logo=rust" alt="Rust"></a>
  <a href="cli/package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-3c873a?style=flat-square&amp;logo=node.js&amp;logoColor=white" alt="Node.js"></a>
  <a href="TOOLCHAIN.md"><img src="https://img.shields.io/badge/Solana%20SBF-3.0.13-14f195?style=flat-square" alt="Solana SBF"></a>
  <a href="docs/architecture.md"><img src="https://img.shields.io/badge/runtime-LiteSVM-4f8cff?style=flat-square" alt="LiteSVM"></a>
</p>

**Deterministic multi-agent simulation for Solana programs.**

Riptide runs your compiled Solana program in LiteSVM, drives it with declared agent behavior, and shows where your protocol starts losing economic headroom. Use it to map parameter regions, replay declared trajectories, and turn invariants into CI gates before mainnet does the experiment for you.

[Get started](#get-started) • [How it works](#how-it-works) • [Run examples](#run-examples) • [Campaign Runner](#campaign-runner) • [Evidence packs](#evidence-packs) • [Docs](#docs)

![Riptide dashboard showing a lending stress-test run](docs/assets/dashboard-hero.png)

> [!IMPORTANT]
> Riptide produces simulation evidence, not audit signoff. A failing cell is a reproducible point in a declared experiment; your team still decides whether that point matters.

## Why Riptide

Solana protocols do not fail at one tidy input. They fail across regions: whale concentration, oracle movement, liquidation capacity, leverage, queue depth, pool imbalance, or user behavior all interacting at once.

Riptide is built for that shape of question:

| You want to know... | Riptide gives you... |
| --- | --- |
| Where does this parameter set break? | Deterministic sweeps across personas, shocks, ticks, and agent counts. |
| Can this incident shape happen again? | Declared replays with initial state, transactions, oracle paths, and invariants. |
| Can CI catch economic regressions? | Exit code `1` when declared invariants fire. |
| Can a reviewer rerun the claim? | Evidence packs with manifests, traces, rerun scripts, and canonical hashes. |

## How It Works

```mermaid
flowchart LR
    P["Program .so + IDL"] --> A["Adapter TOML"]
    A --> S["Personas + scenario"]
    S --> E["Riptide engine<br/>LiteSVM"]
    E --> R["simulation-result.json"]
    E --> D["Dashboard"]
    E --> C["CI exit code"]
    E --> K["Evidence pack"]
```

Riptide keeps the load-bearing pieces on disk:

- **Adapter TOML** wires your program, accounts, instructions, observations, oracle bindings, lineage, and invariants.
- **Personas** describe deterministic agent behavior such as whales, liquidators, LPs, arbitrageurs, redeemers, or custom game-economy actors.
- **Scenarios** define the experiment: seeds, ticks, agent counts, price shocks, scheduled actions, or replay trajectories.
- **LiteSVM execution** runs the real BPF program in-process, fast enough for sweeps while staying byte-stable for committed inputs.
- **Artifacts** include JSON results, markdown summaries, dashboard data, and reviewer-ready packs.

Shipping bundles cover lending, perpetuals, AMMs, liquid staking, stablecoins, and a non-DeFi `resource-grinder` example. The same adapter surface is meant for your own Anchor program.

## Get Started

Use the hosted installer for the shortest path. It downloads a prebuilt bundle
for Linux x86_64, macOS Intel/Apple Silicon, or Windows x64.

```bash
# Install on Linux or macOS:
curl -fsSL https://riptide.run/install | sh
```

```powershell
# Install on Windows PowerShell:
irm https://riptide.run/install.ps1 | iex
```

```bash
# Build from repository when developing Riptide itself:
git clone https://github.com/riptidesim/riptide
cd riptide
./install.sh
```

The hosted installer does not require Rust, Node.js, npm, Solana CLI, or
`cargo-build-sbf`. The repository installer builds the Rust engine, TypeScript
CLI, shipped SBF programs used by the smoke tests, and a `riptide` launcher
under `$HOME/.local/bin`.

```bash
riptide doctor
riptide run lending/whale-shock-grid --serve
```

Prefer Docker from a clean checkout:

```bash
docker build -t riptide .
docker run --rm riptide run lending/whale-shock-grid
```

> [!NOTE]
> The hosted installer expects matching GitHub Release assets for the requested
> version. If you are testing unreleased changes, use `./install.sh` from a
> checkout or the local Docker build. See [Install](docs/install.md) for the
> full setup and upgrade path.

## Wire Your Program

Inside your own Anchor repo:

```bash
riptide init
# edit .riptide/adapters/<program-name>.toml
riptide lint <program-name>
riptide run --adapter .riptide/adapters/<program-name>.toml --seeds 1 --seed-root 1337
# then add or refine .riptide/scenarios/<experiment>/run-config.json and run the full battery:
riptide run --adapter .riptide/adapters/<program-name>.toml
```

`riptide init` creates a version-controlled `.riptide/` tree with an adapter stub, scenario run-configs, inline persona presets, and a local getting-started note. Use `--profile <profile>` (`lending`, `amm`, `perpetuals`, `liquid-staking`, `stablecoin`, or `custom`) to select a starter profile non-interactively. The adapter/scenario/invariant TOML stays the main simulation contract. When `target/idl/<program>.json` is present, init now prefills IDL-backed shorthand such as `space = "auto"`, compact instruction `bindings`, and opt-in `[observations.auto]` blocks where it can infer them. When your program needs custom account bytes, PDAs, SPL accounts, or sibling CPI programs, run `riptide harness generate --adapter ...` explicitly; the generated harness is an optional setup layer, not part of the default init path.

AMM-shaped user repos currently use `protocol = "generic"` and Riptide's generic SBF/IDL runtime; `amm.v1` semantics is future work.

> [!TIP]
> The `riptide-adapt`, `riptide-harness`, and `riptide-scenarios` skills can draft adapters, Rust setup harnesses, and starter experiments, but they are optional. Riptide runs plain files, not session state.

## Run Examples

Run the Solend-shaped whale-shock grid and open the dashboard:

```bash
riptide run lending/whale-shock-grid --serve
```

Run the safe-vs-risky lending demo:

```bash
bash examples/run-demo.sh
```

Replay a declared whale bad-debt trajectory:

```bash
riptide replay fixtures/replays/lending-whale-bad-debt/config.json \
  --allow-invariant-violations
```

Review a committed evidence pack without rerunning the engine:

```bash
riptide review fixtures/replays/lending-whale-bad-debt/
```

Common commands:

| Command | Purpose |
| --- | --- |
| `riptide doctor` | Static environment and adapter health check. |
| `riptide init` | Scaffold `.riptide/` in the current repo. |
| `riptide harness generate` | Generate a Rust setup crate for protocol-owned accounts/programs. |
| `riptide list` | List discovered scenarios under `.riptide/scenarios/`. |
| `riptide run [pattern-or-path]` | Run all scenarios, a glob-filtered set, or one JSON run config. Add `--harness` when custom setup is needed. |
| `riptide replay <config>` | Replay a declared trajectory. |
| `riptide explain <adapter>` | Pretty-print a parsed adapter: protocol, runtime, accounts, instructions, observations, personas, invariants, semantics, and oracles. |
| `riptide lint <adapter>` | Validate a JSON-IDL-backed adapter. |
| `riptide lineage <adapter>` | Print adapter provenance and assumptions. |
| `riptide review <pack>` | Validate an evidence pack and emit reviewer markdown. |

Exit codes are CI-friendly: `0` all pass, `1` invariant fired, `2` setup error, `3` partial abort, `130` interrupted.

## Campaign Runner

Campaign Runner turns one Campaign TOML into a deterministic sweep of scenario families, sampled parameters, retained cases, and reviewer-ready summaries. Use it when a single smoke run is too quiet and you need to show the shape of a risk frontier across seeds and parameters.

Run the shipped lending campaign:

```bash
riptide campaign validate fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml
riptide campaign plan fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml --out /tmp/riptide-campaign-demo
riptide campaign run fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml --out /tmp/riptide-campaign-demo
riptide review /tmp/riptide-campaign-demo/campaign_2a93d0358025
```

The run writes `campaign-summary.md`, `campaign-summary.json`, `runs.jsonl`, `parameters.csv`, `retention-manifest.json`, and retained case directories under the campaign root. The Solend-shaped fixture is local simulation evidence over declared inputs; it is not a Solend mainnet replay and does not prove complete protocol safety. See [Campaign Runner](docs/campaigns.md) for the artifact map, trust boundary, and troubleshooting.

## Evidence Packs

Every `riptide run` and `riptide replay` emits `.riptide/pack/<run-id>/`:

```text
.riptide/pack/<run-id>/
├── manifest.json
├── summary.md
├── trace.md
├── rerun.sh
├── inputs/paths.json
└── outputs/paths.json
```

The pack is designed for handoff: repo-relative paths only, canonical hashes, parseable rerun scripts, declared invariant firings, and enough context for a reviewer to validate what was run without inheriting your terminal session.

Read [Evidence packs](docs/pack.md) and [CI handoff](docs/ci-handoff.md) for the reviewer workflow.

## Project Map

| Path | What lives there |
| --- | --- |
| [`engine/`](engine/) | Rust engine and LiteSVM runtime. |
| [`cli/`](cli/) | Node.js CLI, dashboard server, adapter linting, orchestration. |
| [`fixtures/adapters/`](fixtures/adapters/) | Shipping adapter TOMLs. |
| [`fixtures/personas/`](fixtures/personas/) | Monorepo fixture persona libraries. User repos created by `riptide init` keep personas inline in adapter `[personas.*]` tables. |
| [`fixtures/scenarios/`](fixtures/scenarios/) | Monorepo fixture scenario bundles (`run-config.json`, and when needed fixture `policies.json` / `manifest.json`). User repos use `.riptide/scenarios/**/run-config.json`. |
| [`fixtures/replays/`](fixtures/replays/) | Declared replay artifacts and committed packs. |
| [`programs/`](programs/) | Minimal Solana programs used by the examples. |
| [`docs/`](docs/) | Architecture, install, handoff, lineage, and case-study docs. |
| [`skills/`](skills/) | Optional Codex/Claude Code accelerators for adapter, harness, scenario, and narrative authoring. |

## Docs

| Start here | When you need... |
| --- | --- |
| [Install](docs/install.md) | Supported setup, Docker, repository build commands, and upgrades. |
| [Campaign Runner](docs/campaigns.md) | Validate, plan, run, and review deterministic campaign sweeps. |
| [Architecture](docs/architecture.md) | The six-layer model, LiteSVM caveats, determinism, and adapter pipeline. |
| [Vision](docs/vision.md) | The lab-not-oracle stance and what Riptide explicitly does not claim. |
| [Solend-fork case study](docs/case-studies/lending.md) | The whale-share × shock grid and the load-bearing example. |
| [Evidence packs](docs/pack.md) | Pack shape, canonical hashes, and rerun workflow. |
| [CI handoff](docs/ci-handoff.md) | How to pin a replay proof in GitHub Actions. |
| [Adapter lineage](docs/adapter-lineage.md) | Adapter provenance, assumptions, and JSON IDL linting. |
| [Toolchain](TOOLCHAIN.md) | Exact Rust, Node, Solana CLI, and SBF versions. |

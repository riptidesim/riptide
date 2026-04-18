# Riptide

> **Protocol-agnostic economic simulator for Solana programs.** Map the failure region of any Solana program with a multi-agent LiteSVM harness, declarative TOML adapters, and a six-layer stack of adapters, personas, scenarios, parameters, failure-mode taxonomy, and invariants.

![Riptide dashboard showing the Solend-fork whale × shock hero-grid cell (w25-s40)](docs/assets/dashboard-hero.png)

## Install

Build from source — one command from a fresh clone (Linux, Rust + Node + `cargo-build-sbf` on `$PATH`):

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
./install.sh
```

That compiles the engine + CLI + five on-chain SBF programs and puts `riptide` on your `$PATH`.

Prefer a container? The repo ships a multi-stage `Dockerfile` pinned to the full [`TOOLCHAIN.md`](TOOLCHAIN.md) stack:

```bash
docker build -t riptide .   # ~280 MB image, ~15 min cold build
docker run --rm riptide run fixtures/scenarios/solend-fork/hero-grid/w25-s40/run-config.json
```

> **Public distribution (GHCR `ghcr.io/riptidesim/riptide`, crates.io `riptide-engine`, npm `@riptide/cli`) is wired up and dry-run-verified in the repo but has not been published yet — it lands in an upcoming release after one more cold-eyes validation pass.** Until then, use the build-from-source or local-Docker paths above.

## Quickstart

```bash
# 1. build from a fresh clone
./install.sh            # or: docker build -t riptide .

# 2. run the canonical Solend-fork hero-grid cell —
#    maps bad debt across a 3×3 whale-share × price-shock grid;
#    the w25-s40 cell is mainnet-adjacent
riptide run fixtures/scenarios/solend-fork/hero-grid/w25-s40/run-config.json

# 3. same cell again with the dashboard — --serve holds the port open after the run
riptide run fixtures/scenarios/solend-fork/hero-grid/w25-s40/run-config.json --serve
# → open http://localhost:4173
```

Three shipping protocol-class bundles are in the repo today: lending (`fixtures/adapters/solend-fork.toml`), perps (`fixtures/adapters/perps-fork.toml`), and AMM (`fixtures/adapters/amm-fork.toml`). Each bundle ships an adapter + a persona library + taxonomy hooks + invariants + a cold-discovery validation artifact.

## Two paths in

> *"Two ways to use Riptide: write your own experiments if you already know what you're testing for, or let the `riptide-scenarios` skill propose a starter catalog based on your program. Both run deterministically against your real code and surface the knife edges. Zero setup inside Claude Code."*

- **Path A — write your own experiments.** If you already know what you're testing for, author a run-config + policies + adapter TOML directly. The safe-vs-risky lending demo (`demo/run-demo.sh`) and the non-DeFi resource-grinder demo are the canonical examples.
- **Path B — let the skill propose a starter catalog.** Install the `riptide-scenarios` Claude Code skill ([`skills/riptide-scenarios/SKILL.md`](skills/riptide-scenarios/SKILL.md)), invoke it inside any Claude Code session on your adapter + IDL, and it classifies plausible failure modes for your program and proposes 3–5 ranked starter experiments (whale concentration, shock cascades, utilization stress, persona-mix instability, oracle lag, price manipulation, liquidation cascades, impermanent-loss spikes). The skill writes run-configs to `fixtures/scenarios/<adapter>/<experiment>/` and does **not** autorun — the dev picks what to run.

**Outcome demo:** the Solend-fork case study — a 3×3 whale × shock parameter-boundary discovery run on the Solend fork — is the shipping example of what Path A looks like when it lands well. See [`docs/case-studies/solend-fork.md`](docs/case-studies/solend-fork.md) for the full report, the bad-debt table, and the load-bearing claim: *Riptide maps the danger region; Solend's actual parameters sit inside it.*

## Caveat — lab, not oracle

> **Riptide is a lab, not an oracle.** The dev picks the experiment —
> Riptide does not tell you what's wrong with your program. Riptide runs the
> experiment deterministically: same seed in, same bytes out, every time, so
> the grid you're reading is reproducible from the adapter TOML and the
> persona TOML alone. And nobody is claiming this catches bugs on its own.
> The grid maps a parameter region; the dev draws the conclusions. A cell
> that comes back with bad debt is not a bug report — it is a point in
> parameter space where the program's math lost headroom, and the dev is the
> one who decides whether that point matters.

## The six-layer stack

Every Riptide bundle layers six declarative surfaces on top of your program:

1. **Adapter** — one TOML file declaring your program, its actions, its observations, and its invariants.
2. **Personas** — TOML files describing agent behavior with a trigger DSL (`player.gold < 100 → craft`).
3. **Scenarios** — engine shocks (oracle trajectories, scheduled actions) mounted from declarative TOML presets.
4. **Parameters** — run-config knobs that sweep over the dimensions that matter (whale share, shock magnitude, trade size, leverage, depositor concentration).
5. **Failure-mode taxonomy** — categories like `whale_concentration`, `margin_cascade_from_oracle_shock`, `price_manipulation_via_swap`, `impermanent_loss_spike`. The `riptide-scenarios` skill matches your adapter's shape against this taxonomy.
6. **Invariants** — machine-checkable properties (`no_bad_debt`, `reserve_a > 0`, `k == reserve_a * reserve_b` within tolerance) declared inline in the adapter. The engine exits non-zero when any invariant fires, so invariants double as CI gates.

Three shipping bundles — **lending** (Solend fork), **perps** (perps-lite), and **AMM** (constant-product x*y=k) — exercise every layer end-to-end.

## What ships today

**Three protocol-class bundles.**

- **Lending** — `fixtures/adapters/solend-fork.toml` drives a forked Solend SPL-Token-Lending pool through `deposit / borrow / repay / withdraw / liquidate`, plus a 3×3 whale × shock hero grid at `fixtures/scenarios/solend-fork/hero-grid/` with bad-debt surfaces on 4 of 9 cells and byte-stable determinism. Mainnet cell `w25-s40` matches the Solend June 2022 incident region.
- **Perps** — `fixtures/adapters/perps-fork.toml` drives a minimal perps-lite program (`open_position`, `close_position`, `liquidate_position`, etc.) with 4 personas (leveraged long/short, delta-neutral farmer, liquidator), margin-cascade + socialized-loss invariants, and oracle-shock scenarios.
- **AMM** — `fixtures/adapters/amm-fork.toml` drives a constant-product x*y=k pool (`swap`, `add_liquidity`, `remove_liquidity`) with 5 personas (LP provider, arbitrageur, sandwich attacker, swapper, rug puller), pool-integrity invariants, and a 2D `trade-size × volume` grid template.

**Historical replay.** `riptide replay <replay-config.json>` points the engine at a real on-chain tx sequence + oracle trajectory and replays it byte-for-byte in LiteSVM. The shipping replay — `fixtures/replays/solend-nov-2022/` — reproduces the Solend Nov 2022 whale-risk incident and asserts a declared `no_bad_debt` invariant fires at the cascade tick.

**Adapter generation via Claude Code skill.** Install the `riptide-adapt` Claude Code skill. Invoke it inside any Claude Code session on your program's IDL — the skill reads your program, generates an adapter TOML using your session's existing LLM, writes it, and runs a smoke test against your program. Zero endpoint configuration. Zero API keys. Zero additional LLM cost. The session's model is the generator.

`riptide adapt` is the smoke-test harness the skill invokes. It validates a generated adapter by booting the local engine with it and confirming one write-action produces a state delta. It does not call any external service; it runs entirely against the local LiteSVM engine.

**Web dashboard.** `riptide run --serve` (or `riptide replay --serve`) serves a single-page HTML dashboard on `localhost:4173` after the simulation completes, rendering run metadata, summary metrics, a timeseries chart, an event stream filterable by action/outcome/agent, and invariant firings highlighted in red. Screenshot above is the real artifact from the Solend-fork `w25-s40` cell.

## Runtime and speed

The engine runs on **LiteSVM** (in-process SVM). For the same `100 agents × 180 ticks` workload, LiteSVM completes in **0.898s** end-to-end; `solana-test-validator` with `--bpf-program` preload and warm caches takes **901.461s** (measured 2026-04-12). That is roughly a **~900x speedup**, entirely from RPC and confirmation overhead removal — both paths execute the same `lending_pool.so` BPF program logic.

**Honest caveat:** LiteSVM does not model full validator behavior (gossip, vote, PoH). The speedup is infrastructure overhead removal, not a program-level optimization. `solana-test-validator` is still the correct environment for validator-level parity checks, and the parity test at `engine/tests/t05_lending_integration.rs` stays gated on `RIPTIDE_RUN_VALIDATOR_TESTS=1` as the diagnostic reference path. LiteSVM is the default runtime; the validator path is diagnostic only.

## Determinism

Same seed = same result, byte-for-byte, across the lending, perps, AMM, and generic fixtures. The `t15_e2e_determinism` integration test enforces this on every run, and replay mode extends the same guarantee to historical trajectories.

## Build from source

```bash
# One command, fresh clone on Linux (requires Rust + Node already installed)
./install.sh
```

Or piece-by-piece:

```bash
# Engine
cargo build --release -p riptide-engine

# Shipped on-chain programs
cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml
cargo build-sbf --manifest-path programs/perps-fork/Cargo.toml
cargo build-sbf --manifest-path programs/amm-fork/Cargo.toml
cargo build-sbf --manifest-path programs/resource_grinder/Cargo.toml

# CLI (TypeScript wrapper)
(cd cli && npm install && npm run build)
```

## Run the demos

```bash
# Lending — safe vs risky side-by-side
bash demo/run-demo.sh

# Generic (non-DeFi) — resource-grinder toy SBF program
cargo run --release -p riptide-engine -- \
  --config fixtures/generic-demo.run.json \
  --policies fixtures/generic-demo.policies.json \
  --adapter fixtures/adapters/resource-grinder.toml \
  --output /tmp/riptide-generic-demo.json

# Solend Nov 2022 historical replay
riptide replay fixtures/replays/solend-nov-2022/replay-config.json --serve
```

The `resource-grinder` program has no lending semantics at all — it is a toy "grind for resources, trade at a market" SBF program used to prove the generic path end-to-end. If you can run this, you can adapt Riptide to your protocol.

## Repo layout

- `engine/` — Rust simulation engine. `src/primitive/` holds the `Primitive` base trait, `LendingPrimitive`, `AmmPrimitive`, and the `GenericPrimitive` harness. `src/replay/` is the historical-replay module.
- `cli/` — TypeScript CLI wrapper. Handles persona compilation, adapter pre-validation (Zod mirror of the serde schema), orchestration, the `riptide adapt` smoke-test harness, the dashboard server (`src/serve/`), and the narrative-report skill invocation.
- `programs/` — standalone SBF crates (`lending_pool/`, `perps-fork/`, `amm-fork/`, `resource_grinder/`, `admin_mock_oracle/`) built out of the root workspace so the pinned Solana/Borsh build environment stays intact.
- `fixtures/` — run configs, policies, adapter TOMLs, persona TOMLs, scenario presets, historical replays, and the oracle golden-bytes SSOT.
- `skills/` — self-contained Claude Code skills: `riptide-adapt` (adapter generation), `riptide-scenarios` (experiment proposal), `riptide-narrative` (rich post-run report).
- `demo/` — safe-vs-risky lending demo shell script and configs.
- `docs/` — case studies, assets, and anything else a reader lands on.

## License

MIT OR Apache-2.0 at your option.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to add a new adapter, persona, or failure-mode taxonomy category.

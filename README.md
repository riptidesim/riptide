# Riptide

> **Economic stress-testing for Solana programs.** Map the failure region of your program before mainnet does.

![Riptide dashboard showing a lending stress run](docs/assets/dashboard-hero.png)

## Install

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
./install.sh                # or: docker build -t riptide .
```

Puts `riptide` on your `$PATH` after compiling the engine, CLI, and shipped on-chain programs. Linux, Rust + Node + `cargo-build-sbf` required — see [`TOOLCHAIN.md`](TOOLCHAIN.md) for pins.

## Run one

```bash
riptide run examples/configs/safe.json --serve
# → open http://localhost:4173
```

5 cautious agents against a forked Solend lending pool under a 50% price shock, 10 ticks. `--serve` holds the dashboard port open after the run.

Riptide simulates multi-agent economic stress against your real BPF program in an in-process SVM (LiteSVM). Same seed in, same bytes out — the grid is reproducible from the adapter TOML alone. Riptide is a lab, not an oracle: it maps parameter regions; the dev draws the conclusions. See [`VISION.md`](VISION.md) for the full posture.

## What ships today

| Bundle | Adapter | Hero artifact |
|---|---|---|
| Lending (Solend fork) | [`fixtures/adapters/solend-fork.toml`](fixtures/adapters/solend-fork.toml) | 3×3 whale × shock grid — bad debt on 4 of 9 cells ([case study](docs/case-studies/solend-fork.md)) |
| Perps (perps-lite) | [`fixtures/adapters/perps-fork.toml`](fixtures/adapters/perps-fork.toml) | Margin-cascade + socialized-loss invariants, 4 personas, oracle-shock scenarios |
| AMM (x*y=k) | [`fixtures/adapters/amm-fork.toml`](fixtures/adapters/amm-fork.toml) | Pool-integrity invariants, 5 personas, 2D trade-size × volume grid template |

Each bundle ships an adapter + persona library + taxonomy hooks + invariants + a cold-discovery validation artifact. A fourth generic (non-DeFi) path drives a toy resource-grinder SBF program end-to-end — if it runs, you can adapt Riptide to your protocol.

**Historical replay.** `riptide replay fixtures/replays/solend-nov-2022/config.json` reproduces the Solend June 2022 whale-risk incident byte-for-byte and asserts a declared `no_bad_debt` invariant fires at the cascade tick.

**Web dashboard.** `riptide run --serve` (or `riptide replay --serve`) renders run metadata, summary metrics, timeseries, event stream, and invariant firings on `localhost:4173`. Screenshot above is the real artifact.

## Two paths in

Write your own experiments (Path A) or let the `riptide-scenarios` Claude Code skill propose a starter catalog (Path B). The safe-vs-risky lending walkthrough at [`examples/`](examples/) is the canonical Path A demo; the skill at [`skills/riptide-scenarios/SKILL.md`](skills/riptide-scenarios/SKILL.md) is Path B. Both run deterministically against your real code. See [`VISION.md`](VISION.md) for the full framing.

**Adapter generation.** The `riptide-adapt` Claude Code skill reads your IDL, generates an adapter TOML using your session's existing model, writes it, and runs a smoke test. Zero endpoint configuration, zero API keys.

## Run the demos

```bash
# Lending — safe vs risky side-by-side
bash examples/run-demo.sh

# Solend June 2022 historical replay
riptide replay fixtures/replays/solend-nov-2022/config.json --serve
```

## Deep dive

- [`docs/vision.md`](docs/vision.md) — the extended stance: lab-not-oracle, what Riptide is explicitly not, adversarial-review posture.
- [`docs/architecture.md`](docs/architecture.md) — six-layer stack, LiteSVM runtime, determinism model, adapter pipeline.
- [`docs/install.md`](docs/install.md) — `install.sh` walkthrough, Docker path, from-source recipe, upgrade flow.
- [`docs/case-studies/solend-fork.md`](docs/case-studies/solend-fork.md) — the 3×3 whale × shock parameter-boundary run on a Solend fork.
- [`docs/benchmarks/agent-scaling.md`](docs/benchmarks/agent-scaling.md) — 1000 agents × 30 ticks in under 5 seconds on a standard laptop; reproducible harness + deterministic hashes.

## Repo layout

- `engine/` — Rust simulation engine. `src/primitive/` holds the `Primitive` trait + lending/AMM/generic harnesses. `src/replay/` is historical replay.
- `cli/` — TypeScript CLI wrapper. Persona compilation, adapter pre-validation, orchestration, dashboard server, skill invocation.
- `programs/` — standalone SBF crates (`lending_pool/`, `perps-fork/`, `amm-fork/`, `resource_grinder/`, `admin_mock_oracle/`).
- `fixtures/` — run configs, policies, adapter TOMLs, persona TOMLs, scenario presets, historical replays.
- `skills/` — Claude Code skills: `riptide-adapt`, `riptide-scenarios`, `riptide-narrative`.
- `examples/` — safe-vs-risky lending walkthrough.
- `docs/` — case studies and assets.

## License

MIT OR Apache-2.0 at your option.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to add a new adapter, persona, or failure-mode taxonomy category.

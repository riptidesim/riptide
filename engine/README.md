# riptide-engine

Deterministic multi-agent simulator for Solana programs. `riptide-engine` is the Rust core of [Riptide](https://github.com/riptidesim/riptide) — it boots your compiled program into LiteSVM, drives hundreds of adversarial personas against it for a configurable number of ticks, and emits a byte-stable per-tick JSON trace plus a rolled-up summary.

## What this crate is

- A standalone binary (`riptide-engine`) that reads an adapter TOML (describing your program's instructions, state layout, and observations), a run-config JSON (seed, agents, ticks), and a policies JSON (per-persona strategy dials), and writes a `simulation-result.json` artifact.
- A library (`riptide_engine`) exposing the primitive trait surface (`Primitive`, `LendingPrimitive`, `AmmPrimitive`, plus the generic harness), the adapter schema, the replay framework, and the simulation tick loop.
- A single LiteSVM-backed execution path (default feature `litesvm-backend`) that is deterministic same-seed across runs and machines.

## Scope

- Protocol-agnostic: lending, perps, and AMM bundles ship in the parent repo, but the engine itself has no built-in DeFi semantics — everything is driven by the adapter TOML.
- Three shipped adapter shapes live under `fixtures/adapters/` in the parent repo (`solend-fork.toml`, `perps-fork.toml`, `amm-fork.toml`).
- Historical replay mode (`riptide-engine --replay-dir ...`) reproduces real on-chain trajectories tick-by-tick — see `fixtures/replays/solend-nov-2022/` for the shipping example.

## Usage

Most users want the full Riptide experience (CLI wrapper + adapter-generation skill + scenario-proposal skill) rather than the engine in isolation. For that, see the [parent repo](https://github.com/riptidesim/riptide).

Direct engine usage:

```bash
cargo install riptide-engine
riptide-engine \
  --adapter path/to/adapter.toml \
  --config  path/to/run-config.json \
  --policies path/to/policies.json \
  --output  simulation-result.json
```

## License

Dual-licensed under MIT or Apache-2.0 at your option.

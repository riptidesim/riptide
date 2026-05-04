# riptide-engine

Rust execution engine for [Riptide](../README.md).

`riptide-engine` loads adapter TOML, run/replay config, and persona policies; boots the target Solana program into LiteSVM; executes the declared experiment; evaluates invariants; and writes deterministic simulation artifacts.

## What It Provides

- A standalone `riptide-engine` binary used by the CLI.
- A Rust library surface for adapters, primitives, replay execution, packing, and simulation loops.
- A LiteSVM-backed runtime for deterministic, in-process execution of compiled Solana BPF programs.
- Pack emission for reviewer handoff: manifest, summary, trace, rerun script, and canonical hash.

## Build From Source

The crate is not published to crates.io yet. Build it from the monorepo:

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
cargo build --release -p riptide-engine
```

The binary lands at:

```text
target/release/riptide-engine
```

Most users should run the CLI instead of invoking the engine directly:

```bash
./install.sh
riptide doctor
```

Read the root [README](../README.md) for the product tour and [Architecture](../docs/architecture.md) for the engine model.

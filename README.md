# Riptide

> Riptide runs your Solana program against hundreds of different users under any market scenario you want and tells you which combination breaks it — before mainnet does.

Riptide is a **multi-agent simulator for shared program state under time pressure**. It is not a DeFi simulator. DeFi is the first application because the failure modes are economically catastrophic and the need is loud — but the engine does not know or care about finance. After Sprint 3 (Protocol-Agnostic Unlock), Riptide is positioned against *any* Solana program, native or generic, with or without LLM-assisted adapter generation.

## What ships today

**Three primitives, one abstraction.**

1. **`LendingPrimitive`** — a trait with five actions (deposit, borrow, repay, withdraw, liquidate) and two observations (health factor, pool state). The forked Solend SPL-Token-Lending pool is its first impl and drives the safe-vs-risky demo.
2. **`GenericPrimitive`** — the ceiling-remover. You describe your protocol's actions, observations, and personas inline in a ~30-line TOML adapter file, point the engine at your compiled `.so` and your Anchor IDL, and Riptide runs your program with no custom Rust needed. The shipping non-DeFi demo (`programs/resource_grinder/`) proves the path is real.
3. **`AmmPrimitive`** — a sibling trait sketch compiled alongside `LendingPrimitive`. It is a compile-time pressure-test of the abstraction, not a runnable impl. The two traits fit the same shape with zero reshape of the base — that is a meaningful validation artifact for the pivot.

**Two demo fixtures ship in this repo.**

- **Solend-fork lending (safe vs risky).** `fixtures/adapters/solend-fork.toml` drives the safe-vs-risky demo end-to-end via the adapter, not via hardcoded harness wiring. Run it with `bash demo/run-demo.sh`.
- **Resource-grinder (non-DeFi generic demo).** `fixtures/adapters/resource-grinder.toml` + `fixtures/generic-demo.run.json` + `fixtures/generic-demo.policies.json` run the generic primitive against a standalone SBF program at `programs/resource_grinder/`. Byte-stable under `cargo test -p riptide-engine --test t15_e2e_determinism`.

**LLM-assisted adapter generation.** `riptide adapt` reads an IDL (and optionally a source tree) and emits a working-or-nearly-working adapter TOML plus a smoke-test run. It targets any OpenAI-compatible endpoint (local models, Anthropic via compat shim, Groq, etc.). The subcommand is code complete, integration-tested end-to-end against a scripted LLM client, and has been run through a stub smoke runner. A manual run against a live endpoint is pending — not because the code doesn't work, but because the credentials/network path has not been exercised yet. The hand-written `fixtures/adapters/solend-fork.toml` ships as the canonical demo adapter regardless, so the pivot is not gated on the live run.

A thin `riptide-adapt` Claude Code skill lives at `skills/riptide-adapt/` and wraps the same code path.

## The generic primitive, in one paragraph

The generic primitive is the feature that removes the "DeFi-only" ceiling. Instead of binding to a pre-built primitive (lending, AMM, perps, staking, CLOB), the developer describes their protocol's actions, observations, and personas inline in a TOML adapter file and points Riptide at the compiled `.so` and the Anchor IDL. Riptide reads the IDL to build valid transactions, reads the TOML to drive the tick loop, and runs the program with no custom Rust needed. The generic path supports a limited trigger DSL (single comparison op + constant) today — enough to express `player.gold < 100 → craft` and similar persona rules — not a general scripting language. It is the escape hatch that makes "protocol-agnostic" defensible even with a primitive library of size one.

## Runtime and speed

The engine runs on **LiteSVM** (in-process SVM). For the same `100 agents × 180 ticks` workload, LiteSVM completes in **0.898s** end-to-end; `solana-test-validator` with `--bpf-program` preload and warm caches takes **901.461s** (measured 2026-04-12). That is roughly a **~900x speedup**, entirely from RPC and confirmation overhead removal — both paths execute the same `lending_pool.so` BPF program logic.

**Honest caveat:** LiteSVM does not model full validator behavior (gossip, vote, PoH). The speedup is infrastructure overhead removal, not a program-level optimization. `solana-test-validator` is still the correct environment for validator-level parity checks, and the parity test at `engine/tests/t05_lending_integration.rs` stays gated on `RIPTIDE_RUN_VALIDATOR_TESTS=1` as the diagnostic reference path. LiteSVM is the default runtime; the validator path is diagnostic only.

## Determinism

Same seed = same result, byte-for-byte, across both the lending fixture and the generic fixture. The `t15_e2e_determinism` integration test enforces this on every run.

## Build

```bash
# Engine
cargo build --release -p riptide-engine

# Lending program
cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml

# Generic demo program
cargo build-sbf --manifest-path programs/resource_grinder/Cargo.toml

# CLI (TypeScript wrapper)
(cd cli && npm run build)
```

## Run the lending demo

```bash
bash demo/run-demo.sh
```

Prints a side-by-side safe-vs-risky headline-metric comparison. See `demo/README.md` for expected output and per-persona breakdown.

## Run the generic (non-DeFi) demo

```bash
cargo run --release -p riptide-engine -- \
  --config fixtures/generic-demo.run.json \
  --policies fixtures/generic-demo.policies.json \
  --adapter fixtures/adapters/resource-grinder.toml \
  --output /tmp/riptide-generic-demo.json
```

The `resource-grinder` program has no lending semantics at all — it is a toy "grind for resources, trade at a market" SBF program used to prove the generic path end-to-end. If you can run this, you can adapt Riptide to your protocol.

## Repo layout

- `engine/` — Rust simulation engine. `src/primitive/` holds the `Primitive` base trait, `LendingPrimitive`, `AmmPrimitive`, and the `GenericPrimitive` harness.
- `cli/` — TypeScript CLI wrapper. Handles persona compilation, adapter pre-validation (Zod mirror of the serde schema), orchestration, and the `riptide adapt` subcommand.
- `programs/` — standalone SBF crates (`lending_pool/`, `resource_grinder/`) built out of the root workspace so the pinned Solana/Borsh build environment stays intact.
- `fixtures/` — run configs, policies, adapter TOMLs, and the oracle golden-bytes SSOT.
- `skills/riptide-adapt/` — Claude Code skill wrapping `riptide adapt`.
- `demo/` — safe-vs-risky lending demo shell script and configs.

## Status

Sprint 3 (Protocol-Agnostic Unlock) closed on 2026-04-13 with the P0 spine green (T01–T06), Phase 4 distribution layer shipped (T07–T09), and this README + the ROADMAP flipped to match. Two open manual-verification gates remain: `riptide adapt` against a live OpenAI-compatible endpoint, and the Claude Code skill invocation end-to-end. Neither gates the pivot story; both are tracked in `.specs/project/STATE.md`.

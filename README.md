# Riptide

> Riptide runs your Solana program against hundreds of different users under any market scenario you want and tells you which combination breaks it — before mainnet does.

Riptide is a **multi-agent simulator for shared program state under time pressure**. It is not a DeFi simulator. DeFi is the first application because the failure modes are economically catastrophic and the need is loud — but the engine does not know or care about finance. Riptide is positioned against *any* Solana program, native or generic, with or without LLM-assisted adapter generation.

## Two paths in

> *"Two ways to use Riptide: write your own experiments if you already know what you're testing for, or let the `riptide-scenarios` skill propose a starter catalog based on your program. Both run deterministically against your real code and surface the knife edges. Zero setup inside Claude Code."*

- **Path A — write your own experiments.** If you already know what you're testing for, author a run-config + policies + adapter TOML directly. The safe-vs-risky lending demo (`demo/run-demo.sh`) and the non-DeFi resource-grinder demo are the canonical examples.
- **Path B — let the skill propose a starter catalog.** Install the `riptide-scenarios` Claude Code skill ([`skills/riptide-scenarios/SKILL.md`](skills/riptide-scenarios/SKILL.md)), invoke it inside any Claude Code session on your adapter + IDL, and it classifies plausible failure modes for your program and proposes 3–5 ranked starter experiments (whale concentration, shock cascades, utilization stress, persona-mix instability, oracle lag). The skill writes run-configs to `fixtures/scenarios/<adapter>/<experiment>/` and does **not** autorun — the dev picks what to run.

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

## What ships today

**Three primitives, one abstraction.**

1. **`LendingPrimitive`** — a trait with five actions (deposit, borrow, repay, withdraw, liquidate) and two observations (health factor, pool state). The forked Solend SPL-Token-Lending pool is its first impl and drives the safe-vs-risky demo.
2. **`GenericPrimitive`** — the ceiling-remover. You describe your protocol's actions, observations, and personas inline in a ~30-line TOML adapter file, point the engine at your compiled `.so` and your Anchor IDL, and Riptide runs your program with no custom Rust needed. The shipping non-DeFi demo (`programs/resource_grinder/`) proves the path is real.
3. **`AmmPrimitive`** — a sibling trait sketch compiled alongside `LendingPrimitive`. It is a compile-time pressure-test of the abstraction, not a runnable impl. The two traits fit the same shape with zero reshape of the base — that is a meaningful validation artifact for the pivot.

**Two demo fixtures ship in this repo.**

- **Solend-fork lending (safe vs risky).** `fixtures/adapters/solend-fork.toml` drives the safe-vs-risky demo end-to-end via the adapter, not via hardcoded harness wiring. Run it with `bash demo/run-demo.sh`.
- **Resource-grinder (non-DeFi generic demo).** `fixtures/adapters/resource-grinder.toml` + `fixtures/generic-demo.run.json` + `fixtures/generic-demo.policies.json` run the generic primitive against a standalone SBF program at `programs/resource_grinder/`. Byte-stable under `cargo test -p riptide-engine --test t15_e2e_determinism`.

**Adapter generation via Claude Code skill.** Install the `riptide-adapt` Claude Code skill. Invoke it inside any Claude Code session on your program's IDL — the skill reads your program, generates an adapter TOML using your session's existing LLM, writes it, and runs a smoke test against your program. Zero endpoint configuration. Zero API keys. Zero additional LLM cost. The session's model is the generator.

`riptide adapt` is the smoke-test harness the skill invokes. It validates a generated adapter by booting the local engine with it and confirming one write-action produces a state delta. It does not call any external service; it runs entirely against the local LiteSVM engine.

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
- `cli/` — TypeScript CLI wrapper. Handles persona compilation, adapter pre-validation (Zod mirror of the serde schema), orchestration, and the `riptide adapt` smoke-test harness.
- `programs/` — standalone SBF crates (`lending_pool/`, `resource_grinder/`) built out of the root workspace so the pinned Solana/Borsh build environment stays intact.
- `fixtures/` — run configs, policies, adapter TOMLs, and the oracle golden-bytes SSOT.
- `skills/riptide-adapt/` — self-contained Claude Code skill for adapter generation. Reads its own `prompts/` directory and uses the session's LLM; invokes `riptide adapt` for smoke verification.
- `demo/` — safe-vs-risky lending demo shell script and configs.

## Status

The protocol-agnostic architecture (lending + generic primitive + adapter TOML + AMM trait sketch) ships today, alongside the `riptide-adapt` Claude Code skill for LLM-assisted adapter generation. `riptide adapt` is the smoke-test harness the Claude Code skill invokes; the skill itself is the sole adapter-generation surface, using the session's own LLM. No standalone HTTP path, no BYOK endpoint configuration, no external service dependency.

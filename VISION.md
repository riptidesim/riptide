# Riptide — Vision

**Audience:** Solana program devs, auditors, and researchers deciding whether Riptide fits their workflow. If you already have Riptide running and want the quickstart, go back to the [`README`](README.md).

## Lab, not oracle

Riptide is a lab, not an oracle. The dev picks the experiment — Riptide does not tell you what's wrong with your program. Riptide runs the experiment deterministically: same seed in, same bytes out, every time, so the grid you're reading is reproducible from the adapter TOML and the persona TOML alone. And nobody is claiming this catches bugs on its own. The grid maps a parameter region; the dev draws the conclusions. A cell that comes back with bad debt is not a bug report — it is a point in parameter space where the program's math lost headroom, and the dev is the one who decides whether that point matters.

## Two paths in

Two ways to use Riptide: write your own experiments if you already know what you're testing for, or let the `riptide-scenarios` skill propose a starter catalog based on your program. Both run deterministically against your real code and surface the knife edges. Zero setup inside Claude Code.

- **Path A — write your own experiments.** If you already know what you're testing for, author a run-config + policies + adapter TOML directly. The safe-vs-risky lending demo (`examples/run-demo.sh`) and the non-DeFi resource-grinder demo are the canonical examples.
- **Path B — let the skill propose a starter catalog.** Install the `riptide-scenarios` Claude Code skill ([`skills/riptide-scenarios/SKILL.md`](skills/riptide-scenarios/SKILL.md)), invoke it inside any Claude Code session on your adapter + IDL, and it classifies plausible failure modes for your program and proposes 3–5 ranked starter experiments (whale concentration, shock cascades, utilization stress, persona-mix instability, oracle lag, price manipulation, liquidation cascades, impermanent-loss spikes). The skill writes run-configs to `fixtures/scenarios/<adapter>/<experiment>/` and does **not** autorun — the dev picks what to run.

The shipping example of Path A at scale is the Solend-fork case study: a 3×3 whale × shock parameter-boundary discovery run on the Solend fork. See [`docs/case-studies/solend-fork.md`](docs/case-studies/solend-fork.md) for the full report and the load-bearing claim: *Riptide maps the danger region; Solend's actual parameters sit inside it.*

## The six-layer stack

Every Riptide bundle layers six declarative surfaces on top of your program:

1. **Adapter** — one TOML file declaring your program, its actions, its observations, and its invariants.
2. **Personas** — TOML files describing agent behavior with a trigger DSL (`player.gold < 100 → craft`).
3. **Scenarios** — engine shocks (oracle trajectories, scheduled actions) mounted from declarative TOML presets.
4. **Parameters** — run-config knobs that sweep over the dimensions that matter (whale share, shock magnitude, trade size, leverage, depositor concentration).
5. **Failure-mode taxonomy** — categories like `whale_concentration`, `margin_cascade_from_oracle_shock`, `price_manipulation_via_swap`, `impermanent_loss_spike`. The `riptide-scenarios` skill matches your adapter's shape against this taxonomy.
6. **Invariants** — machine-checkable properties (`no_bad_debt`, `reserve_a > 0`, `k == reserve_a * reserve_b` within tolerance) declared inline in the adapter. The engine exits non-zero when any invariant fires, so invariants double as CI gates.

Three shipping bundles — **lending** (Solend fork), **perps** (perps-lite), and **AMM** (constant-product x*y=k) — exercise every layer end-to-end.

## Runtime posture — LiteSVM by default

The engine runs on **LiteSVM** (in-process SVM). For the same `100 agents × 180 ticks` workload, LiteSVM completes in **0.898s** end-to-end; `solana-test-validator` with `--bpf-program` preload and warm caches takes **901.461s** (measured 2026-04-12). That is roughly a **~900x speedup**, entirely from RPC and confirmation overhead removal — both paths execute the same `lending_pool.so` BPF program logic.

LiteSVM does not model full validator behavior (gossip, vote, PoH). The speedup is infrastructure overhead removal, not a program-level optimization. `solana-test-validator` is still the correct environment for validator-level parity checks, and the parity test at `engine/tests/lending_integration.rs` stays gated on `RIPTIDE_RUN_VALIDATOR_TESTS=1` as the diagnostic reference path. LiteSVM is the default runtime; the validator path is diagnostic only.

## Determinism

Same seed = same result, byte-for-byte, across the lending, perps, AMM, and generic fixtures. The `e2e_determinism` integration test enforces this on every run, and replay mode extends the same guarantee to historical trajectories.

## Deeper docs

- [`docs/vision.md`](docs/vision.md) — extended stance, what Riptide is explicitly not, adversarial-review posture.
- [`docs/architecture.md`](docs/architecture.md) — the six-layer stack, LiteSVM caveats, adapter pipeline.
- [`docs/install.md`](docs/install.md) — hands-on setup, Docker, from-source, upgrade path.

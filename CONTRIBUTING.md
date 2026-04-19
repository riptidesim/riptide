# Contributing to Riptide

Riptide is a protocol-agnostic economic simulator for Solana programs. Every shipping Riptide bundle — lending, perps, AMM today; whatever ships next — layers the same **six-layer stack** on top of your program:

1. **Adapter** — one TOML file declaring your program, its actions, observations, and invariants.
2. **Personas** — TOML files describing agent behavior with a small trigger DSL (`player.gold < 100 → craft`).
3. **Scenarios** — engine shocks (oracle trajectories, scheduled actions) mounted from declarative TOML presets.
4. **Parameters** — run-config knobs that sweep over the dimensions that matter (whale share, shock magnitude, trade size, leverage).
5. **Failure-mode taxonomy** — categories like `whale_concentration`, `margin_cascade_from_oracle_shock`, `price_manipulation_via_swap`. The `riptide-scenarios` skill matches your adapter's shape against this taxonomy to propose experiments.
6. **Invariants** — machine-checkable properties (`no_bad_debt`, `reserve_a > 0`, `k == reserve_a * reserve_b` within tolerance) declared inline in the adapter. The engine exits non-zero when any invariant fires, so invariants double as CI gates.

The growth rhythm is: one new protocol class per sprint, shipped as a **bundle** (all six layers) rather than as a trait in the engine. That is a deliberate architectural choice — it means adding a new protocol class does not require reshaping the engine, only adding declarative fixtures and a skill-prompt extension. The three bundles that ship today each validated this rhythm end-to-end with an independent cold-chain discovery experiment.

## How to add a new adapter

An adapter wires a specific Solana program into the engine.

1. Compile your program to `.so` and get its Anchor IDL (or a hand-written IDL JSON).
2. Either:
   - **Generate it with the skill.** Install the `riptide-adapt` Claude Code skill (`skills/riptide-adapt/SKILL.md`). Invoke it in-session pointing at your program source or IDL — it reads the program, classifies it (lending / perps / AMM / generic), writes a TOML adapter, and runs `riptide adapt` as a smoke test. No API keys, no endpoint config.
   - **Write it by hand.** Copy the closest shipping adapter (`fixtures/adapters/solend-fork.toml`, `perps-fork.toml`, `amm-fork.toml`, or `resource-grinder.toml`) and adapt the `program_so`, `[[accounts]]`, `[[actions]]`, `[[observations]]`, and `[[invariants]]` blocks.
3. Run `riptide adapt --adapter fixtures/adapters/<your-adapter>.toml` to confirm the engine boots it and observes a state delta.
4. Commit the adapter under `fixtures/adapters/` and the IDL under `fixtures/idls/`.

## How to add a persona

Personas are pure TOML — one file per persona, committed under `fixtures/personas/`.

1. Copy a persona whose shape fits your protocol class (`fixtures/personas/whale.toml` for lending, `fixtures/personas/leveraged-long.toml` for perps, `fixtures/personas/arbitrageur.toml` for AMM).
2. Edit the trigger DSL (single comparison op + constant per rule today) and the action block to reference only your adapter's declared actions.
3. Smoke-test the persona by running a small scratch simulation (see `scripts/amm-scratch.sh` for the sidecar pattern) — a persona TOML that parses clean + emits at least one action per tick against its adapter is ready to ship.
4. Add the persona to a scenario under `fixtures/scenarios/<adapter>/<experiment>/` or let the `riptide-scenarios` skill reference it.

## How to add a failure-mode taxonomy category

Taxonomy lives in `skills/riptide-scenarios/prompts/classify.md` (discrimination) and `skills/riptide-scenarios/prompts/propose.md` (proposal templates).

1. Open `skills/riptide-scenarios/prompts/classify.md` and add your category under the discrimination rules. Each rule needs an **adapter-shape hook** (what `[actions]` / `[observations]` / `[[invariants]]` keys trigger it) and an **IDL hook** (what instruction names trigger it) so the classifier fires on your adapter class and stays quiet on the others.
2. Open `skills/riptide-scenarios/prompts/propose.md` and add one proposal template — minimum a 1D sweep, ideally a 2D grid with full-cell materialization (see the `whale-shock-grid`, `depositor-shock-grid`, and `trade-size-volume-grid` templates for the pattern).
3. Extend the Zod enum in `cli/src/scenarios/validate.ts` with your new `failure_mode` value so `riptide scenarios --validate` accepts configs that reference it.
4. Run the cold-chain validation flow (three-session, same pattern the shipping bundles used) against your new adapter and record the verdict.

## Running the regression gates

Before opening a PR, make sure the regression floor is green:

```bash
cargo test -p riptide-engine --test litesvm_parity
cargo test -p riptide-engine --test e2e_determinism
cargo test -p riptide-engine --test perps_fork_roundtrip
cargo test -p riptide-engine --test amm_fork_roundtrip
(cd cli && npm test)
```

The hero-grid hash `89ca84209f3423c317e6be96f14261a9ebed7a9668398a08087a25631b782a11` for the `w25-s40` cell must stay byte-stable — any change that flips it without a conscious retune is a determinism regression.

## License

Riptide is dual-licensed under **MIT OR Apache-2.0** at your option. Contributions are accepted under the same terms.

# Loopscale-Shape Collateral-Mispricing Bad-Debt Replay

Named failure-shape replay artifact for Riptide's Solana lending fork.
Captures the geometry of an inflated-collateral borrow that becomes
underwater the moment the oracle realizes the true price, then pushes
through a liquidation cascade that lands real bad debt on the pool.

## What this proof is

This is an **economic-shape replay** of the collateral-mispricing
geometry behind the April 2025 Loopscale exploit. It is NOT:

- a byte-level reproduction of Loopscale's mainnet program or the
  slot state from the incident,
- an audit or safety claim about Loopscale Labs, their lending
  program, or any deployed Solana lending protocol,
- a faithful model of LP-token NAV pricing — the toy fixture realizes
  the mispricing as a single-tick oracle correction rather than a
  structural NAV recompute.

It IS a discrete, rerunnable, machine-checkable pressure replay of
the **inflated-collateral borrow → mispricing realization → bad-debt
cascade** geometry, against Riptide's shipped Solend-fork toy lending
program, using explicit per-tick instructions and a declared oracle
trajectory.

> **Why this pack is shape-only, not bytecode.** The original plan
> called for a real-bytecode replay using Loopscale's mainnet program
> + a slot-pinned account snapshot. That requires mainnet RPC access
> and a license review for redistributing the program binary; both
> were out of scope for this branch. This shape replay reproduces the
> economic geometry the slide names; a follow-up bytecode pack can
> replace it without changing the invariant-firing claim.

## Historical inspiration

In April 2025 Loopscale (a Solana lending protocol) lost approximately
**$5.8M** when an LP-token's reported NAV-as-collateral diverged from
the token's actual realizable value. The shape of the incident:

1. The protocol priced an LP-token collateral at an inflated NAV.
2. An attacker deposited the LP-token and borrowed against the
   inflated value, drawing down a loan size the actual NAV would never
   have supported.
3. When the mispricing was recognized, the position was deeply
   underwater; subsequent liquidation could not seize enough collateral
   to cover repay+bonus, and the shortfall accrued as protocol bad
   debt.

This pack reproduces the **same accounting outcome** on Riptide's
Solana toy lending fork by realizing the mispricing as a single-tick
oracle correction (price 200 → price 100) rather than as a structural
LP-NAV recompute. The geometry is otherwise identical: the borrower
is healthy under the inflated regime, becomes underwater the moment
the oracle corrects, and the liquidation cascade lands bad debt.

## Load-bearing claim

Initial state at oracle price 200 (the inflated regime):

- borrower-0 deposits 100 collateral, borrows 13500 debt.
- collateral_value = 100 × 200 = 20000; max_borrow_value = 20000 × 0.7
  = 14000 → 13500 borrow is allowed.
- liquidation_value = 20000 × 0.8 = 16000; health_factor = 16000 ×
  10000 / 13500 ≈ **11851 bps** (well above the 10000 bps liquidation
  threshold).

Tick 1 (oracle correction, price 200 → 100):

- liquidation_value = 100 × 100 × 0.8 = 8000; health_factor = 8000 ×
  10000 / 13500 ≈ **5926 bps**. Position is underwater.

Tick 2 (liquidator settles):

- liquidator-0 calls `liquidate(target = borrower-0, repay_amount =
  13500)`.
- seized_value = 13500 × (10000 + 500) / 10000 = 14175.
- collateral_to_seize = ⌈14175 / 100⌉ = 142; actual_collateral =
  min(142, 100) = 100.
- shortfall = 14175 − 100×100 = **4175**, accrued as `pool.bad_debt`.

Final pinned values (`expected-summary.json`):

- `result_sha256` = `d6d71b3b79be760d486f510606866bdccb4be4d9ab8c2df19e45409ad7b386ff`
- `total_bad_debt` = `4175.0`
- `bad_debt_invariant_firings` = `1` at `terminal_bad_debt_tick = 2`
- `largest_single_tick_drawdown` = `0.5` (the price 200 → 100
  correction)

Credibility gate: the replay-scoped adapter declares a single
`collateral_health` invariant (`pool.bad_debt == 0`). The integration
test asserts the invariant fires at tick 2 — the cascade tick — and
only there.

## Files

- `initial-state.json` — borrower-0's deposit + borrow at the
  inflated oracle price.
- `trajectory.json` — single-tick liquidation event at tick 2.
- `oracle-trajectory.json` — three-tick price path: inflated regime,
  correction, terminal.
- `adapter.toml` — replay-scoped lending adapter with the
  `collateral_health` invariant. The shipping
  `fixtures/adapters/lending.toml` stays clean to preserve hero-grid
  and lending-whale-bad-debt determinism.
- `config.json` — the replay-config JSON the CLI consumes.
- `expected-summary.json` — canonical SHA-256 + invariant firing
  baseline the engine test asserts against.
- `manifest.json`, `summary.md`, `trace.md`, `rerun.sh`, `inputs/`,
  `outputs/`, `riptide-output/` — rerun-generated artifacts.

## Rerun command

```
cd /path/to/riptide     # monorepo root
riptide replay fixtures/replays/loopscale-collateral-mispricing/config.json \
  --allow-invariant-violations
```

`--allow-invariant-violations` is load-bearing: the proof *wants* the
`collateral_health` invariant to fire at tick 2 — that's the evidence
signal.

The byte-stable gate runs as an engine integration test:

```
cargo test -p riptide-engine --features litesvm-backend \
  --test replay_loopscale_collateral_mispricing
```

## Sources

- Loopscale Labs incident communications (April 2025): https://x.com/LoopscaleLabs
- Internal parameter-boundary reference: `docs/case-studies/lending.md`

## Honesty framing

Simulation evidence has explicit boundaries. A rerunnable invariant
firing at a named tick on a minimal Solana lending fork is stronger
than a hand-waved "stress test", but weaker than a formal proof or a
mainnet bytecode replay. The fixture names the *shape* of the failure
mode it models; the Loopscale incident is cited above as inspiration,
not as a byte-level reproduced fact. A follow-up bytecode pack would
strengthen the claim by replaying Loopscale's actual mainnet program
against a slot-pinned account snapshot near the exploit transaction.

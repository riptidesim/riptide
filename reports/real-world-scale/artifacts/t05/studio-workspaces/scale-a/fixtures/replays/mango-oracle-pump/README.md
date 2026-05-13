# Mango-Shape Oracle-Pump Bad-Debt Replay

Named failure-shape replay artifact for Riptide's Solana lending fork.
Captures the geometry of an oracle-followed price pump that lets a
trader borrow against inflated collateral, then leaves the protocol
holding bad debt when the price reverts.

## What this proof is

This is an **economic-shape replay** of the oracle-pump geometry
behind the October 2022 Mango Markets exploit. It is NOT:

- a byte-level reproduction of Mango v3's program or the slot state
  from the incident,
- an audit or safety claim about Mango Markets, Mango v3, or any
  deployed Solana perpetual-trading protocol,
- a faithful model of multi-source TWAP oracle composition or
  order-book-driven price discovery — the toy fixture realizes the
  pump and revert as two single-tick price moves rather than as a
  structural matching-engine reaction.

It IS a discrete, rerunnable, machine-checkable pressure replay of
the **oracle pump → leveraged borrow → revert → bad-debt** geometry,
against Riptide's shipped Solend-fork toy lending program, using
explicit per-tick instructions and a declared oracle trajectory.

> **Why this pack is shape-only, not bytecode.** The original plan
> called for a real-bytecode replay using Mango v3's mainnet program
> binary + a slot-pinned account snapshot from October 2022. Mango v3
> is GPL-3.0 (so binary redistribution requires a license review),
> mainnet RPC access was out of scope for this branch, and the
> partial-IDL effort to scope MangoCache + manipulator MangoAccount +
> MNGO-PERP PerpMarket into a clean read-set is meaningful work. This
> shape replay reproduces the economic geometry the slide names; a
> follow-up bytecode pack can replace it without changing the
> invariant-firing claim.

## Historical inspiration

On 11 October 2022 a single trader (Avraham Eisenberg) extracted
approximately **$116M** from Mango Markets. The exploit chain
(simplified):

1. The attacker funded two accounts on Mango with USDC.
2. They placed large self-trades on the MNGO-PERP market — a thin
   order book — pushing the spot price up by roughly an order of
   magnitude.
3. Mango's on-chain oracle composed a TWAP across multiple sources
   and followed the inflated spot.
4. The attacker borrowed USDC, USDT, MSOL, and other assets against
   their now-overstated MNGO collateral, draining the protocol's
   liquidity.
5. The MNGO price subsequently reverted; the attacker's positions
   became bad debt because the seized collateral could not cover the
   borrowed value.

This pack reproduces the **same protocol-level outcome** on Riptide's
Solana toy lending fork by realizing the pump and revert as
single-tick oracle moves. The geometry the engine asserts on:

- Borrow opens at the inflated regime.
- Position is healthy under the inflated price (the pre-revert state
  Mango's oracle observed).
- Price reverts; position is deeply underwater.
- Liquidation cascade lands real bad debt because the seized
  collateral falls short of repay+bonus value.

## Load-bearing claim

Bootstrap at the pre-pump oracle price 100:

- pump-trader deposits 100 collateral; no debt yet.

Tick 1 — oracle pumps to 500:

- pump-trader borrows 35000 against the inflated collateral.
- collateral_value = 100 × 500 = 50000; max_borrow_value = 50000 ×
  0.7 = 35000 → 35000 borrow lands at the LTV ceiling.
- liquidation_value = 50000 × 0.8 = 40000; health_factor =
  40000 × 10000 / 35000 ≈ **11428 bps** (healthy under the inflated
  regime).

Tick 2 — oracle reverts to 100 + liquidator settles:

- Pre-liquidate: liquidation_value = 100 × 100 × 0.8 = 8000;
  health_factor = 8000 × 10000 / 35000 ≈ **2285 bps** (deeply
  underwater).
- liquidator-0 calls `liquidate(target = pump-trader, repay_amount =
  35000)`.
- seized_value = 35000 × 1.05 = 36750.
- collateral_to_seize = ⌈36750 / 100⌉ = 368; actual_collateral =
  min(368, 100) = 100.
- shortfall = 36750 − 100×100 = **26750**, accrued as `pool.bad_debt`.

Final pinned values (`expected-summary.json`):

- `result_sha256` = `d2344f727c7b84ea9eb11573089c77bef6b66131d485ec90fbf65842e7c920e6`
- `total_bad_debt` = `26750.0`
- `bad_debt_invariant_firings` = `1` at `terminal_bad_debt_tick = 2`
- `largest_single_tick_drawdown` = `0.8` (the price 500 → 100 revert)

Credibility gate: the replay-scoped adapter declares a single
`oracle_bounds` invariant (`pool.bad_debt == 0`). The integration
test asserts the invariant fires at tick 2 — the cascade tick — and
only there. The invariant's name reflects the slide-08 framing:
"oracle bounds" violations manifest as bad-debt accrual when the
oracle's deviation is large enough to permit borrows the post-revert
price cannot sustain.

## Files

- `initial-state.json` — pump-trader's bootstrap deposit at the
  pre-pump oracle price.
- `trajectory.json` — tick-1 borrow at the inflated price + tick-2
  liquidation after the revert.
- `oracle-trajectory.json` — three-tick price path: pre-pump (100),
  pumped (500), reverted (100).
- `adapter.toml` — replay-scoped lending adapter with the
  `oracle_bounds` invariant. The shipping
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
riptide replay fixtures/replays/mango-oracle-pump/config.json \
  --allow-invariant-violations
```

`--allow-invariant-violations` is load-bearing: the proof *wants* the
`oracle_bounds` invariant to fire at tick 2 — that's the evidence
signal.

The byte-stable gate runs as an engine integration test:

```
cargo test -p riptide-engine --features litesvm-backend \
  --test replay_mango_oracle_pump
```

## Sources

- Chainalysis post-mortem of the Mango Markets exploit:
  - https://www.chainalysis.com/blog/mango-markets-exploit-october-2022/
- SEC complaint (Eisenberg, January 2023): SEC v. Eisenberg, 23-cv-173
- Halborn analysis of the perp-pump mechanics
- Internal parameter-boundary reference: `docs/case-studies/lending.md`

## Honesty framing

Simulation evidence has explicit boundaries. A rerunnable invariant
firing at a named tick on a minimal Solana lending fork is stronger
than a hand-waved "stress test", but weaker than a formal proof or a
mainnet bytecode replay. The fixture names the *shape* of the failure
mode it models; Mango Markets is cited above as inspiration, not as a
byte-level reproduced fact. A follow-up bytecode pack would
strengthen the claim by replaying Mango v3's actual mainnet program
against a slot-pinned account snapshot from October 2022, but that is
explicitly out of scope for this branch.

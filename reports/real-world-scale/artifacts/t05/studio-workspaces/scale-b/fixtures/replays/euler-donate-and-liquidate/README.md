# Euler-Shape Donate-and-Liquidate Bad-Debt Replay

Named failure-shape replay artifact for Riptide's Solana lending fork.
Captures the geometry of an attacker who drains their own collateral
out of a borrowed position via an LTV-bypassing donate path, then has
the underwater position liquidated by a sibling account so the
protocol absorbs the shortfall as bad debt.

## What this proof is

This is an **economic-shape replay** of the donate-and-liquidate
bad-debt geometry that the March 2023 Euler Finance exploit used. It
is NOT:

- a byte-level reproduction of Euler's EVM bytecode or the exploit
  transactions,
- an audit or safety claim about Euler Finance, eToken accounting, or
  any deployed lending protocol,
- a cross-chain replay (Euler is on Ethereum; this pack reproduces the
  *economic shape* on Riptide's Solana toy lending fork).

It IS a discrete, rerunnable, machine-checkable pressure replay of the
**LTV-bypass donation + liquidation → realized bad debt** geometry,
using explicit per-tick instructions on a flat oracle price (no
oracle-driven drawdown is needed — the donation is what creates the
underwater position).

## Historical inspiration

On 13 March 2023 a flash-loan attacker drained roughly **$197M** from
Euler Finance. The exploit chain (simplified):

1. The attacker deposited collateral and used Euler's leveraged
   `mint` to inflate both their debt and their collateral position.
2. They called `donateToReserves(...)`, which the protocol accounting
   treated as the user voluntarily handing collateral to the reserve
   pool. Crucially, this path did **not** re-check the donor's health
   factor, so the donor could leave themselves arbitrarily
   undercollateralized.
3. A sibling account then `liquidate`-d the now-underwater donor at
   the protocol's standard liquidation discount. The sibling captured
   the discount on the seized collateral while the donor's outstanding
   debt could not be fully covered by the (now-shrunken) collateral
   the protocol could seize. The shortfall accrued as protocol bad
   debt.

This pack reproduces the **same accounting flaw** on Riptide's Solana
toy lending fork. The toy program ships a `Donate` instruction that
removes collateral without re-checking the LTV — the structural
mirror of the Euler bug — so the pack proves Riptide's `no_bad_debt`
invariant fires when this geometry executes.

## Load-bearing claim

- 2 attacker-controlled accounts: `attacker-donor`, `attacker-liquidator`.
- Donor opens a healthy position: `collateral = 100`, `debt = 6400` at
  `price = 100`. Health factor 12500 bps (well above the 10000 bps
  liquidation threshold).
- Tick 1: donor calls `donate(80)`. The shipped on-chain handler
  removes 80 collateral without rechecking the LTV — donor is now at
  `collateral = 20`, `debt = 6400`, health factor 2500 bps (deeply
  underwater).
- Tick 2: liquidator calls `liquidate(target = donor, repay_amount =
  6400)`. The seized collateral (20) is far below the
  repay+5%-bonus value (6720), so a `4720` shortfall accrues to
  `pool.bad_debt`.

Credibility gate: the replay-scoped adapter declares a `no_bad_debt`
invariant (`pool.bad_debt == 0`). The integration test asserts the
invariant fires at tick 2 (the cascade tick) and only there.

Final pinned values (`expected-summary.json`):

- `result_sha256` = `03de00e2d2ba97344b1572ae79679d43473a27a136447c6b1a28691eda14a2f8`
- `total_bad_debt` = `4720.0`
- `bad_debt_invariant_firings` = `1` at `terminal_bad_debt_tick = 2`

## Files

- `initial-state.json` — donor's bootstrap deposit + borrow before
  tick 0.
- `trajectory.json` — per-tick donate (tick 1) + liquidate (tick 2).
- `oracle-trajectory.json` — flat price path; no oracle-driven event.
- `adapter.toml` — replay-scoped lending adapter that declares the
  optional `donate` instruction and the `no_bad_debt` invariant. The
  shipped `fixtures/adapters/lending.toml` stays clean to preserve the
  hero-grid byte-stability.
- `config.json` — the replay-config JSON the CLI consumes.
- `expected-summary.json` — canonical SHA-256 + invariant firing
  baseline the engine test asserts against.
- `manifest.json`, `summary.md`, `trace.md`, `rerun.sh`, `inputs/`,
  `outputs/`, `riptide-output/` — rerun-generated artifacts.

## Rerun command

```
cd /path/to/riptide     # monorepo root
riptide replay fixtures/replays/euler-donate-and-liquidate/config.json \
  --allow-invariant-violations
```

`--allow-invariant-violations` is load-bearing: the proof *wants* the
`no_bad_debt` invariant to fire at tick 2 — that's the evidence
signal.

The byte-stable gate runs as an engine integration test:

```
cargo test -p riptide-engine --features litesvm-backend \
  --test replay_euler_donate_and_liquidate
```

## Sources

- Halborn post-mortem of the Euler Finance hack:
  - https://www.halborn.com/blog/post/explained-the-euler-finance-hack-march-2023
- Omniscia's deep technical breakdown:
  - https://omniscia.io/reports/euler-finance-incident-post-mortem-6442f1da1453a700185156aa
- Internal parameter-boundary reference:
  - `docs/case-studies/lending.md`

## Honesty framing

Simulation evidence has explicit boundaries. A rerunnable invariant
firing at a named tick on a minimal Solana lending fork is stronger
than a hand-waved "stress test", but weaker than a formal proof or
the original Ethereum post-mortem. The fixture names the *shape* of
the failure mode it models; Euler Finance is cited above as
inspiration, not as a byte-level reproduced fact.

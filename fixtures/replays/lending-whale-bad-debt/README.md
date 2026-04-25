# Whale-Concentrated-Borrow Bad-Debt Pressure Replay

Named failure-shape replay artifact for Riptide's Solana lending
fork. Captures the geometry of a pool where an outsized whale borrow
position + oracle drawdown produces bad debt that the liquidation
cascade cannot fully cover.

## What this proof is

This is an **abstracted pressure replay** of a whale-concentrated-borrow
bad-debt geometry. It is NOT:

- a byte-level reproduction of any specific on-chain incident,
- a governance-intervention / OTC-coordination claim,
- an audit or safety claim about any real lending protocol (Solend
  / Save, Kamino, MarginFi, etc.).

It IS a discrete, rerunnable, machine-checkable pressure replay of
the **whale-borrow + oracle-drawdown → realized bad debt** geometry
against the shipped Solana lending fork, using explicit per-tick
instructions and a declared oracle trajectory instead of synthetic
personas.

## Historical inspiration

The public incident that inspired this fixture is the June 2022
Solend whale-risk event:

- June 19, 2022: Solend published `SLND1: Mitigate Risk From Whale`,
  disclosing a whale with 5.7M SOL deposited, 108M USDC/USDT
  borrowed, and a liquidation price of $22.30.
- June 20, 2022: the emergency-powers proposal was reversed via
  `SLND2`.
- June 27, 2022: public reporting described the whale as having
  reduced the risk after private coordination.

The mainnet incident was a **near-miss** governed by governance
response and OTC coordination — not a realized bad-debt event. This
replay models the counterfactual failure shape: what the same
whale-concentrated-borrow geometry looks like when those
out-of-protocol mitigations are *not* available, and the liquidation
cascade has to clear on-chain against a drawn-down oracle price.

## Load-bearing claim

The replay reproduces the same discrete mapping already established
by the sealed hero grid's `w25-s40` cell:

- 5 whale accounts,
- each whale starts with `collateral = 100`, `debt = 6400`,
- oracle price walks from `100` to `60` (a 40 % drawdown),
- 5 liquidator calls fire at the terminal stress tick (tick 4),
- each whale realizes `720` of shortfall,
- total pool bad debt finishes at `3600`.

Credibility gate: the replay-scoped adapter declares a `no_bad_debt`
invariant (`pool.bad_debt == 0`). The integration test asserts the
invariant fires at tick 4 (the cascade tick) and only there. That
is the machine-checkable signal — not just "bad debt is a summary
number in the output", but "the engine's declared invariant framework
fires on it at a named tick".

## Files

- `initial-state.json` — bootstrap instructions that create the five
  whale positions before tick 0.
- `trajectory.json` — per-tick liquidation sequence.
- `oracle-trajectory.json` — coarse multi-tick price path ending at
  the stress threshold.
- `adapter.toml` — replay-scoped lending adapter with the
  `no_bad_debt` invariant added (the shipped `fixtures/adapters/lending.toml`
  stays invariant-free to preserve its hero-grid byte-stability).
- `config.json` — the replay-config JSON the CLI consumes.
- `expected-summary.json` — canonical SHA-256 + invariant firing
  baseline the engine test asserts against.
- `riptide-output/replays/lending-whale-bad-debt/` — rerun-generated
  artifacts (`simulation-result.json`, `report.md`).

## Rerun command

```
cd /path/to/riptide     # monorepo root
riptide replay fixtures/replays/lending-whale-bad-debt/config.json \
  --allow-invariant-violations
```

`--allow-invariant-violations` is load-bearing: the proof *wants* the
`no_bad_debt` invariant to fire at tick 4 — that's the evidence
signal. Without the flag the CLI exits 1 on the first firing, which
is the right shape for a CI gate on a healthy-path run but the wrong
shape for an evidence replay.

The byte-stable gate runs as an engine integration test:

```
cargo test -p riptide-engine --release --features litesvm-backend \
  --test replay_lending_whale_bad_debt
```

## Sources

- Solend / Save official governance post: `SLND1: Mitigate Risk From Whale`
  - https://blog.save.finance/slnd1-mitigate-risk-from-whale-1504285ab4d2
- CoinDesk coverage of the emergency-powers reversal:
  - https://www.coindesk.com/business/2022/06/20/solends-whale-liquidation-crisis-prompts-second-vote-to-reverse-emergency-powers
- CoinDesk follow-up on the whale reducing risk:
  - https://www.coindesk.com/business/2022/06/27/solanas-biggest-defi-lender-almost-got-rekt-then-binance-stepped-in
- Internal parameter-boundary reference:
  - `docs/case-studies/lending.md`

## Honesty framing

Simulation evidence is not audit signoff. A rerunnable invariant
firing at a named tick on a minimal fork is stronger than a
hand-waved "stress test", but weaker than a formal proof or a
mainnet post-mortem. The fixture names the *shape* of the failure
mode it models; the specific real-world incident is cited above as
inspiration, not as a reproduced fact.

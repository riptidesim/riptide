# Solend June 2022 Whale-Risk Incident Reproduction

This directory ships the first historical replay artifact for Riptide's replay mode.

## Date correction

The directory name is `solend-nov-2022` for historical naming stability, but the public Solend whale-risk incident this replay is based on happened in **June 2022**:

- June 19, 2022: Solend published `SLND1: Mitigate Risk From Whale`, disclosing a whale with 5.7M SOL deposited, 108M USDC/USDT borrowed, and a liquidation price of $22.30.
- June 20, 2022: the emergency-powers proposal was reversed via `SLND2`.
- June 27, 2022: public reporting described the whale as having reduced the risk after private coordination.

The directory name stays aligned with its original tag for reproducibility, but the fixture metadata and this README use the corrected June 2022 framing.

## What this replay is

This is an **abstracted incident reproduction**, not a byte-level reconstruction of every historical Solend transaction.

The shipped `solend-fork.toml` adapter and `lending_pool` program do not model:

- governance intervention,
- OTC liquidation coordination,
- DEX depth / slippage,
- partial liquidator competition on-chain.

So this replay captures the economically relevant shape Riptide can represent honestly:

- outsized whale borrow concentration,
- a multi-tick oracle drawdown into the liquidation band,
- liquidations delayed until the discrete stress point,
- bad debt realized once collateral can no longer cover the liquidator's repay plus bonus.

Concretely, the fixture replays the same discrete mapping already established by the sealed hero grid's `w25-s40` cell:

- 5 whale accounts,
- each whale starts with `collateral = 100`, `debt = 6400`,
- oracle price walks from `100` to `60` (a 40% drawdown),
- 5 liquidator calls fire at the terminal stress tick,
- each whale realizes `720` of shortfall,
- total pool bad debt finishes at `3600`.

That is the load-bearing claim here: the replay mode can reproduce the **June 2022 whale-risk shape** on the shipped Solend fork, using explicit instructions and oracle updates instead of synthetic personas.

## Files

- `initial-state.json`
  - Bootstrap instructions that create the five whale positions before tick 0.
- `trajectory.json`
  - Per-tick liquidation sequence.
- `oracle-trajectory.json`
  - Coarse multi-tick price path ending at the stress threshold.
- `expected-summary.json`
  - Regression lock for the replay output.

## Sources

- Solend / Save official governance post: `SLND1: Mitigate Risk From Whale`
  - https://blog.save.finance/slnd1-mitigate-risk-from-whale-1504285ab4d2
- CoinDesk coverage of the emergency-powers reversal:
  - https://www.coindesk.com/business/2022/06/20/solends-whale-liquidation-crisis-prompts-second-vote-to-reverse-emergency-powers
- CoinDesk follow-up on the whale reducing risk:
  - https://www.coindesk.com/business/2022/06/27/solanas-biggest-defi-lender-almost-got-rekt-then-binance-stepped-in
- Internal parameter-boundary reference:
  - `docs/case-studies/solend-fork.md`

## Abstraction disclosure

The public incident was a near-miss governed by liquidation risk, governance response, and OTC coordination. This replay does **not** claim exact tx fidelity. It is a discrete reproduction of the whale-risk geometry against the shipped Solend fork adapter, using the same June 2022 parameter band that the hero grid already identified as the closest fit.

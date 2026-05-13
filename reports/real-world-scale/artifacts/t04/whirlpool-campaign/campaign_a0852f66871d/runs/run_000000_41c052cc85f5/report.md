# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/case-studies/whirlpools/.riptide/adapters/whirlpool.toml`
- **Seed**: 2026050832
- **Ticks**: 115
- **Agents**: 80 (40× Whale LP, 40× Steady LP)
- **Scenario**: whale-exit-pressure
- **Output**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-campaign/campaign_a0852f66871d/runs/run_000000_41c052cc85f5`

## Summary

| Metric | Value |
|--------|-------|
| fee_config.fee_numerator_avg | 300 |
| fee_config.fee_numerator_max | 300 |
| fee_config.fee_numerator_min | 300 |
| fee_config.protocol_fee_numerator_avg | 300 |
| fee_config.protocol_fee_numerator_max | 300 |
| fee_config.protocol_fee_numerator_min | 300 |
| lp_position.fee_owed_a_avg | 0 |
| lp_position.fee_owed_a_max | 0 |
| lp_position.fee_owed_a_min | 0 |
| lp_position.fee_owed_b_avg | 0 |
| lp_position.fee_owed_b_max | 0 |
| lp_position.fee_owed_b_min | 0 |
| lp_position.liquidity_avg | 1028.7500 |
| lp_position.liquidity_max | 1057.5000 |
| lp_position.liquidity_min | 1000 |
| pool.tick_current_index_avg | 0 |
| pool.tick_current_index_max | 0 |
| pool.tick_current_index_min | 0 |
| reserve_a.reserve_a_avg | 1000000004600 |
| reserve_a.reserve_a_max | 1000000009200 |
| reserve_a.reserve_a_min | 1000000000000 |
| reserve_b.reserve_b_avg | 1000000002300 |
| reserve_b.reserve_b_max | 1000000004600 |
| reserve_b.reserve_b_min | 1000000000000 |
| trader.balance_a_avg | 999999942.5000 |
| trader.balance_a_max | 1000000000 |
| trader.balance_a_min | 999999885 |
| trader.balance_b_avg | 999999971.2500 |
| trader.balance_b_max | 1000000000 |
| trader.balance_b_min | 999999942.5000 |
| whirlpool.liquidity_avg | 1082300 |
| whirlpool.liquidity_max | 1084600 |
| whirlpool.liquidity_min | 1080000 |

**Agent lifecycle**: 80 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

No notable events.

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Project Rust harness setup ran before tick 0; custom account bytes are developer-owned.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
exec riptide run /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-campaign/campaign_a0852f66871d/runs/run_000000_41c052cc85f5/run-config.json --adapter .riptide/adapters/whirlpool.toml --harness .riptide/harness
```

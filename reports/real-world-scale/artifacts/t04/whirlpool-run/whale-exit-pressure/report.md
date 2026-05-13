# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/case-studies/whirlpools/.riptide/adapters/whirlpool.toml`
- **Seed**: 1337
- **Ticks**: 115
- **Agents**: 80 (14× Directional swapper, 14× Concentrated LP, 13× Exit pressure, 13× Fee farmer, 13× Steady LP, 13× Whale LP)
- **Scenario**: whale-exit-pressure
- **Output**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-run/whale-exit-pressure`

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
| lp_position.liquidity_avg | 1010.0625 |
| lp_position.liquidity_max | 1020.1250 |
| lp_position.liquidity_min | 1000 |
| pool.tick_current_index_avg | 0 |
| pool.tick_current_index_max | 0 |
| pool.tick_current_index_min | 0 |
| reserve_a.reserve_a_avg | 1000000003852.5000 |
| reserve_a.reserve_a_max | 1000000007705 |
| reserve_a.reserve_a_min | 1000000000000 |
| reserve_b.reserve_b_avg | 1000000001552.5000 |
| reserve_b.reserve_b_max | 1000000003105 |
| reserve_b.reserve_b_min | 1000000000000 |
| trader.balance_a_avg | 999999951.8437 |
| trader.balance_a_max | 1000000000 |
| trader.balance_a_min | 999999903.6875 |
| trader.balance_b_avg | 999999980.5937 |
| trader.balance_b_max | 1000000000 |
| trader.balance_b_min | 999999961.1875 |
| whirlpool.liquidity_avg | 1080805 |
| whirlpool.liquidity_max | 1081610 |
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
exec riptide run .riptide/scenarios/whale-exit-pressure/run-config.json --adapter .riptide/adapters/whirlpool.toml --harness .riptide/harness
```

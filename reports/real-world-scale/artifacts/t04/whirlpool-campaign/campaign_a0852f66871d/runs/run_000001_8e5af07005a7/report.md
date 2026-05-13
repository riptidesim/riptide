# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/case-studies/whirlpools/.riptide/adapters/whirlpool.toml`
- **Seed**: 2026050846
- **Ticks**: 144
- **Agents**: 88 (1× Whale LP, 87× Steady LP)
- **Scenario**: fee-growth-churn
- **Output**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-campaign/campaign_a0852f66871d/runs/run_000001_8e5af07005a7`

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
| lp_position.liquidity_avg | 1071.1818 |
| lp_position.liquidity_max | 1142.3636 |
| lp_position.liquidity_min | 1000 |
| pool.tick_current_index_avg | 0 |
| pool.tick_current_index_max | 0 |
| pool.tick_current_index_min | 0 |
| reserve_a.reserve_a_avg | 1000000006336 |
| reserve_a.reserve_a_max | 1000000012672 |
| reserve_a.reserve_a_min | 1000000000000 |
| reserve_b.reserve_b_avg | 1000000006264 |
| reserve_b.reserve_b_max | 1000000012528 |
| reserve_b.reserve_b_min | 1000000000000 |
| trader.balance_a_avg | 999999928 |
| trader.balance_a_max | 1000000000 |
| trader.balance_a_min | 999999856 |
| trader.balance_b_avg | 999999928.8182 |
| trader.balance_b_max | 1000000000 |
| trader.balance_b_min | 999999857.6364 |
| whirlpool.liquidity_avg | 1094264 |
| whirlpool.liquidity_max | 1100528 |
| whirlpool.liquidity_min | 1088000 |

**Agent lifecycle**: 88 active, 0 liquidated, 0 depleted

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
exec riptide run /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-campaign/campaign_a0852f66871d/runs/run_000001_8e5af07005a7/run-config.json --adapter .riptide/adapters/whirlpool.toml --harness .riptide/harness
```

# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/adapters/stablecoin.toml`
- **Seed**: 1864268247
- **Ticks**: 24
- **Agents**: 20 (5× Cautious minter, 5× Leverage looper, 7× Panic redeemer, 3× Arb redeemer)
- **Scenario**: baseline
- **Output**: `/home/ailton/Work/riptide/riptide/fixtures/scenarios/stablecoin/redemption-run-sweep`

## Summary

| Metric | Value |
|--------|-------|
| pool.collateral_assets_avg | 88.8400 |
| pool.collateral_assets_max | 180 |
| pool.collateral_assets_min | 0 |
| pool.cumulative_hedge_loss_bps_avg | 0 |
| pool.cumulative_hedge_loss_bps_max | 0 |
| pool.cumulative_hedge_loss_bps_min | 0 |
| pool.effective_collateral_ratio_bps_avg | 50339.0800 |
| pool.effective_collateral_ratio_bps_max | 80000 |
| pool.effective_collateral_ratio_bps_min | 0 |
| pool.pending_redemption_assets_avg | 0 |
| pool.pending_redemption_assets_max | 0 |
| pool.pending_redemption_assets_min | 0 |
| pool.pending_redemption_count_avg | 0 |
| pool.pending_redemption_count_max | 0 |
| pool.pending_redemption_count_min | 0 |
| pool.reserve_buffer_assets_avg | 0 |
| pool.reserve_buffer_assets_max | 0 |
| pool.reserve_buffer_assets_min | 0 |
| pool.stable_supply_avg | 17.0800 |
| pool.stable_supply_max | 38 |
| pool.stable_supply_min | 0 |
| position.claimable_collateral_avg | 0 |
| position.claimable_collateral_max | 0 |
| position.claimable_collateral_min | 0 |
| position.collateral_deposited_avg | 4.4420 |
| position.collateral_deposited_max | 9 |
| position.collateral_deposited_min | 0 |
| position.cumulative_claimed_avg | 0 |
| position.cumulative_claimed_max | 0 |
| position.cumulative_claimed_min | 0 |
| position.pending_redeem_assets_avg | 0 |
| position.pending_redeem_assets_max | 0 |
| position.pending_redeem_assets_min | 0 |
| position.stable_minted_avg | 0.8540 |
| position.stable_minted_max | 1.9000 |
| position.stable_minted_min | 0 |

**Agent lifecycle**: 20 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T1: Leverage looper (agent-009) — mint_stable → failed
- T1: Panic redeemer (agent-011) — request_redeem → failed
- T1: Panic redeemer (agent-012) — request_redeem → failed
- T1: Panic redeemer (agent-013) — request_redeem → failed
- T1: Panic redeemer (agent-014) — request_redeem → failed
- T1: Panic redeemer (agent-015) — request_redeem → failed
- T1: Panic redeemer (agent-016) — request_redeem → failed
- T1: Panic redeemer (agent-017) — request_redeem → failed
- T1: Arb redeemer (agent-018) — request_redeem → failed
- T1: Arb redeemer (agent-019) — request_redeem → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
exec riptide run fixtures/scenarios/stablecoin/redemption-run-sweep/run-config.json --adapter fixtures/adapters/stablecoin.toml
```

# Riptide Simulation Report

## Run metadata

- **Adapter**: `fixtures/adapters/stablecoin.toml`
- **Seed**: 4303
- **Ticks**: 30
- **Agents**: 25 (14× Leverage looper, 5× Cautious minter, 4× Panic redeemer, 2× Arb redeemer)
- **Scenario**: baseline
- **Output**: `fixtures/scenarios/stablecoin/mint-concentration-sweep`

## Summary

| Metric | Value |
|--------|-------|
| pool.collateral_assets_avg | 180.2903 |
| pool.collateral_assets_max | 366 |
| pool.collateral_assets_min | 0 |
| pool.cumulative_hedge_loss_bps_avg | 0 |
| pool.cumulative_hedge_loss_bps_max | 0 |
| pool.cumulative_hedge_loss_bps_min | 0 |
| pool.effective_collateral_ratio_bps_avg | 29797.1935 |
| pool.effective_collateral_ratio_bps_max | 46000 |
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
| pool.stable_supply_avg | 63.6452 |
| pool.stable_supply_max | 144 |
| pool.stable_supply_min | 0 |
| position.claimable_collateral_avg | 0 |
| position.claimable_collateral_max | 0 |
| position.claimable_collateral_min | 0 |
| position.collateral_deposited_avg | 7.2116 |
| position.collateral_deposited_max | 14.6400 |
| position.collateral_deposited_min | 0 |
| position.cumulative_claimed_avg | 0 |
| position.cumulative_claimed_max | 0 |
| position.cumulative_claimed_min | 0 |
| position.pending_redeem_assets_avg | 0 |
| position.pending_redeem_assets_max | 0 |
| position.pending_redeem_assets_min | 0 |
| position.stable_minted_avg | 2.5458 |
| position.stable_minted_max | 5.7600 |
| position.stable_minted_min | 0 |

**Agent lifecycle**: 25 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T1: Leverage looper (agent-001) — mint_stable → failed
- T1: Leverage looper (agent-002) — mint_stable → failed
- T1: Leverage looper (agent-006) — mint_stable → failed
- T1: Leverage looper (agent-009) — mint_stable → failed
- T1: Leverage looper (agent-012) — mint_stable → failed
- T1: Leverage looper (agent-013) — mint_stable → failed
- T1: Panic redeemer (agent-020) — request_redeem → failed
- T1: Panic redeemer (agent-021) — request_redeem → failed
- T1: Panic redeemer (agent-022) — request_redeem → failed
- T1: Panic redeemer (agent-023) — request_redeem → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
riptide run fixtures/scenarios/stablecoin/mint-concentration-sweep/run-config.json
```

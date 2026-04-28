# Technical trace — `replay:stablecoin-uxd-style-collateral-cascade`

> Simulation evidence with explicit boundaries.

- **Adapter:** `fixtures/replays/stablecoin-uxd-style-collateral-cascade/adapter.toml`
- **Kind:** `replay`
- **Total ticks:** 6
- **Event count:** 17
- **Canonical hash:** `ef99f49ecf5581e11652d22a287f72cb257dbc8e036000c82d634c3d86f6bb6c`

## Events of interest

Scope: invariant firings, bridge firings, scheduled actions, oracle writes.

| Tick | Component | Event | Details |
|-----:|-----------|-------|---------|
| 3 | `engine` | `invariant_fired:no_hedge_loss_during_healthy_run` | field=`pool.cumulative_hedge_loss_bps` observed=4000.0 == expected=0.0 |
| 3 | `engine` | `invariant_fired:full_backing` | field=`pool.effective_collateral_ratio_bps` observed=9066.0 >= expected=10000.0 |
| 4 | `engine` | `invariant_fired:no_hedge_loss_during_healthy_run` | field=`pool.cumulative_hedge_loss_bps` observed=4000.0 == expected=0.0 |
| 4 | `engine` | `invariant_fired:full_backing` | field=`pool.effective_collateral_ratio_bps` observed=5333.0 >= expected=10000.0 |
| 4 | `engine` | `invariant_fired:no_redemption_queue_formation` | field=`pool.pending_redemption_count` observed=3.0 == expected=0.0 |
| 5 | `engine` | `invariant_fired:no_hedge_loss_during_healthy_run` | field=`pool.cumulative_hedge_loss_bps` observed=4000.0 == expected=0.0 |
| 5 | `engine` | `invariant_fired:full_backing` | field=`pool.effective_collateral_ratio_bps` observed=5333.0 >= expected=10000.0 |
| 5 | `engine` | `invariant_fired:no_redemption_queue_formation` | field=`pool.pending_redemption_count` observed=3.0 == expected=0.0 |
| 6 | `engine` | `invariant_fired:no_hedge_loss_during_healthy_run` | field=`pool.cumulative_hedge_loss_bps` observed=4000.0 == expected=0.0 |
| 6 | `engine` | `invariant_fired:full_backing` | field=`pool.effective_collateral_ratio_bps` observed=5333.0 >= expected=10000.0 |
| 6 | `engine` | `invariant_fired:no_redemption_queue_formation` | field=`pool.pending_redemption_count` observed=3.0 == expected=0.0 |

## Invariant firings — snapshot context

| Tick | Invariant | Field | Observed | Expected (op) |
|-----:|-----------|-------|---------:|---------------|
| 3 | `no_hedge_loss_during_healthy_run` | `pool.cumulative_hedge_loss_bps` | 4000.0 | `==` 0.0 |
| 3 | `full_backing` | `pool.effective_collateral_ratio_bps` | 9066.0 | `>=` 10000.0 |
| 4 | `no_hedge_loss_during_healthy_run` | `pool.cumulative_hedge_loss_bps` | 4000.0 | `==` 0.0 |
| 4 | `full_backing` | `pool.effective_collateral_ratio_bps` | 5333.0 | `>=` 10000.0 |
| 4 | `no_redemption_queue_formation` | `pool.pending_redemption_count` | 3.0 | `==` 0.0 |
| 5 | `no_hedge_loss_during_healthy_run` | `pool.cumulative_hedge_loss_bps` | 4000.0 | `==` 0.0 |
| 5 | `full_backing` | `pool.effective_collateral_ratio_bps` | 5333.0 | `>=` 10000.0 |
| 5 | `no_redemption_queue_formation` | `pool.pending_redemption_count` | 3.0 | `==` 0.0 |
| 6 | `no_hedge_loss_during_healthy_run` | `pool.cumulative_hedge_loss_bps` | 4000.0 | `==` 0.0 |
| 6 | `full_backing` | `pool.effective_collateral_ratio_bps` | 5333.0 | `>=` 10000.0 |
| 6 | `no_redemption_queue_formation` | `pool.pending_redemption_count` | 3.0 | `==` 0.0 |

## State deltas around invariant firings

| Tick | Key | Value |
|-----:|-----|------:|
| 3 | `pool.cumulative_hedge_loss_bps` | 4000.0 |
| 3 | `pool.effective_collateral_ratio_bps` | 9066.0 |
| 3 | `pool.pending_redemption_count` | 0.0 |
| 4 | `pool.cumulative_hedge_loss_bps` | 4000.0 |
| 4 | `pool.effective_collateral_ratio_bps` | 5333.0 |
| 4 | `pool.pending_redemption_count` | 3.0 |
| 5 | `pool.cumulative_hedge_loss_bps` | 4000.0 |
| 5 | `pool.effective_collateral_ratio_bps` | 5333.0 |
| 5 | `pool.pending_redemption_count` | 3.0 |
| 6 | `pool.cumulative_hedge_loss_bps` | 4000.0 |
| 6 | `pool.effective_collateral_ratio_bps` | 5333.0 |
| 6 | `pool.pending_redemption_count` | 3.0 |

_Simulation evidence with explicit boundaries._

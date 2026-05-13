# Technical trace — `replay:liquid-staking-depeg-redemption-run`

> Simulation evidence with explicit boundaries.

- **Adapter:** `fixtures/replays/liquid-staking-depeg-redemption-run/adapter.toml`
- **Kind:** `replay`
- **Total ticks:** 6
- **Event count:** 14
- **Canonical hash:** `5bdc5f7c7bd8bef8b1a350c76ebaa0b8fbfc3954d3b26882aa89ab54e9fda704`

## Events of interest

Scope: invariant firings, bridge firings, scheduled actions, oracle writes.

| Tick | Component | Event | Details |
|-----:|-----------|-------|---------|
| 3 | `engine` | `invariant_fired:no_slash_during_healthy_run` | field=`pool.cumulative_slashed` observed=2000.0 == expected=0.0 |
| 4 | `engine` | `invariant_fired:no_slash_during_healthy_run` | field=`pool.cumulative_slashed` observed=2000.0 == expected=0.0 |
| 4 | `engine` | `invariant_fired:no_queue_formation` | field=`pool.pending_unstake_count` observed=4.0 == expected=0.0 |
| 5 | `engine` | `invariant_fired:no_slash_during_healthy_run` | field=`pool.cumulative_slashed` observed=2000.0 == expected=0.0 |
| 5 | `engine` | `invariant_fired:no_queue_formation` | field=`pool.pending_unstake_count` observed=4.0 == expected=0.0 |
| 6 | `engine` | `invariant_fired:no_slash_during_healthy_run` | field=`pool.cumulative_slashed` observed=2000.0 == expected=0.0 |
| 6 | `engine` | `invariant_fired:no_queue_formation` | field=`pool.pending_unstake_count` observed=4.0 == expected=0.0 |

## Invariant firings — snapshot context

| Tick | Invariant | Field | Observed | Expected (op) |
|-----:|-----------|-------|---------:|---------------|
| 3 | `no_slash_during_healthy_run` | `pool.cumulative_slashed` | 2000.0 | `==` 0.0 |
| 4 | `no_slash_during_healthy_run` | `pool.cumulative_slashed` | 2000.0 | `==` 0.0 |
| 4 | `no_queue_formation` | `pool.pending_unstake_count` | 4.0 | `==` 0.0 |
| 5 | `no_slash_during_healthy_run` | `pool.cumulative_slashed` | 2000.0 | `==` 0.0 |
| 5 | `no_queue_formation` | `pool.pending_unstake_count` | 4.0 | `==` 0.0 |
| 6 | `no_slash_during_healthy_run` | `pool.cumulative_slashed` | 2000.0 | `==` 0.0 |
| 6 | `no_queue_formation` | `pool.pending_unstake_count` | 4.0 | `==` 0.0 |

## State deltas around invariant firings

| Tick | Key | Value |
|-----:|-----|------:|
| 3 | `pool.cumulative_slashed` | 2000.0 |
| 3 | `pool.pending_unstake_count` | 0.0 |
| 4 | `pool.cumulative_slashed` | 2000.0 |
| 4 | `pool.pending_unstake_count` | 4.0 |
| 5 | `pool.cumulative_slashed` | 2000.0 |
| 5 | `pool.pending_unstake_count` | 4.0 |
| 6 | `pool.cumulative_slashed` | 2000.0 |
| 6 | `pool.pending_unstake_count` | 4.0 |

_Simulation evidence with explicit boundaries._

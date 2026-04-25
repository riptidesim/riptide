# Technical trace — `replay:multi:lst-lending-contagion-proof-upstream`

> Simulation evidence — not audit signoff.

- **Adapter:** `multi-component replay (liquid_staking × lending)`
- **Kind:** `replay-multi`
- **Total ticks:** 4
- **Event count:** 13
- **Canonical hash:** `d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb`

## Events of interest

Scope: invariant firings, bridge firings, scheduled actions, oracle writes.

| Tick | Component | Event | Details |
|-----:|-----------|-------|---------|
| 1 | `lending` | `bridge:lst_exchange_rate_to_lending_oracle` | liquid_staking.pool.exchange_rate_bps=10000.0 → lending.collateral_price_feed=100.0 |
| 2 | `lending` | `bridge:lst_exchange_rate_to_lending_oracle` | liquid_staking.pool.exchange_rate_bps=10000.0 → lending.collateral_price_feed=100.0 |
| 3 | `lending` | `bridge:lst_exchange_rate_to_lending_oracle` | liquid_staking.pool.exchange_rate_bps=6000.0 → lending.collateral_price_feed=60.0 |
| 3 | `liquid_staking` | `invariant_fired:liquid_staking:no_slash_during_healthy_run` | field=`liquid_staking.pool.cumulative_slashed` observed=4000.0 == expected=0.0 |
| 4 | `lending` | `bridge:lst_exchange_rate_to_lending_oracle` | liquid_staking.pool.exchange_rate_bps=6000.0 → lending.collateral_price_feed=60.0 |
| 4 | `liquid_staking` | `invariant_fired:liquid_staking:no_slash_during_healthy_run` | field=`liquid_staking.pool.cumulative_slashed` observed=4000.0 == expected=0.0 |
| 4 | `lending` | `invariant_fired:lending:no_bad_debt` | field=`lending.pool.bad_debt` observed=3600.0 == expected=0.0 |

## Invariant firings — snapshot context

| Tick | Invariant | Field | Observed | Expected (op) |
|-----:|-----------|-------|---------:|---------------|
| 3 | `liquid_staking:no_slash_during_healthy_run` | `liquid_staking.pool.cumulative_slashed` | 4000.0 | `==` 0.0 |
| 4 | `liquid_staking:no_slash_during_healthy_run` | `liquid_staking.pool.cumulative_slashed` | 4000.0 | `==` 0.0 |
| 4 | `lending:no_bad_debt` | `lending.pool.bad_debt` | 3600.0 | `==` 0.0 |

## State deltas around invariant firings

| Tick | Key | Value |
|-----:|-----|------:|
| 3 | `lending.pool.bad_debt` | 0.0 |
| 3 | `liquid_staking.pool.cumulative_slashed` | 4000.0 |
| 4 | `lending.pool.bad_debt` | 3600.0 |
| 4 | `liquid_staking.pool.cumulative_slashed` | 4000.0 |

_Simulation evidence — not audit signoff._

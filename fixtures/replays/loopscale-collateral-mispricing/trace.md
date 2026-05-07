# Technical trace — `replay:loopscale-collateral-mispricing`

> Simulation evidence — not audit signoff.

- **Adapter:** `adapter.toml`
- **Kind:** `replay`
- **Total ticks:** 2
- **Event count:** 2
- **Canonical hash:** `d6d71b3b79be760d486f510606866bdccb4be4d9ab8c2df19e45409ad7b386ff`

## Events of interest

Scope: invariant firings, bridge firings, scheduled actions, oracle writes.

| Tick | Component | Event | Details |
|-----:|-----------|-------|---------|
| 2 | `engine` | `invariant_fired:collateral_health` | field=`bad_debt` observed=4175.0 == expected=0.0 |

## Invariant firings — snapshot context

| Tick | Invariant | Field | Observed | Expected (op) |
|-----:|-----------|-------|---------:|---------------|
| 2 | `collateral_health` | `bad_debt` | 4175.0 | `==` 0.0 |

## State deltas around invariant firings

| Tick | Key | Value |
|-----:|-----|------:|

_Simulation evidence — not audit signoff._

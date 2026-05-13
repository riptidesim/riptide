# Technical trace — `replay:mango-oracle-pump`

> Simulation evidence — not audit signoff.

- **Adapter:** `adapter.toml`
- **Kind:** `replay`
- **Total ticks:** 2
- **Event count:** 3
- **Canonical hash:** `d2344f727c7b84ea9eb11573089c77bef6b66131d485ec90fbf65842e7c920e6`

## Events of interest

Scope: invariant firings, bridge firings, scheduled actions, oracle writes.

| Tick | Component | Event | Details |
|-----:|-----------|-------|---------|
| 2 | `engine` | `invariant_fired:oracle_bounds` | field=`bad_debt` observed=26750.0 == expected=0.0 |

## Invariant firings — snapshot context

| Tick | Invariant | Field | Observed | Expected (op) |
|-----:|-----------|-------|---------:|---------------|
| 2 | `oracle_bounds` | `bad_debt` | 26750.0 | `==` 0.0 |

## State deltas around invariant firings

| Tick | Key | Value |
|-----:|-----|------:|

_Simulation evidence — not audit signoff._

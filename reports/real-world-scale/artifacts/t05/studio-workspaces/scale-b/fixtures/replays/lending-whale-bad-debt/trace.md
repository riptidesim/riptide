# Technical trace — `replay:lending-whale-bad-debt`

> Simulation evidence with explicit boundaries.

- **Adapter:** `fixtures/replays/lending-whale-bad-debt/adapter.toml`
- **Kind:** `replay`
- **Total ticks:** 4
- **Event count:** 6
- **Canonical hash:** `6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1`

## Events of interest

Scope: invariant firings, bridge firings, scheduled actions, oracle writes.

| Tick | Component | Event | Details |
|-----:|-----------|-------|---------|
| 4 | `engine` | `invariant_fired:no_bad_debt` | field=`bad_debt` observed=3600.0 == expected=0.0 |

## Invariant firings — snapshot context

| Tick | Invariant | Field | Observed | Expected (op) |
|-----:|-----------|-------|---------:|---------------|
| 4 | `no_bad_debt` | `bad_debt` | 3600.0 | `==` 0.0 |

## State deltas around invariant firings

| Tick | Key | Value |
|-----:|-----|------:|

_Simulation evidence with explicit boundaries._

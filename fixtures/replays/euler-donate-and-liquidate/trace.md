# Technical trace — `replay:euler-donate-and-liquidate`

> Simulation evidence — not audit signoff.

- **Adapter:** `adapter.toml`
- **Kind:** `replay`
- **Total ticks:** 2
- **Event count:** 3
- **Canonical hash:** `03de00e2d2ba97344b1572ae79679d43473a27a136447c6b1a28691eda14a2f8`

## Events of interest

Scope: invariant firings, bridge firings, scheduled actions, oracle writes.

| Tick | Component | Event | Details |
|-----:|-----------|-------|---------|
| 2 | `engine` | `invariant_fired:no_bad_debt` | field=`bad_debt` observed=4720.0 == expected=0.0 |

## Invariant firings — snapshot context

| Tick | Invariant | Field | Observed | Expected (op) |
|-----:|-----------|-------|---------:|---------------|
| 2 | `no_bad_debt` | `bad_debt` | 4720.0 | `==` 0.0 |

## State deltas around invariant firings

| Tick | Key | Value |
|-----:|-----|------:|

_Simulation evidence — not audit signoff._

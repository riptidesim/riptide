# Technical trace — `replay:drift-fake-collateral-vault-drain`

> Simulation evidence — not audit signoff.

- **Adapter:** `fixtures/replays/drift-fake-collateral-vault-drain/adapter.toml`
- **Kind:** `replay`
- **Total ticks:** 2
- **Event count:** 3
- **Canonical hash:** `84c4a8e9a83a79298de3f350535e3cb793b2dac1cc5028481b4f57142d8b9702`

## Events of interest

Scope: invariant firings, bridge firings, scheduled actions, oracle writes.

| Tick | Component | Event | Details |
|-----:|-----------|-------|---------|
| 2 | `engine` | `invariant_fired:collateral_backing` | field=`bad_debt` observed=71500.0 == expected=0.0 |

## Invariant firings — snapshot context

| Tick | Invariant | Field | Observed | Expected (op) |
|-----:|-----------|-------|---------:|---------------|
| 2 | `collateral_backing` | `bad_debt` | 71500.0 | `==` 0.0 |

## State deltas around invariant firings

| Tick | Key | Value |
|-----:|-----|------:|

_Simulation evidence — not audit signoff._

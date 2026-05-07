# Technical trace — `replay:kelpdao-unbacked-rseth`

> Simulation evidence — not audit signoff.

- **Adapter:** `adapter.toml`
- **Kind:** `replay`
- **Total ticks:** 2
- **Event count:** 3
- **Canonical hash:** `ff46b6a1bbcddc4064f1f6eae58c65c291b4856167e800c1c475825c788d0b09`

## Events of interest

Scope: invariant firings, bridge firings, scheduled actions, oracle writes.

| Tick | Component | Event | Details |
|-----:|-----------|-------|---------|
| 1 | `engine` | `expression_invariant_fire:full_backing` | expression invariant `full_backing` fired with severity error |
| 2 | `engine` | `expression_invariant_fire:full_backing` | expression invariant `full_backing` fired with severity error |

## Invariant firings — snapshot context

_no declared invariants fired during this run_

_Simulation evidence — not audit signoff._

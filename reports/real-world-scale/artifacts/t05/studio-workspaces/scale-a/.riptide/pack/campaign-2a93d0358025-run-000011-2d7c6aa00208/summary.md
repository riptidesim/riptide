# Run summary — `bank-run`

> Simulation evidence — not audit signoff.

- **Adapter:** `fixtures/adapters/lending.toml`
- **Scenario:** `simulation-run` · `bank-run` · ticks=20 · agents=10
- **Canonical hash:** `fc55b4ce5cd339992aa22e249b473eeef16a8927983adcdc6a215a7ed3acef9b`
- **Outcome:** 32 invariant firing(s) across 3 declared invariant(s); `ltv_below_max` first fired at tick 5
- **Invariants:** 3 declared · 32 firing(s) — `ltv_below_max`×16 (tick 5), `collection_worst_health_factor`×16 (tick 5)
- **Machine-readable index:** `manifest.json` · trace in `trace.md` · rerun recipe in `rerun.sh`

_Simulation evidence — not audit signoff._

# Run summary — `replay:multi:lst-lending-contagion-proof-upstream`

> Simulation evidence with explicit boundaries.

- **Adapter:** `multi-component replay (liquid_staking × lending)`
- **Scenario:** `replay-multi` · `replay:multi:lst-lending-contagion-proof-upstream` · ticks=4 · agents=16
- **Canonical hash:** `d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb`
- **Outcome:** 3 invariant firing(s) across 3 declared invariant(s); `liquid_staking:no_slash_during_healthy_run` first fired at tick 3 · terminal liquid_staking.pool.cumulative_slashed=4000.0
- **Invariants:** 3 declared · 3 firing(s) — `liquid_staking:no_slash_during_healthy_run`×2 (tick 3), `lending:no_bad_debt`×1 (tick 4)
- **Machine-readable index:** `manifest.json` · trace in `trace.md` · rerun recipe in `rerun.sh`

_Simulation evidence with explicit boundaries._

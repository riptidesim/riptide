# LST → Lending Contagion Proof

First cross-protocol evidence artifact Riptide ships. An upstream
liquid-staking depeg propagates into downstream lending bad debt through
one declared bridge inside a single deterministic replay run against the
shipping `liquid-staking-fork` and `lending_pool` programs loaded into
one shared LiteSVM world.

This is a **replay-scoped multi-program proof**, not a forensic
reproduction of any specific mainnet incident and not a claim about
generalized N-protocol coverage. The proof renders one cross-protocol
contagion path honestly; see [Honest scope](#honest-scope) below.

## Rerun command

From the repo root:

```bash
riptide replay fixtures/replays/lst-lending-contagion-proof/config.json --allow-invariant-violations
```

The command writes the full artifact bundle
(`simulation-result.json` + `report.md`) into
`riptide-output/replays/lst-lending-contagion-proof/` (resolved
relative to the config file's directory, so the default output lands
inside this fixture dir). The
`--allow-invariant-violations` flag keeps the exit code at 0 even
though the contagion proof is *designed* to fire machine-checkable
invariants — the firings are the proof signal. Omit the flag to have
the CLI exit 1 on any firing (useful in CI pipelines that assert "no
contagion expected").

The deterministic engine gate runs via:

```bash
cargo test -p riptide-engine --release --features litesvm-backend \
  --test replay_lst_lending_contagion_proof \
  contagion_proof_matches_expected_summary_and_is_deterministic
```

## Bridge description

The propagation path is a single declared bridge:

```text
liquid_staking.pool.exchange_rate_bps
    └─► bps-ratio transform (base_price=100, denominator=10000)
            └─► lending.collateral_price_feed (oracle price in $)
```

The transform is linear: `price = base_price * (observation / denominator)`.
At the 10000-bps baseline the bridge holds the lending oracle at
**$100**; after the upstream slash drops `pool.exchange_rate_bps` to
6000, the bridge drops the lending oracle to **$60**.

Per-tick ordering inside the coordinator:

1. `liquid_staking` runs its replay tick (oracle-trajectory push +
   declared instructions).
2. The `lst_exchange_rate_to_lending_oracle` bridge reads the
   post-tick `pool.exchange_rate_bps` observation.
3. The derived oracle update lands on the lending component **before**
   its tick runs.
4. `lending` runs its replay tick against the updated oracle.

This ordering makes same-tick contagion deterministic — a reviewer can
trace any downstream outcome back to a specific upstream observation
without reaching into a runtime schedule.

## Component artifact paths

| Component | Adapter | Trajectory dir |
| --- | --- | --- |
| `liquid_staking` | `../liquid-staking-depeg-redemption-run/adapter.toml` (shipping) | `./liquid-staking/` (proof-local) |
| `lending` | `../lending-whale-bad-debt/adapter.toml` (shipping) | `./lending/` (proof-local) |

Both adapters are reused **byte-identically** from the shipping
single-component proofs in `fixtures/replays/`. The proof-local
`liquid-staking/` and `lending/` directories carry only what diverges
— the trajectories and initial-state — so the substrate is
inspectable as "two shipping bundles plus one declared bridge" rather
than a forked wrapper.

The lending component ships **no** `oracle-trajectory.json`. The
bridge is the sole collateral-oracle driver for this component, which
means any change in `lending.oracle_price` across the run is
attributable to the upstream liquid-staking state.

## Executive summary

A 50% delegated-stake slash against the liquid-staking pool at tick 3
drops `pool.exchange_rate_bps` from 10000 to 6000. The bridge
translates this into a 40% downstream collateral price drawdown,
dropping the lending oracle from $100 to $60 before the lending
component's tick runs.

Five whale-concentrated borrow positions that were healthy under the
pre-shock oracle ($100 collateral × 100 units = $10000 vs. $6400
debt, 64% LTV) flip underwater under the bridged oracle
($60 × 100 = $6000 < $6400 debt). The terminal liquidation cascade at
tick 4 fails to cover repay + 5% bonus from the remaining collateral
and realizes **$3600 of pool-level bad debt**.

The `lending:no_bad_debt` invariant fires **once, at tick 4** — after
the bridge has already dropped the oracle at tick 3. The
`liquid_staking:no_slash_during_healthy_run` invariant fires starting
tick 3, recording the upstream half of the contagion trace in the same
`invariants_fired` summary.

## Invariant firings (honest signal)

| Qualified invariant | First firing tick | Count | Role |
| --- | --- | --- | --- |
| `liquid_staking:no_slash_during_healthy_run` | 3 | 2 | Upstream depeg evidence |
| `liquid_staking:no_queue_formation` | — | 0 | Not exercised in this proof |
| `lending:no_bad_debt` | 4 | 1 | **Downstream contagion signal** |

Both firing invariants are declared on the shipping replay-scoped
adapters; Riptide's existing invariant machinery evaluates them against
the qualified snapshot keys (`liquid_staking.pool.cumulative_slashed`,
`lending.pool.bad_debt`) without a contagion-specific evaluator.

## Technical trace

Per-tick progression (from the canonical `simulation-result.json`):

| Tick | `liquid_staking.pool.exchange_rate_bps` | `liquid_staking.pool.cumulative_slashed` | `lending.oracle_price` | `lending.pool.bad_debt` |
| --- | --- | --- | --- | --- |
| 0 | 10000 | 0 | 100.0 | 0 |
| 1 | 10000 | 0 | 100.0 | 0 |
| 2 | 10000 | 0 | 100.0 | 0 |
| 3 | 6000 | 4000 | 60.0 | 0 |
| 4 | 6000 | 4000 | 60.0 | 3600 |

Ticks 0–2 are the quiet pre-shock baseline — no upstream movement, no
bridge-driven oracle movement, no downstream pressure. Tick 3 carries
the full upstream stress (slash) and bridge propagation; tick 4
realizes the downstream consequence.

The event stream carries **one `bridge:lst_exchange_rate_to_lending_oracle`
event per tick** (not just the firing ticks) so reviewers can see the
bridge was evaluated uniformly across the run. Each bridge event
includes `source_component`, `target_component`, `observation`, and
`derived_price` under its `params`.

## Canonical regression hash

The engine-side canonical `SimulationResult` hash is pinned in
`expected-summary.json`:

```text
result_sha256: d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb
```

The hash is computed on the canonicalized result (with
`run_config.output_path` pinned to `__canonical__`) so
working-directory differences don't drift the hash. See the engine
test at `engine/tests/replay_lst_lending_contagion_proof.rs` for the
exact canonicalization.

## Honest scope

**What this proof shows:**

- One declared bridge can propagate upstream liquid-staking state into
  a downstream lending oracle inside a single deterministic replay.
- The downstream bad-debt outcome is attributable to the upstream
  slash — not to a manually duplicated lending oracle trajectory
  (the lending component has no oracle-trajectory.json at all).
- Riptide's existing invariant machinery, snapshot schema, and wire
  contract accommodate multi-program proofs without a parallel
  evaluator stack.

**What this proof does not show:**

- Generalized multi-program persona sweeps (replay only; no
  population-driven scenario engine).
- Real production protocol adapter coverage (this is
  `liquid-staking-fork` + `lending_pool`, not Kamino / Marginfi /
  Marinade / Jito / Sanctum / Kelp).
- Arbitrary cross-program transaction graphs (the bridge is scalar
  observation → scalar oracle write with an explicit transform).
- Stablecoin or governance contagion (backlog).
- Cascade-graph dashboards, Cloud monitoring, or alerting.
- A forensic reproduction of any specific mainnet incident — the
  geometry is tuned so the bridged oracle crosses the lending
  liquidation-threshold boundary cleanly.

Evidence of this kind is **simulation evidence**, not audit signoff.
It belongs in design reviews, stress-testing rounds, and deployment
gates — not in lieu of an audit.

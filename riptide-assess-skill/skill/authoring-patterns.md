# Authoring patterns (guided sim)

The library code to wire while filling the setup seams and authoring the sweep,
once the A–F triggers tell you which patterns the protocol needs.

When triggers fire, the hard-won parts are already library code. Wire these
instead of re-deriving them.

**Oracle-account construction (Trigger B).** Use
`riptide_sim::oracle::PythPriceUpdate` to build the Pyth `PriceUpdateV2` account
a program's `get_price_no_older_than(...)` reads. The builder owns the full
134-byte layout verified against `pyth-solana-receiver-sdk` — never hand-roll
those bytes:

```rust
use riptide_sim::oracle::{crash_in_place, PythPriceUpdate};

let mut update = PythPriceUpdate::new(FEED_ID, INITIAL_PRICE, -8, base_ts);
update.install(&mut sim.world, price_update_key)?;
// Later, mid-lifecycle: the crash (the swept stress), re-stamped fresh so the
// program's freshness window is isolated from the price move.
crash_in_place(&mut sim.world, &price_update_key, crashed_price, now)?;
```

For non-Pyth attestors (custom NAV attestations, Switchboard), follow the same
shape — a deterministic byte builder in your sim's `services/` with a
`set`/`crash` mutator — rather than scattering offsets through flows.

**Third-party-actor dispatch (Trigger C).** Use
`riptide_sim::dispatch::ThirdPartyDispatch` for any instruction where one actor
signs and operates on another actor's position/order. Push accounts in IDL
order; `build()` rejects the three recurring hand-roll bugs (target marked
signer, actor never signing, a stray third signer):

```rust
use riptide_sim::dispatch::ThirdPartyDispatch;

let mut dispatch = ThirdPartyDispatch::new(liquidator, position_owner);
dispatch
    .shared(protocol_state, false)
    .target_account(position_pda, true)   // owner's position; never signs
    .actor_account(liquidator_ata, true)  // receives seized collateral
    .actor_signer(true);                  // the sole signer
let (metas, signer) = dispatch.build_with_signer()?;
```

**The sweep + control + invariant scaffold.** A guided sim destined for a
risk-surface assessment declares these blocks in `.riptide/sim/Riptide.toml`:

```toml
[sim.sweep]                      # the exogenous stress axis
name = "collateral_price_drop_bps"
values = [0, 1000, 2000, 3000, 4000, 5000, 6000]
seeds_per_value = 4

[sim.positive_control]           # the known-correct baseline coordinate
value = 0                        # parameter defaults to the sweep name

[sim.lifecycle]                  # core flows that must execute on-chain
required_flows = ["create_lend_offer", "accept_lend_offer", "liquidate_loan"]

[sim.cartography]                # surface metadata
class = "lending.v1"
risk_objective = "<one-sentence risk objective with scope boundaries>"
```

In `flows.rs`, read the swept coordinate with `world.sweep_value("<axis>")`,
echo it with `world.record_parameter`, record the deciding signal with
`world.record_metric`, and fire the deciding invariant with
`world.record_invariant_fire` when the metric crosses the stated risk line — the
playbook entry names the metric, the trap, and the line. Author negative
controls (a healthy-state action that must reject) with the transaction
builder's `expect_error()`, so a rejection is asserted, not silently tolerated.

For the deep per-archetype worst-case archetypes (worst case to hunt, axis to
sweep, deciding invariant, signal trap, honest framing), see
[worst-case-playbook.md](./worst-case-playbook.md).

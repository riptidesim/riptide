# Firing Check

The agent writes both the simulation and the invariants that judge it, so an
invariant that holds proves nothing on its own: it might be unable to fail.
The Firing Check closes that hole. For each invariant, inject a known
violation and confirm the invariant fires.

## 5. Firing Check

For every invariant, Floor and agent-authored alike. The Floor Invariants are
the ones `riptide sim generate` listed under `data.floor_invariants`; every
one of them is checked, whether or not it is `wired`. An unwired Floor
Invariant needs the `[semantics]` class named in
[family-library.md](./family-library.md) before it can fire; wire it once as a
repair, and report it as a Gap if it still cannot be.

1. Pick the injected violation that the invariant exists to catch:
   - a solvency or bad-debt invariant: zero a borrower's collateral, or
     perturb the oracle price past the liquidation line;
   - a conservation invariant: skip one transfer inside a flow;
   - a price or peg invariant: perturb the oracle price outside the band.
2. Declare it in `.riptide/sim/src/violations.rs`, one `FiringCheck` per
   invariant. `riptide sim generate` scaffolds one that zeroes the first field
   the invariant reads; replace it with the violation from step 1:
   `Violation::zero_field(account, offset, width)`,
   `Violation::perturb_pyth_price(oracle, drop_bps)`,
   `Violation::skip_transfer(source, destination, amount)`, or
   `Violation::custom(description, |world| ...)` for anything else.
3. Run every check on one fixed seed:

   ```bash
   riptide sim run .riptide/sim --firing-check --flows 20 --seed 1337 --json
   ```

   `data.invariants` carries each invariant's `result` (`fired` or
   `did-not-fire`), the violation it injected and, when the Engine can tell,
   a `detail` saying why it did not fire. A run that cannot reach the
   injection is `sim_firing_check_failed`: repair the flow first.
4. Record the result per invariant in the Assessment Context's
   `invariants` list: its `id`, its `provenance` (`floor` for a Floor
   Invariant, `agent` for one you added), its `firing_check` (`fired`,
   `did-not-fire` or `not-run`) and, after the sweep, its `outcome`.

Outcomes:

- `fired` — the invariant can fail. Its sweep result counts: outcome `held`
  when it never fired across the region, `breached` when it did.
- `did-not-fire` — the invariant is wired to the wrong account, reads a
  metric the flows never record, or its threshold cannot be reached. Repair
  it once (see [repair.md](./repair.md)) and check again. If it still does
  not fire, downgrade it: outcome `gap`, and a Gap whose `subject` is the
  invariant's ID, whose reason is the Firing Check's `detail`, and whose
  unblock is the wiring that would let it fire.
- `not-run` — the Firing Check could not run within the repair budget (the
  sim never reaches the injection). It is reported as a Gap whose unblock is
  the repair that lets one seed reach the end of its run. Its outcome is `gap`.

An invariant that has not passed its Firing Check never counts as held, and no
sentence of the Assessment may describe it as holding. `riptide validate`
enforces it: an invariant reported as `held` or `breached` without a `fired`
Firing Check fails the gate (`validate_invariant_not_fired`), and so does a
Floor Invariant missing from the list (`validate_floor_invariant_missing`).
Never drop a Floor Invariant that did not fire; report it as a Gap.

Never weaken an invariant, or tighten its threshold, to make the Firing Check
pass: the threshold is the stated risk line (see [honesty.md](./honesty.md)).

Next: [repair.md](./repair.md) for any failure so far, otherwise
[run-and-surface.md](./run-and-surface.md) (Surface).

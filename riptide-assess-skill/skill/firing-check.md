# Firing Check

The agent writes both the simulation and the invariants that judge it, so an
invariant that holds proves nothing on its own: it might be unable to fail.
The Firing Check closes that hole. For each invariant, inject a known
violation and confirm the invariant fires.

## 5. Firing Check

For every invariant, Floor and agent-authored alike:

1. Pick the injected violation that the invariant exists to catch:
   - a solvency or bad-debt invariant: zero a borrower's collateral, or
     perturb the oracle price past the liquidation line;
   - a conservation invariant: skip one transfer inside a flow;
   - a price or peg invariant: perturb the oracle price outside the band.
2. Run it on one fixed seed through a Firing Check mode on `riptide sim run`,
   if `riptide sim run --help` lists one. The Engine may not offer it yet; in
   that case do not hand-roll an injection, and record the result as `not-run`.
3. Record the result per invariant: `fired`, `did-not-fire` or `not-run`.

Outcomes:

- `fired` — the invariant can fail. Its sweep result counts: `held` when it
  never fired across the region, `breached` when it did.
- `did-not-fire` — the invariant is wired to the wrong account, reads a
  metric the flows never record, or its threshold cannot be reached. Repair
  it once (see [repair.md](./repair.md)) and check again. If it still does
  not fire, it is reported as a Gap.
- `not-run` — the Engine has no Firing Check mode, or could not apply the
  violation. It is reported as a Gap whose unblock is an Engine Firing Check
  for that invariant.

An invariant that has not passed its Firing Check never counts as held, and no
sentence of the Assessment may describe it as holding. Record each result in
the Assessment Context next to the invariant's provenance.

Never weaken an invariant, or tighten its threshold, to make the Firing Check
pass: the threshold is the stated risk line (see [honesty.md](./honesty.md)).

Next: [repair.md](./repair.md) for any failure so far, otherwise
[run-and-surface.md](./run-and-surface.md) (Surface).

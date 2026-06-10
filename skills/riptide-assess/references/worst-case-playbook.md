# Worst-Case Playbook

Per-archetype authoring guidance for guided-sim assessments. The riptide-assess
skill loads this file when the execution-path classification returns
`guided-sim-required`: the archetype from the classification note selects an
entry, and the entry tells the authoring pass what worst case to hunt before
any code is written.

Every entry uses the same fields:

- **Worst case to hunt** — the economically real failure this archetype is
  exposed to, stated as a concrete scenario against the target program, not a
  generic category.
- **Swept axis** — the exogenous stress parameter to sweep (declared as
  `[sim.sweep]` in `.riptide/sim/Riptide.toml`) and the range that brackets
  the interesting region.
- **Deciding invariant / metric** — the invariant or metric whose movement
  decides the verdict, with the severity that makes the failure gradient
  visible on the risk surface.
- **Signal trap** — where a naive measurement reads flat while the real
  signal moves; name the field to measure instead.
- **Honest framing** — how to state the result: inherent risk versus bug,
  the swept axis as exogenous stress rather than a protocol knob, and the
  reminder that a held invariant across the full sweep is a robustness
  result, not a failed assessment.

An entry that has not been written yet is marked *(entry not yet written)*.
For those archetypes, derive the worst case from the protocol-archetype
defaults table in `SKILL.md` plus the target program's actual P0 flows, and
keep the five fields above as the working structure.

## irs (interest-rate swap)

*(entry not yet written)*

- **Worst case to hunt:** —
- **Swept axis:** —
- **Deciding invariant / metric:** —
- **Signal trap:** —
- **Honest framing:** —

## lending

*(entry not yet written)*

- **Worst case to hunt:** —
- **Swept axis:** —
- **Deciding invariant / metric:** —
- **Signal trap:** —
- **Honest framing:** —

## nav-vault

*(entry not yet written)*

- **Worst case to hunt:** —
- **Swept axis:** —
- **Deciding invariant / metric:** —
- **Signal trap:** —
- **Honest framing:** —

## amm

*(entry not yet written — AMMs usually classify as `generic-path-fittable`;
use the `amm` row of the defaults table.)*

## perps

*(entry not yet written — use the `perps` row of the defaults table as
what-to-test guidance.)*

## lst

*(entry not yet written — use the `lst` row of the defaults table as
what-to-test guidance.)*

## stablecoin

*(entry not yet written — use the `stablecoin` row of the defaults table as
what-to-test guidance.)*

## orderbook

*(entry not yet written — keeper settlement and matching choreography
classify as guided-sim; derive the worst case from the target program's
match/settle flows.)*

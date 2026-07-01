# References & file index

Where the deeper material lives, and the public source of record for the full
configuration contract.

## References

- Riptide (public repo + full configuration contract):
  `https://github.com/riptidesim/riptide`
- Issues: `https://github.com/riptidesim/riptide/issues`
- Per-archetype worst-case authoring: [worst-case-playbook.md](./worst-case-playbook.md)
- Assessment-input shape: [`../examples/assessment-input.json`](../examples/assessment-input.json)

## Skill file index

- [SKILL.md](./SKILL.md) — the router: mission, prerequisites/auto-install, the
  CLI surface, and the flow.
- [detect-and-scope.md](./detect-and-scope.md) — step 1 (Detect the protocol
  family) + step 2 (Scope with the full A–F trigger taxonomy and the three
  scoped questions).
- [family-library.md](./family-library.md) — per-family starting menu of
  personas (→ `[personas]`), invariants (→ `[[invariants]]`), and stress
  scenarios (→ `[sim.sweep]`); consulted during Scope before campaign design.
- [setup.md](./setup.md) — step 3: author the adapter, generate the sim crate,
  fill the `TODO(setup)` seams with deterministic facts, declare external
  programs/accounts/forks.
- [run-and-assess.md](./run-and-assess.md) — steps 4–6: run (smoke → full
  sweep), surface the cartography root, and render the assessment with the brief.
- [authoring-patterns.md](./authoring-patterns.md) — the library code to wire
  when triggers fire: oracle-account construction, third-party dispatch, the
  sweep + control + invariant scaffold.
- [honesty.md](./honesty.md) — the 7 honesty rules, the three runtime-enforced
  execution-honesty gates, and fail-fast/file-an-issue guidance.
- [worst-case-playbook.md](./worst-case-playbook.md) — per-archetype worst case
  to hunt, axis to sweep, deciding invariant/metric, signal trap, honest framing.

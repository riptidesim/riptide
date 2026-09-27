# Reusing a Workspace

When `/riptide-assess` runs in a repo whose `.riptide/` Workspace already
holds an Assessment, the run is a rerun. The agent's earlier authoring work is
kept, the region the previous Assessment declared runs again with the same
seeds, and the new Assessment carries a **Delta** against the previous one.
Nothing in a rerun needs the user.

## Find the previous Assessment

Assessments live side by side in `.riptide/assessments/`, each under its own
zero-padded name in the order they were written: `001`, `002`, `003`. The
previous Assessment is the highest-numbered directory that holds an
`assessment-context.json`. Read its `assessment-context.json` (Depth, family,
Coverage, Gaps, invariants) and the `coverage_statement.probed` block of its
`assessment.json` (swept axes, values, seed policy, run budget): together
they are the region to rerun.

The new Assessment renders into the next name. An Assessment already written
is never overwritten: `riptide assess --out` into a directory that holds an
`assessment-context.json` fails with `assess_out_holds_assessment`, and one
whose name sorts before an existing Assessment fails with
`assess_out_not_latest`.

## The rerun, stage by stage

The stages are the same as a first run (see [SKILL.md](./SKILL.md)); each one
starts from what the Workspace already holds.

1. **Classify and Scope.** Keep the previous family, target and Depth unless
   the Steering Hint overrides them. Carry the previous Scope Declaration
   forward and add an assumption for anything that changed.
2. **Refresh.** Regenerate the builders from the current IDL without
   touching authored flows, then rebuild:

   ```bash
   riptide sim refresh --adapter .riptide/adapters/<program>.toml --dir .riptide/sim --json
   riptide sim lint .riptide/sim --json
   riptide sim run .riptide/sim --iterations 5 --flows 20 --seed 1337 --out .riptide/sim/artifacts/smoke --json
   ```

3. **Repair broken flows.** A flow that no longer compiles or no longer
   lands against the changed program is repaired in place (see
   [repair.md](./repair.md)), not rewritten from scratch. Keep the authored
   adapter, personas, invariants and sweep (see
   [setup.md](./setup.md#reusing-an-existing-workspace)).
4. **Author flows only for new instructions.** Compare the IDL's
   instructions with the previous Coverage (`exercised` and
   `not_exercised`). Only an instruction in neither list is new; author a
   flow for it, or record it as a Gap with its reason and unblock. A Gap the
   previous Assessment recorded is retried with its unblock when the change
   makes that possible.
5. **Rerun the same region.** Leave `[sim.sweep]` (`name`, `values`,
   `seeds_per_value`) as it was, rerun the Firing Check for every invariant,
   then run the full sweep with the same `riptide sim run` options the
   previous Assessment ran (its `--flows` and any `--seed`) and surface it.
   `riptide delta` checks the Depth, swept axes, bins, seed policy and run
   budget (a correctness Assessment's iteration count); keeping `--flows`
   the same is the Skill's job. A changed region is a new region: it gets no
   Delta, and the Scope Declaration records the change and why.
6. **Report into the next name.** Render the Engine Output into the next
   Assessment directory, write its Assessment Context, then compute the
   Delta:

   ```bash
   riptide assess <guided-sim-root> --json --brief --input .riptide/assessment-input.json --out .riptide/assessments/002
   riptide delta .riptide/assessments/001 .riptide/assessments/002 --json
   ```

## The Delta

The Delta is computed by the Engine, never by the agent. Copy `data.delta`
from `riptide delta` into the new Assessment Context as `"delta"`, verbatim:

- `previous` — the previous Assessment's name (`001`).
- `metric_moves` — every Engine Output figure and invariant outcome that
  moved, each with its `previous` and `current` value.
- `gaps_opened` and `gaps_closed` — Gaps by subject.
- `new_instructions` — instructions the previous Assessment did not know,
  each with whether this run `exercised` it.

`riptide delta` fails with `delta_region_mismatch` when the two Assessments
ran different regions; follow its `next` and rerun the previous region, or
deliver the new Assessment as the first of a new region, with no Delta.

The Delta section is required on reruns: when an earlier Assessment in
`.riptide/assessments/` ran the same region, `riptide validate` rejects an
Assessment Context with no Delta (`validate_delta_missing`), a Delta against
any Assessment but the latest such one (`validate_delta_previous_mismatch`),
and a Delta that differs from the Engine's (`validate_delta_mismatch`). The
composed `assessment.md` carries `## Delta` after `## Invariants` and any
`## Breaches`, before `## Engine Output`, naming the previous Assessment and
summarising the moved metrics, the Gaps opened and closed, and the Coverage of
new instructions (see [report.md](./report.md)).

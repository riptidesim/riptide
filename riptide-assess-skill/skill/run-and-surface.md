# Run & Surface

Run validates the sim crate, proves it with a one-seed smoke, then runs the
full sweep. Surface turns the sweep into the cartography root the Engine reads
when it renders its output.

## 4. Run

Validate, then smoke before the full sweep:

```bash
riptide sim lint .riptide/sim --json
riptide sim run .riptide/sim --iterations 5 --flows 20 --seed 1337 --out .riptide/sim/artifacts/smoke --json
riptide sim review .riptide/sim/artifacts/smoke --json
```

The review reads `guided-sim-run.json`, validates `rerun.sh` when present, and
reports the retained failing seed, flow table, labelled transaction outcomes,
failure reason and rerun command. It does not run the sim again.

Do not run the full sweep until the one-seed smoke passes. A smoke that fails
on setup goes to [repair.md](./repair.md); an invariant that fires in the
smoke is evidence and carries on.

`riptide sim run` reads `[sim.sweep]` and runs one iteration per (value, seed
replicate). Verified options: `--iterations <n>`, `--flows <n>`,
`--seed <hex>`, `--out <dir>`. Once the smoke passes, run the full sweep:

```bash
riptide sim run .riptide/sim --flows 20 --out .riptide/sim/artifacts/<run> --json
```

Record every instruction and actor that executed at least once; that record is
the Coverage the Assessment is graded by. An instruction that never executed
successfully is a Gap, with the reason from the review output.

Next: [firing-check.md](./firing-check.md).

## 7. Surface

Build the cartography root:

```bash
riptide sim surface .riptide/sim/artifacts/<run> --sim .riptide/sim --json
```

This writes `campaign-summary.json`, `risk-surface.json` and
`retention-manifest.json`, and records the execution-honesty gate report (see
[honesty.md](./honesty.md)). Note the root path in `data.out_dir`; Report reads it.

The root's `coverage_statement` block is the run's Region Coverage: the swept
axes, bins and hot or no-signal cells. It says nothing about which
instructions ran, so never cite it as Coverage.

Next: [report.md](./report.md).

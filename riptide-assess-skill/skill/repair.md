# Repair

Every failure between Setup and Report comes here. Classify it, repair the
responsible layer yourself, and rerun from the earliest affected stage. Never
hand a failure back to the user, and never substitute a hand-written report
for a blocked Engine gate.

## 6. Repair

Invariant failures are evidence, not setup failures: the artifacts are still
reviewable, the run carries on, and each one becomes a Breach in the report.
Only setup failures are repaired.

Start from the failing command's `--json` error: `error.code` says what broke
(`sim_build_failed`, `sim_lint_failed`, `sim_setup_gaps`, ...) and
`error.next` names the repair. A build failure carries the compiler output in
`data.diagnostics`; a failing iteration carries its seed in
`data.failing_seed`.

Do not stop at "lint PASS" if `riptide sim run` cannot execute the generated
crate against the adapter. Lint passing is a gate, not the goal.

### Failure classes

Classify each failure as exactly one of:

- `skill prompt gap` — the authored adapter, setup or flow omitted a fact
  already visible in source or tests. Repair it from that fact.
- `CLI validation gap` — `riptide doctor` or `riptide sim lint` passed, but a
  later loader error was statically knowable. Repair the adapter and record
  the gap in the Assessment Context.
- `setup source fact gap` — setup needs account bytes, owners, PDA seeds, feed
  IDs or serialization facts that local source, tests, IDL and dependencies do
  not carry. Record `blocked = missing deterministic <fact> for guided-sim setup`
  and report the dependent surface as a Gap.
- `setup API/tooling gap` — setup code cannot express the required bytes,
  account binding, sibling program or build behavior. Report the dependent
  surface as a Gap and file the Engine limitation (see below).
- `guided-sim required` — a flow needs dynamic `remaining_accounts`,
  multi-instruction transactions, target-vs-agent dispatch or project-local
  service models. Write the flow in `.riptide/sim/src/flows.rs`.
- `guided-sim evidence ready` — `riptide sim lint`, `riptide sim run --out`
  and `riptide sim review` all pass. Record the artifact directory, retained
  seed status, flow labels, transaction labels and rerun command. Keep coverage marked unavailable when
  `sim.coverage.enabled = true` fails lint; do not describe guided-sim
  coverage as emitted until the runner has a coverage collector.
- `unsupported protocol surface` — the surface needs Engine support that does
  not exist (FHE/MPC/ZK, external-venue execution, off-chain matching). It is
  a Gap.
- `case-study source/build issue` — missing `.so`, unreadable IDL, failing
  program build, or inconsistent source/test fixtures. Rebuild or repair from
  the repo's own build; if the program cannot be built, it is a Blocker
  Report.

### Where to restart

- After an adapter change: from `riptide doctor --json`.
- After a setup or flow change: from the crate build and the one-seed smoke.
- After a sweep change: from the one-seed smoke.
- After an invariant change: from its Firing Check.

A blocked `riptide assess` that names a failed execution-honesty gate is a
setup repair: fix the positive control, make the required lifecycle flows
execute, or restore determinism, then rerun `sim run`, `sim surface` and
`assess`.

### Budget

Each failure gets the repair attempts the Depth allows (see
[SKILL.md](./SKILL.md)). When the budget runs out, stop repairing that
surface: it becomes a Gap naming the failure class, the exact failed command,
the error summary, what was repaired and the smallest missing fact. The rest
of the run continues.

### Readiness

Before Surface, the run is in exactly one state:

- `campaign_ready = yes` — the adapter validates, the crate builds, the
  one-seed smoke passes, the declared flows and sweep run.
- `bounded_ready = yes` — a narrower sim runs and validates, but named Gaps
  keep part of the intended surface outside it.
- `blocked = <reason>` — nothing ran. Deliver a Blocker Report.
- `unsupported = <boundary>` — the whole target needs Engine support that
  does not exist. Deliver a Blocker Report.

## Engine limitations

When a blocker is in the Engine itself (a CLI validation gap, a missing
builder, a runtime limitation), report it with the exact failed command, the
error summary, what was repaired and the smallest missing fact, and link an
issue at `https://github.com/riptidesim/riptide/issues`.

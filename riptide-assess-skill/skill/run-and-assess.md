# Run, Surface & Assess

The final three steps of the flow: validate and smoke the sim, run the full
sweep, build the cartography root the assessment reads, then render the
assessment with the brief.

## 4. Run

Validate, then smoke before the full sweep:

```bash
riptide sim lint .riptide/sim
riptide sim run .riptide/sim --iterations 5 --flows 20 --seed 1337 --out .riptide/sim/artifacts/smoke
riptide sim review .riptide/sim/artifacts/smoke
```

`riptide sim run` reads `[sim.sweep]` and runs one iteration per
(value, seed replicate). Verified options: `--iterations <n>`, `--flows <n>`,
`--seed <hex>`, `--out <dir>`. Do not run the full sweep until the one-seed smoke
passes.

Classify failures: **setup errors** are repair-loop inputs — return to the
responsible layer (adapter / setup seam / flow), fix it, and rerun from the
earliest affected gate. **Invariant failures are evidence, not setup failure** —
the artifacts are still reviewable; continue. If a flow needs Rust the crate does
not yet author, write it in `.riptide/sim/src/flows.rs` and keep coverage
bounded.

Once the smoke passes, run the full sweep:

```bash
riptide sim run .riptide/sim --flows 20 --out .riptide/sim/artifacts/<run>
```

## 5. Surface

Build the cartography root the assessment reads:

```bash
riptide sim surface .riptide/sim/artifacts/<run> --sim .riptide/sim
```

This writes the cartography root — `campaign-summary.json` +
`risk-surface.json` + `retention-manifest.json` — and records the
execution-honesty gate report. Note the root path it prints.

## 6. Assess

Author a repo-local `.riptide/assessment-input.json` (an `AssessmentInputs`
object) before the final render — it turns the generic templated defaults into
an assessment that names the protocol's actual flows, figures, and boundaries.
Skipping it ships the generic layer. Cover at minimum `verdict`,
`riskPlan.target_claim`, `riskPlan.guided_sim_boundaries`, and explicit
`coverage[]` rows (one per P0 flow: `priority`, `flow`, `status`,
`evidence_tier`, `commands`, `artifacts`, `notes`). Use an accepted `status`
(`covered`, `covered by guided sim`, `blocked`, `out of scope`, `not assessed`).
Every line must be backed by what actually ran — it adds protocol nouns and
figures, never new findings. See [`../examples/assessment-input.json`](../examples/assessment-input.json)
for the shape.

Review the surfaced root, then generate the assessment with the brief — this is
the standard invocation, not an on-request variant:

```bash
riptide review .riptide/sim/artifacts/<run>/<surfaced-root>
riptide assess <guided-sim-root> --brief --input .riptide/assessment-input.json
```

`riptide assess` is ingest-only: it reads the surfaced root, re-verifies the
execution-honesty gates, and emits `assessment.json` + byte-deterministic
`assessment.md` (plus `brief.html` / `brief.pdf` with `--brief`). It **blocks**
on any failed gate. Use `--html` / `--pdf` only when the user asks for
presentation exports. A blocked assess that names a failed gate is a setup
repair (fix the positive control / make required lifecycle flows execute /
restore determinism, then re-run `sim run` + `sim surface` + `assess`) — never
a hand-written report.

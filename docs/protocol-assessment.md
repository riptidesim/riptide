# Protocol assessment workflow

Use this workflow when you want to turn Riptide runs into a protocol-team
handoff. The output is a coverage matrix and a report that says what the
simulator exercised, what it found, what it did not find, and what remains
blocked.

The claim boundary is explicit: this is simulation evidence, not audit
signoff. A ready report does not certify the protocol, prove complete
protocol safety, or replace manual review, formal methods, monitoring, or an
independent audit.

## Two assessment shapes

Not every protocol yields a risk-surface heatmap, and the assessment should
not pretend otherwise. The shape follows the kind of risk the protocol
carries:

- **Cartography (parameter-tunable protocols — lending, AMM, perps).** Risk is
  a gradient over swept parameters: as inputs move, a declared invariant's
  failure rate rises or falls. The assessment leads with a risk-surface
  heatmap (the swept cells and their failure rates) plus the safe-region
  bounds, backed by a guided-sim parameter sweep processed by
  `riptide sim surface`.
- **Correctness (correctness-dominated protocols — accounting, payments,
  authority).** Risk is binary: accounting drift, double-payment,
  wrong-recipient settlement, or unauthorized control either happens or it
  does not. A parameter sweep would not produce a meaningful failure surface,
  so the assessment leads with the coverage matrix and findings/non-findings,
  with the evidence coming from guided-sim happy-path settlement plus
  negative-control rejections. The risk-surface section degrades to an
  explicit, bounded note rather than a forced or all-zero heatmap.

`riptide assess` produces both shapes from an existing guided-sim root and
picks the shape from the evidence present (see [Generating the report](#generating-the-report)).
A correctness-shape assessment is no weaker than a cartography one — it is the
honest form for a protocol whose risk is not a parameter gradient.

## Assessment route

Move through the assessment in this order.

1. **Write the Risk Plan.** Name the protocol class, P0 and P1 economic flows,
   expected failure modes, evidence profile, guided-sim sweep shape, guided-sim
   boundaries, invariants, and known coverage limits. The Risk Plan is a short
   declaration — target claim, the inputs you will sweep or exercise, the
   invariants that decide pass/fail, and the limits you already know — so the
   coverage matrix and report stay bound to it. See [Guided sim](guided-sim.md)
   for the guided-sim model behind it.
2. **Check harness readiness.** Confirm that the adapter, setup harness,
   scenarios, account fixtures, program binaries, IDL, personas, invariants,
   and guided-sim commands can run from the repo. If a flow needs dynamic
   `remaining_accounts`, multi-instruction transactions, or project-owned
   services, make sure the guided sim models them rather than assuming an
   adapter-only path can express them.
3. **Run a calibration slice.** Execute the smallest meaningful run that
   proves the harness boots and the declared invariant can observe the target
   state. Calibration is useful setup evidence, but it does not cover an
   economic flow by itself.
4. **Run a baseline guided-sim sweep.** For each critical economic objective —
   deposit pressure, redemption pressure, oracle lag, liquidation stress, or
   reserve imbalance — run a guided-sim parameter sweep
   (`riptide sim run .riptide/sim --flows <N> --out <dir>`), then build the
   cartography artifacts with
   `riptide sim surface <run-path> --sim .riptide/sim`. That writes
   `risk-surface.json`, `campaign-summary.json`, and `retention-manifest.json`.
   Retain the run paths, commands, sampled parameters, and summary.
5. **Run an adversarial/stress guided-sim sweep.** Add stress ranges, hostile
   personas, boundary values, or failure-mode parameters that could falsify the
   Risk Plan's target claim, then surface that run the same way. This is still
   scoped to declared inputs and invariants.
6. **Run single-flow guided sims when needed.** Use a focused guided sim for a
   correctness flow or any path that needs project-owned Rust logic, dynamic
   account lists, dependency services, or multi-instruction transactions but is
   not a parameter gradient. Keep single-flow guided-sim evidence distinct from
   the swept cartography evidence in the report.
7. **Run negative controls.** Include at least one control that demonstrates
   the invariant or test can fail when the relevant assumption is broken.
   Negative controls help reviewers trust that a green result is not caused by
   a disconnected metric, dead invariant, or unreachable scenario branch.
8. **Build the coverage matrix.** Classify every P0 and P1 flow as `covered`,
   `covered by guided sim`, `blocked`, `out of scope`, or `not assessed`.
   Link each covered row to commands, hashes, artifacts, and the evidence tier
   that supports it.
9. **Write the final report.** Use a report that separates findings from
   non-findings, states blocked and out-of-scope surfaces, includes
   reproduction commands, and recommends the next review work.

## Evidence tiers

Use these tiers consistently in the coverage matrix and report.

| Tier | Meaning | Typical evidence |
| --- | --- | --- |
| Calibration | The harness boots and the target metric or invariant is observable. | One small run, smoke scenario, or generated guided-sim crate that reaches the target state. |
| Baseline guided-sim sweep | A declared economic objective ran as a guided-sim parameter sweep and was surfaced by `riptide sim surface` under declared inputs. | `risk-surface.json`, `campaign-summary.json`, sampled cells, rerun command, review output, and run hash. |
| Adversarial/stress guided-sim sweep | A guided-sim sweep intentionally stressed a failure mode from the Risk Plan. | Stress ranges, hostile personas, sampled cells, retained failures or no-failure summaries, and review output. |
| Guided sim | A project-owned Rust simulation exercised a flow that adapter campaigns cannot express. | `riptide sim run` artifact, `guided-sim-run.json`, `rerun.sh`, review output, and selected account hashes when configured. |
| Negative control | A control run showed that the invariant or metric fails when the relevant assumption is violated. | Expected-error run, intentionally broken fixture, failing scenario, or guided-sim assertion. |
| Blocked | The flow could not be assessed with current inputs, harness support, dependency state, or tooling. | Exact blocker, missing artifact, failed command, or required protocol input. |
| Out of scope | The assessment intentionally excludes the flow. | Scope rationale and owner for the next review path. |

## P0 and P1 coverage expectations

Use P0 for flows where a bad result can directly move user funds, protocol
solvency, authority control, accounting integrity, liquidation safety, or
redemption correctness. Use P1 for important economic paths that can compound
risk, degrade liquidity, create misleading accounting, or block operations but
are not the central loss path for this assessment.

For P0 flows:

- Every P0 row must appear in the coverage matrix.
- Each P0 row must be `covered`, `covered by guided sim`, `blocked`, `out of
  scope`, or `not assessed`.
- At least one P0 flow must reach baseline guided-sim sweep, adversarial/stress
  guided-sim sweep, or single-flow guided sim evidence before the assessment can
  be ready to send.
- A P0 row marked `covered` or `covered by guided sim` must include exact
  commands, artifact paths, hashes when emitted, and the invariant or metric
  that backs the row.
- A P0 row marked `blocked`, `out of scope`, or `not assessed` must explain
  why and name the smallest next step that would make it reviewable.

For P1 flows:

- Every P1 row named in the Risk Plan must appear in the coverage matrix.
- P1 coverage can be calibration-only only when the report labels it that way
  and does not treat it as a non-finding.
- A report with many P1 rows blocked or not assessed can still be sendable
  when the P0 claim is narrow and the report makes those limits obvious.

## Minimum ready-to-send threshold

A protocol assessment is ready to send when it meets all of these conditions:

- The Risk Plan names the protocol class, target claim, P0/P1 flows, expected
  failure modes, and known coverage limits.
- The harness readiness check is complete, or each harness gap is listed as
  `blocked`, `out of scope`, or `not assessed`.
- The coverage matrix classifies every P0 flow.
- At least one P0 flow has baseline guided-sim sweep, adversarial/stress
  guided-sim sweep, or single-flow guided sim evidence that a reviewer can rerun
  from exact commands.
- Every headline claim points to an artifact path, command, hash when present,
  and invariant or metric.
- Findings and non-findings are separate. A no-failure result is phrased as
  "no declared invariant fired under these inputs," not "safe."
- Negative controls are present for the headline invariant or the report says
  why they are blocked.
- Blocked, out-of-scope, and not-assessed surfaces are visible in the
  executive summary or scope.
- The report states that the result is simulation evidence, not audit signoff
  or complete protocol safety.

Ready to send is scoped to the report's headline claim. A focused handoff can
be ready to send for one P0 flow, such as deposit or delegated-deposit
accounting, when that flow has reviewable evidence and the rest of the
protocol surface is marked `blocked`, `out of scope`, or `not assessed`. Do not
describe that as a full protocol assessment.

Use `ready_to_send` when all of those conditions are met. If they are not met,
use one of these verdicts:

- `needs_guided_sim` when a P0 flow needs a project-owned single-flow guided sim
  that the current evidence does not provide.
- `needs_campaign_tuning` when the harness runs but the guided-sim sweep does
  not yet cover the target flow or stress range.
- `blocked` when missing inputs, dependencies, build artifacts, private
  protocol context, or tool support prevent assessment.
- `unsupported` when the requested claim is outside Riptide's simulation
  evidence model.

## Claim language

Use narrow claims that bind the result to the Risk Plan, inputs, commands,
artifacts, and invariants.

Safe claim examples:

- "Riptide reproduced a deposit-pressure guided-sim sweep for the declared
  adapter, scenario family, seed policy, and invariants. No declared invariant
  fired in the retained runs listed below."
- "The delegated-deposit P0 flow is covered by guided sim evidence for the
  commands and artifacts in this report. Authority rotation is not assessed."
- "This finding is reproducible with the retained guided-sim sweep run and run
  hash listed below."
- "The oracle-lag path is blocked because the protocol-owned oracle account
  layout is not available in the harness."

Treat the following as unsafe claim examples:

- "Riptide proves the protocol is safe."
- "This is an audit replacement."
- "No vulnerabilities exist in the protocol."
- "The protocol is certified because the guided-sim sweep passed."
- "The guided sim covers all possible authority, oracle, and liquidity paths."

When a report is ready to send, the claim should sound like a reviewable lab
result. It should not sound like certification, audit signoff, or a complete
statement about production behavior.

## Final report contents

Use `docs/templates/protocol-assessment-report.md` as the starting point for a
protocol handoff. The report must include:

- executive summary and send/readiness verdict;
- scope and explicit non-scope;
- Risk Plan summary;
- coverage matrix for P0 and P1 flows;
- simulations run, commands, hashes, and artifacts;
- findings and non-findings in separate sections;
- blocked and out-of-scope surfaces;
- reproduction commands;
- recommended next work; and
- reviewer checklist for hashes, commands, artifacts, and toolchain notes.

## Generating the report

Once a run root exists, do not hand-write the coverage matrix and verdict.
Generate the report:

```bash
riptide assess <guided-sim-root>
```

`riptide assess` is ingest-only: it reads an existing guided-sim root and writes
`assessment.json` plus a byte-deterministic `assessment.md` into it (add
`--html`/`--pdf` for presentation exports, which are out of the byte-hash
gate). It does not run any simulation — run the guided-sim sweep or guided sim
first, then assess its root. Two runs over the same root produce byte-identical
`assessment.json` + `assessment.md`, so a reviewer can reproduce the exact
bytes.

It selects the assessment shape from the evidence in the root
(see [Two assessment shapes](#two-assessment-shapes)):

- a root with `campaign-summary.json` + `risk-surface.json` (written by
  `riptide sim surface` from a guided-sim sweep) produces the **cartography**
  assessment, led by the risk-surface heatmap;
- a root with single-flow guided-sim evidence
  (`sim/artifacts/<run>/guided-sim-run.json`) and a run-collection but no
  `risk-surface.json` produces the **correctness** assessment, led by the
  coverage matrix + findings/non-findings, with the risk-surface section
  rendered as an explicit bounded note instead of a heatmap.

Pass `--input <json-file>` to fold a Risk Plan, coverage rows, verdict, and
protocol identity over the derived defaults, or `--verdict` to assert one
explicitly. Whichever shape is produced, the generated report keeps the same
claim boundary: simulation evidence over the assessed region or flows, not
audit signoff or complete protocol safety.

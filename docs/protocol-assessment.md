# Protocol assessment workflow

Use this workflow when you want to turn Riptide runs into a protocol-team
handoff. The output is a coverage matrix and a report that says what the
simulator exercised, what it found, what it did not find, and what remains
blocked.

The claim boundary is explicit: this is simulation evidence, not audit
signoff. A ready report does not certify the protocol, prove complete
protocol safety, or replace manual review, formal methods, monitoring, or an
independent audit.

## Assessment route

Move through the assessment in this order.

1. **Write the Risk Plan.** Name the protocol class, P0 and P1 economic flows,
   expected failure modes, evidence profile, campaign shape, guided-sim
   boundaries, invariants, and known coverage limits. Reuse the Risk Plan
   mental model in [Campaign Runner](campaigns.md) instead of inventing a new
   hierarchy.
2. **Check harness readiness.** Confirm that the adapter, setup harness,
   scenarios, account fixtures, program binaries, IDL, personas, invariants,
   and replay or campaign commands can run from the repo. If a flow needs
   dynamic `remaining_accounts`, multi-instruction transactions, or
   project-owned services, route that flow to a guided sim instead of forcing
   it through Campaign Runner.
3. **Run a calibration slice.** Execute the smallest meaningful run that
   proves the harness boots and the declared invariant can observe the target
   state. Calibration is useful setup evidence, but it does not cover an
   economic flow by itself.
4. **Run focused campaign evidence.** Use a focused campaign for each critical
   economic objective that Campaign Runner can express, such as deposit
   pressure, redemption pressure, oracle lag, liquidation stress, or reserve
   imbalance. Retain the case paths, commands, sampled parameters, summary,
   and canonical hashes.
5. **Run adversarial campaign evidence.** Add stress ranges, hostile personas,
   boundary values, or failure-mode scenarios that could falsify the Risk
   Plan's target claim. This is still scoped to declared inputs and
   invariants.
6. **Run guided sims when needed.** Use guided simulations for flows that need
   project-owned Rust logic, dynamic account lists, dependency services,
   multi-instruction transactions, or richer setup than adapter campaigns can
   express. Keep guided sim evidence separate from campaign evidence in the
   report.
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
| Focused campaign | A declared economic objective ran through Campaign Runner under fixed inputs and retained artifacts. | Campaign summary, retained case, parameters, rerun command, review output, and hash. |
| Adversarial campaign | A campaign intentionally stressed a failure mode from the Risk Plan. | Stress scenarios, hostile personas, sampled ranges, retained failures or no-failure summaries, and review output. |
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
- At least one P0 flow must reach focused campaign, adversarial campaign, or
  guided sim evidence before the assessment can be ready to send.
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
- At least one P0 flow has focused campaign, adversarial campaign, or guided
  sim evidence that a reviewer can rerun from exact commands.
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

- `needs_guided_sim` when Campaign Runner cannot express a P0 flow.
- `needs_campaign_tuning` when the harness runs but the campaign does not yet
  cover the target flow or stress range.
- `blocked` when missing inputs, dependencies, build artifacts, private
  protocol context, or tool support prevent assessment.
- `unsupported` when the requested claim is outside Riptide's simulation
  evidence model.

## Claim language

Use narrow claims that bind the result to the Risk Plan, inputs, commands,
artifacts, and invariants.

Safe claim examples:

- "Riptide reproduced a deposit-pressure campaign for the declared adapter,
  scenario family, seed policy, and invariants. No declared invariant fired in
  the retained runs listed below."
- "The delegated-deposit P0 flow is covered by guided sim evidence for the
  commands and artifacts in this report. Authority rotation is not assessed."
- "This finding is reproducible with the retained campaign case and canonical
  hash listed below."
- "The oracle-lag path is blocked because the protocol-owned oracle account
  layout is not available in the harness."

Treat the following as unsafe claim examples:

- "Riptide proves the protocol is safe."
- "This is an audit replacement."
- "No vulnerabilities exist in the protocol."
- "The protocol is certified because the campaign passed."
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

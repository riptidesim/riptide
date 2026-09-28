# Report

The last stage. It delivers exactly one of three things: an Out-of-Scope Note,
a Blocker Report, or an Assessment. An Assessment has two layers that never
mix: the **Engine Output** that `riptide assess` renders byte-for-byte, and the
**Assessment Context** the agent writes beside it.

## Out-of-Scope Note

Delivered early, from Classify, when the target is not an Economic Protocol
(see [classify-and-scope.md](./classify-and-scope.md)). It runs no Engine
command beyond classification and the gate. Write two files into
`.riptide/out-of-scope-note/`:

`out-of-scope-note.json`, every string non-empty:

```json
{
  "schema_version": "out-of-scope-note.v1",
  "skill_version": "<the Version Pin>",
  "engine_version": "<the Version Pin>",
  "target": "<program path>",
  "classification": {
    "verdict": "not-economic-protocol",
    "evidence": ["<one line per claim, naming its file or IDL entry>"],
    "override": "/riptide-assess <Steering Hint naming the pooled value>"
  },
  "referrals": ["<a code-level auditing tool and what it checks>"]
}
```

`out-of-scope-note.md`, a few lines under two sections, in this order:

1. `## Classification` — what the target is, the evidence that it carries no
   value-bearing mechanism, that Riptide simulates Economic Protocols only,
   and the override.
2. `## Code-Level Auditing` — the referrals: code-level auditing tools for
   the target, such as auditor-skill, solana-security-standard or
   solana-cpi-safety-skill, each with what it checks.

Example: [`./examples/out-of-scope-note.json`](./examples/out-of-scope-note.json).

## Blocker Report

Delivered instead of an Assessment when Coverage is zero: a prerequisite is
missing, the program does not build, or no instruction executed successfully.
Write two files into `.riptide/blocker-report/`:

`blocker-report.json`, every string non-empty:

```json
{
  "schema_version": "blocker-report.v1",
  "skill_version": "<the Version Pin>",
  "engine_version": "<the Version Pin>",
  "depth": "default",
  "scope_declaration": [
    { "assumption": "...", "reason": "...", "override": "/riptide-assess <Steering Hint>" }
  ],
  "blocker": { "command": "<the exact failed command>", "error": "<error code and summary>" },
  "not_exercised": { "instructions": ["..."], "actors": ["..."] },
  "gaps": [{ "subject": "...", "reason": "...", "unblock": "..." }]
}
```

- `skill_version` and `engine_version` are both the Version Pin named in
  [SKILL.md](./SKILL.md), in all three outputs.
- `not_exercised` lists every instruction and actor in scope; each one is the
  `subject` of a Gap. Blocked before Classify named any, both lists are empty
  and the Gap names the missing prerequisite.
- There is at least one Gap.

A missing prerequisite (see Prerequisites in [SKILL.md](./SKILL.md)) blocks
before Classify. `blocker.command` is the failed check, `blocker.error` starts
with `prerequisite_missing`, and one Gap per missing prerequisite names it as
its `subject`, with what to install as its `unblock`:

```json
"blocker": { "command": "cargo-build-sbf --version", "error": "prerequisite_missing: cargo-build-sbf not found on PATH" },
"not_exercised": { "instructions": [], "actors": [] },
"gaps": [{ "subject": "cargo-build-sbf", "reason": "...", "unblock": "install the Solana CLI, which ships cargo-build-sbf" }]
```

`blocker-report.md`, in this order:

1. `## Scope Declaration` — the Depth that would have run and each assumption.
2. `## Blocker` — the exact failed command and its error summary.
3. `## Gaps` — every Gap by its subject, with its reason and unblock.

Examples: [`./examples/blocker-report.json`](./examples/blocker-report.json)
(the program does not build) and
[`./examples/blocker-report-prerequisite.json`](./examples/blocker-report-prerequisite.json)
(a missing prerequisite).

## No risk surface in either

Neither the Out-of-Scope Note nor the Blocker Report describes a risk
surface or makes any claim about the program's behaviour: no Coverage grade,
no invariant that held, no Breach, no metric, no "safe". Their directories
hold no Engine Output (`assessment.json`, `campaign-summary.json`,
`risk-surface.json`, a brief), and their reports carry no `Coverage`,
`Engine Output`, `Region Coverage`, `Risk Surface`, `Invariants`, `Breaches`
or `Delta` section. Both schemas are strict, so a field for any of these is
rejected.

## Gate for all three outputs

`riptide validate <dir> --json` recognises which output a directory holds
from its one agent-written file (`assessment-context.json`,
`out-of-scope-note.json` or `blocker-report.json`) and reports it as
`data.kind`. Run it on whichever one the run produced and deliver only once it
passes:

```bash
riptide validate .riptide/out-of-scope-note --json
riptide validate .riptide/blocker-report --json
```

The gate rejects an Assessment whose Coverage is zero
(`validate_coverage_zero`): write a Blocker Report instead. The one delivery
the gate cannot check is a Blocker Report for a missing `node >= 20`, since the
Engine cannot run without it; deliver it with the failed check and the missing
piece named. Every output's `engine_version` must be the Engine running the
gate (`validate_engine_version_mismatch`).

Deliver an Out-of-Scope Note or a Blocker Report as its composed report,
verbatim.

## 8. Report

### Engine Output

Author `.riptide/assessment-input.json` (an `AssessmentInputs` object) before
the render. It turns the generic defaults into Engine Output that names the
protocol's actual flows, figures and boundaries. Cover at minimum `verdict`,
`riskPlan.target_claim`, `riskPlan.guided_sim_boundaries` and one `coverage[]`
row per P0 flow (`priority`, `flow`, `status`, `evidence_tier`, `commands`,
`artifacts`, `notes`) with an accepted `status`: `covered`,
`covered by guided sim`, `blocked`, `out of scope` or `not assessed`. The
`verdict` value is one of `ready_to_send`, `needs_guided_sim`,
`needs_campaign_tuning`, `blocked` or `unsupported`. Every line must be backed
by what ran; the input adds protocol nouns and figures, never new Breaches.
See [`./examples/assessment-input.json`](./examples/assessment-input.json).

`reproductionCommands` is required: the exact commands that reproduce this
Assessment, in order — the `sim run` and `sim surface` invocations that
produced the root, then the `assess` render — each written out in full
against the pinned Engine, so the Engine Output's reproduction block never
depends on a local install:

```json
"reproductionCommands": [
  "npx --yes @riptidesim/cli@<Version Pin> sim run .riptide/sim --out .riptide/sim/artifacts/crash --json",
  "npx --yes @riptidesim/cli@<Version Pin> sim surface .riptide/sim/artifacts/crash --sim .riptide/sim --json",
  "npx --yes @riptidesim/cli@<Version Pin> assess .riptide --json --input .riptide/assessment-input.json --out <fresh-dir>"
]
```

The gate rejects an Assessment whose `assessment.json` lists a rerun command
that does not start with `npx --yes @riptidesim/cli@<engine_version> `
(`validate_rerun_unpinned`).

Each Assessment has its own directory under `.riptide/assessments/`: `001`
for the first, and the next number for each rerun (see
[reuse.md](./reuse.md)). Keep every Assessment under its own name; never
overwrite an earlier one. `riptide assess` refuses an `--out` directory that
already holds an `assessment-context.json` (`assess_out_holds_assessment`),
or one whose name sorts before an Assessment already beside it
(`assess_out_not_latest`).
Review the surfaced root, then render into the new Assessment directory:

```bash
riptide review <guided-sim-root> --json
riptide assess <guided-sim-root> --json --brief --input .riptide/assessment-input.json --out .riptide/assessments/001
```

`riptide assess` is ingest-only: it re-verifies the execution-honesty gates,
then writes `assessment.json` and a byte-deterministic `assessment.md` (plus
`brief.html` / `brief.pdf` with `--brief`). It blocks on any failed gate —
that is a repair (see [repair.md](./repair.md)), never a reason to hand-write
the report. It picks one of two shapes from the evidence in the root: the
cartography shape (a risk surface, for parameter-tunable protocols) or the
correctness shape (Coverage and Breaches without a heatmap, for protocols
whose risks are binary). Never edit `assessment.json`: the gate re-hashes it
against its own `assessment_digest`.

### Assessment Context

Write the Assessment Context to `assessment-context.json` in the Assessment
directory, beside the Engine's `assessment.json` and never inside it. Its
shape is versioned by `schema_version`; every string is non-empty:

```json
{
  "schema_version": "assessment-context.v1",
  "skill_version": "<the Version Pin>",
  "engine_version": "<the Version Pin>",
  "depth": "default",
  "family": "lending",
  "scope_declaration": [
    { "assumption": "...", "reason": "...", "override": "/riptide-assess <Steering Hint>" }
  ],
  "coverage": {
    "instructions": { "exercised": ["..."], "not_exercised": ["..."] },
    "actors": { "exercised": ["..."], "not_exercised": ["..."] }
  },
  "gaps": [{ "subject": "...", "reason": "...", "unblock": "..." }],
  "invariants": [
    { "id": "...", "provenance": "floor", "firing_check": "fired", "outcome": "held" }
  ],
  "breaches": [
    {
      "invariant_id": "...",
      "seed": "<hex>",
      "replay_command": "npx --yes @riptidesim/cli@<engine_version> sim debug .riptide/sim --seed <hex>",
      "causal_trace": "..."
    }
  ]
}
```

- `engine_version` is the Version Pin named in [SKILL.md](./SKILL.md).
- `depth` is `default` or `deep`, whichever ran (see the Depth table in
  [SKILL.md](./SKILL.md)).
- `scope_declaration` holds every assumption made in place of user input,
  each with its reason and the overriding Steering Hint.
- `coverage` names the instructions and actors the simulation exercised and
  those it did not. A name is never in both lists.
- Every instruction or actor under `not_exercised` has a Gap whose `subject`
  is that exact name. Other Gaps (an invariant with no Firing Check, a sweep
  axis left out) sit beside them.
- `family` is the family whose Floor Invariants apply: `lending`, `amm`,
  `perps`, `lst`, `stablecoin`, or `generic` for the generic Economic
  Protocol fallback (orderbooks and custom protocols). It is the family
  `riptide sim generate` reported under `data.floor_invariants.family`.
- `invariants` lists every invariant the sim checks, once each: every Floor
  Invariant of the family with `provenance: "floor"`, and every invariant
  the agent added with `provenance: "agent"`. `firing_check` is `fired`,
  `did-not-fire` or `not-run` (see [firing-check.md](./firing-check.md));
  `outcome` is `held`, `breached` or `gap`. Only a `fired` invariant can be
  `held` or `breached`; any other is `gap`, with a Gap whose `subject` is
  its ID.
- `breaches` holds one entry per **Breach**: a `fired` invariant that failed
  during the run, at the seed the run reported for it (`sim_run_failed` names
  it, and so does `retained_failing_seed` in `guided-sim-run.json`). Every
  `breached` invariant has at least one Breach, and every Breach names a
  `breached` invariant. Empty when nothing breached.
- `replay_command` is exactly
  `npx --yes @riptidesim/cli@<engine_version> sim debug .riptide/sim --seed <hex>`,
  with this file's `engine_version` and the Breach's `seed`, so the replay
  runs the pinned Engine rather than whatever is installed.
- `causal_trace` is the Causal Trace, written from the replay log and citing
  ticks as `**T<n>**` and the transactions of exercised instructions (see
  [causal-trace.md](./causal-trace.md)).

- `delta` is absent on the first Assessment of a region. On a rerun of the
  previous Assessment's region it is required, and it is exactly `data.delta`
  from `riptide delta <previous-assessment-dir> <assessment-dir> --json`:
  `previous`, `metric_moves`, `gaps_opened`, `gaps_closed` and
  `new_instructions`. The Engine computes it; never edit it (see
  [reuse.md](./reuse.md)).

A complete example: [`./examples/assessment-context.json`](./examples/assessment-context.json).

### Composed assessment.md

Replace the Engine's `assessment.md` with the composed report, in this order:

1. `## Scope Declaration` — the Depth that ran, then each assumption with its
   reason and override.
2. `## Coverage` — the Coverage grade and the exercised and unexercised
   instructions and actors.
3. `## Gaps` — each Gap with its reason and unblock.
4. `## Invariants` — every invariant by its ID, labelled Floor Invariant or
   agent-authored, with its Firing Check result and outcome.
5. `## Breaches` — only when there is a Breach: each one headed by its
   invariant ID and seed, with its replay command verbatim and its Causal
   Trace, worded as simulation evidence.
6. `## Delta` — only on a rerun: the previous Assessment by name, the
   metric moves, the Gaps opened and closed, and each new instruction with
   whether it was exercised, all from the recorded `delta`.
7. `## Engine Output` — a line `Assessment digest: <assessment_digest from
   assessment.json>`, then the Engine's rendered `assessment.md` verbatim.

Read the Engine's `assessment.md` before replacing it; its
bytes survive unchanged inside the `## Engine Output` section. Compose only
after the last `riptide assess` render: once `assessment.md` is composed,
`riptide assess` into the same directory fails with `assess_artifacts_drifted`.
If a repair needs a new render before delivery, move the not-yet-delivered
`assessment-context.json` out of the Assessment directory, delete
`assessment.json` and `assessment.md`, render again, then put the Assessment
Context back and compose again. A teammate
reproduces the Engine Output by rendering into a fresh `--out` directory and
comparing `assessment.json`.

### Validation gate

The Assessment is not complete until the gate passes:

```bash
riptide validate .riptide/assessments/001 --json
```

It checks that `assessment.json` still matches its digest, that
`assessment-context.json` is schema-valid with a Gap for every unexercised
instruction and actor, that it reports every Floor Invariant of its family
with `floor` provenance and no other invariant as `floor`, that no invariant
is `held` or `breached` without a `fired` Firing Check, that every
`breached` invariant has a Breach carrying its exact pinned replay command and
a Causal Trace that cites ticks, and that `assessment.md` opens with the five
required sections, names every invariant under `## Invariants`, gives every
Breach's replay command under `## Breaches` and cites the digest. On a rerun
of the previous Assessment's region it also requires the Delta against that
Assessment, identical to what `riptide delta` computes, and a `## Delta`
section naming it. A failure lists every problem under
`data.problems`, each with a `code` and a `next` repair; fix them all and
rerun the gate. Never declare completion on a failing gate.

### Delivery

Deliver only after `riptide validate` passes. Read the composed
`assessment.md`, `assessment.json`, the campaign summary and the retention
manifest before writing the delivery. Keep it short and
complete:

1. The Scope Declaration, first, including the Depth.
2. The Coverage grade: instructions and actors exercised out of those in
   scope.
3. Breaches, each with its replay command and a one-line Causal Trace
   summary; or, when nothing breached, the Firing-Checked invariants that held
   and the structural reason each held.
4. Gaps, each with its unblock.
5. On a rerun, the Delta: the previous Assessment, the metrics that moved,
   the Gaps opened and closed, and the Coverage of new instructions.
6. Paths: `assessment.md`, `assessment.json`, `assessment-context.json`, the
   brief, and the evidence pack (`campaign-summary.md`,
   `retention-manifest.json`, `retained/`, any `rerun.sh`).
7. The exact rerun commands, verbatim from the Engine Output's reproduction
   block: every `sim run`, `sim surface` and `assess` invocation with its
   options, each against the pinned Engine.
8. The execution-honesty gate results as `riptide assess` printed them.
9. The boundary: simulation evidence over the declared region, not an audit
   signoff.
10. Last line: commit `.riptide/` so anyone can rerun this Assessment.

Cite only section headings the rendered `assessment.md` actually contains.
Word Breaches as simulation evidence (see [honesty.md](./honesty.md)), never
as vulnerabilities.

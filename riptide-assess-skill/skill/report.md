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
  "skill_version": "<this Skill's version>",
  "engine_version": "<riptide --version>",
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

Example: [`../examples/out-of-scope-note.json`](../examples/out-of-scope-note.json).

## Blocker Report

Delivered instead of an Assessment when Coverage is zero: a prerequisite is
missing, the program does not build, or no instruction executed successfully.
Write two files into `.riptide/blocker-report/`:

`blocker-report.json`, every string non-empty:

```json
{
  "schema_version": "blocker-report.v1",
  "skill_version": "<this Skill's version>",
  "engine_version": "<riptide --version>",
  "depth": "default",
  "scope_declaration": [
    { "assumption": "...", "reason": "...", "override": "/riptide-assess <Steering Hint>" }
  ],
  "blocker": { "command": "<the exact failed command>", "error": "<error code and summary>" },
  "not_exercised": { "instructions": ["..."], "actors": ["..."] },
  "gaps": [{ "subject": "...", "reason": "...", "unblock": "..." }]
}
```

- `not_exercised` lists every instruction and actor in scope; each one is the
  `subject` of a Gap. Blocked before Classify named any, both lists are empty
  and the Gap names the missing prerequisite.
- There is at least one Gap.

`blocker-report.md`, in this order:

1. `## Scope Declaration` — the Depth that would have run and each assumption.
2. `## Blocker` — the exact failed command and its error summary.
3. `## Gaps` — every Gap by its subject, with its reason and unblock.

Example: [`../examples/blocker-report.json`](../examples/blocker-report.json).

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
the gate cannot check is a Blocker Report for a missing or failed Engine
install; deliver it with the failed command and the missing piece named.

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
verdict is one of `ready_to_send`, `needs_guided_sim`,
`needs_campaign_tuning`, `blocked` or `unsupported`. Every line must be backed
by what ran; the input adds protocol nouns and figures, never new Breaches.
See [`../examples/assessment-input.json`](../examples/assessment-input.json).

Review the surfaced root, then render into the Assessment directory:

```bash
riptide review <guided-sim-root> --json
mkdir -p .riptide/assessment
riptide assess <guided-sim-root> --json --brief --input .riptide/assessment-input.json --out .riptide/assessment
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
  "skill_version": "<this Skill's version>",
  "engine_version": "<riptide --version>",
  "depth": "default",
  "scope_declaration": [
    { "assumption": "...", "reason": "...", "override": "/riptide-assess <Steering Hint>" }
  ],
  "coverage": {
    "instructions": { "exercised": ["..."], "not_exercised": ["..."] },
    "actors": { "exercised": ["..."], "not_exercised": ["..."] }
  },
  "gaps": [{ "subject": "...", "reason": "...", "unblock": "..." }]
}
```

- `depth` is `default` or `deep`, whichever ran (see the Depth table in
  [SKILL.md](./SKILL.md)).
- `scope_declaration` holds every assumption made in place of user input,
  each with its reason and the overriding Steering Hint.
- `coverage` names the instructions and actors the simulation exercised and
  those it did not. A name is never in both lists.
- Every instruction or actor under `not_exercised` has a Gap whose `subject`
  is that exact name. Other Gaps (an invariant with no Firing Check, a sweep
  axis left out) sit beside them.

A complete example: [`../examples/assessment-context.json`](../examples/assessment-context.json).

Beyond those fields, record per invariant its ID, provenance (`floor` or
`agent`), Firing Check result (`fired`, `did-not-fire` or `not-run`) and
outcome (`held`, `breached` or `gap`) — only a `fired` invariant can be
`held`; each Breach with its invariant ID, seed, replay command
(`riptide sim debug .riptide/sim --seed <hex>`) and Causal Trace (see
[causal-trace.md](./causal-trace.md)); and the Delta against the previous
Assessment in this Workspace, when there is one.

Keep every Assessment under its own name; never overwrite an earlier one.

### Composed assessment.md

Replace the Engine's `assessment.md` with the composed report, in this order:

1. `## Scope Declaration` — the Depth that ran, then each assumption with its
   reason and override.
2. `## Coverage` — the Coverage grade and the exercised and unexercised
   instructions and actors.
3. `## Gaps` — each Gap with its reason and unblock.
4. `## Engine Output` — a line `Assessment digest: <assessment_digest from
   assessment.json>`, then the Engine's rendered `assessment.md` verbatim.

Breaches and the Delta, when present, go between `## Gaps` and
`## Engine Output`. Read the Engine's `assessment.md` before replacing it; its
bytes survive unchanged inside the `## Engine Output` section. Compose only
after the last `riptide assess` render: once `assessment.md` is composed,
`riptide assess` into the same directory fails with `assess_artifacts_drifted`.
If a repair needs a new render, delete `assessment.json` and `assessment.md`
from the Assessment directory, render again, and compose again. A teammate
reproduces the Engine Output by rendering into a fresh `--out` directory and
comparing `assessment.json`.

### Validation gate

The Assessment is not complete until the gate passes:

```bash
riptide validate .riptide/assessment --json
```

It checks that `assessment.json` still matches its digest, that
`assessment-context.json` is schema-valid with a Gap for every unexercised
instruction and actor, and that `assessment.md` opens with the four required
sections and cites the digest. A failure lists every problem under
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
5. Paths: `assessment.md`, `assessment.json`, `assessment-context.json`, the
   brief, and the evidence pack (`campaign-summary.md`,
   `retention-manifest.json`, `retained/`, any `rerun.sh`).
6. The exact rerun commands executed: every `riptide sim run`,
   `riptide sim surface` and `riptide assess` invocation with its options.
7. The execution-honesty gate results as `riptide assess` printed them.
8. The boundary: simulation evidence over the declared region, not an audit
   signoff.
9. Last line: commit `.riptide/` so anyone can rerun this Assessment.

Cite only section headings the rendered `assessment.md` actually contains.
Word Breaches as simulation evidence (see [honesty.md](./honesty.md)), never
as vulnerabilities.

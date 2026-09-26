# Report

The last stage. It delivers exactly one of three things: an Out-of-Scope Note,
a Blocker Report, or an Assessment. An Assessment has two layers that never
mix: the **Engine Output** that `riptide assess` renders byte-for-byte, and the
**Assessment Context** the agent writes beside it.

## Out-of-Scope Note

Delivered early, from Classify, when the target is not an Economic Protocol.
It states in a few lines what the target is, the evidence that it carries no
value-bearing mechanism, and that Riptide simulates Economic Protocols only.
It points to code-level auditing tools for the target instead, and it runs no
Engine command beyond classification.

## Blocker Report

Delivered instead of an Assessment when Coverage is zero: a prerequisite is
missing, the program does not build, or no instruction executed successfully.
It lists each Gap with its reason and what would unblock it, plus the exact
failed command and error summary. It describes no risk surface and makes no
claim about the program's behaviour.

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

Review the surfaced root, then render:

```bash
riptide review <guided-sim-root> --json
riptide assess <guided-sim-root> --json --brief --input .riptide/assessment-input.json
```

`riptide assess` is ingest-only: it re-verifies the execution-honesty gates,
then writes `assessment.json` and a byte-deterministic `assessment.md` (plus
`brief.html` / `brief.pdf` with `--brief`). It blocks on any failed gate —
that is a repair (see [repair.md](./repair.md)), never a reason to hand-write
the report. It picks one of two shapes from the evidence in the root: the
cartography shape (a risk surface, for parameter-tunable protocols) or the
correctness shape (Coverage and Breaches without a heatmap, for protocols
whose risks are binary). Never edit the files it writes.

### Assessment Context

Write the Assessment Context as its own file beside the Engine's
`assessment.json`, never inside it. It holds:

- the Skill version and the Engine version (`riptide --version`);
- the Depth that ran;
- the Scope Declaration: each assumption with its reason and overriding
  Steering Hint;
- Coverage: the instructions and actors exercised, and those not exercised;
- Gaps: each with the subject, the reason and what would unblock it;
- invariants: each with its ID, provenance (`floor` or `agent`), Firing Check
  result (`fired`, `did-not-fire` or `not-run`) and outcome (`held`,
  `breached` or `gap`) — only a `fired` invariant can be `held`;
- Breaches: each with the invariant ID, the seed, the replay command
  (`riptide sim debug .riptide/sim --seed <hex>`) and its Causal Trace (see
  [causal-trace.md](./causal-trace.md));
- the Delta against the previous Assessment in this Workspace, when there is
  one.

Keep every Assessment under its own name; never overwrite an earlier one.

### Delivery

Read the rendered `assessment.md`, `assessment.json`, the campaign summary and
the retention manifest before writing the delivery. Keep it short and
complete:

1. The Scope Declaration, first, including the Depth.
2. The Coverage grade: instructions and actors exercised out of those in
   scope.
3. Breaches, each with its replay command and a one-line Causal Trace
   summary; or, when nothing breached, the Firing-Checked invariants that held
   and the structural reason each held.
4. Gaps, each with its unblock.
5. Paths: `assessment.md`, `assessment.json`, the Assessment Context, the
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

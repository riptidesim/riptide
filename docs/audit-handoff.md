# Reviewer and audit handoff packet

Use this packet when Riptide evidence is part of a protocol launch
review, external pilot, audit-prep discussion, or security-minded
engineering review. The goal is to make the ask concrete: rerun this,
falsify it, or explain what blocks trust.

For protocol-team outreach that spans multiple guided-sim sweeps, guided sims,
blocked surfaces, or non-findings, first assemble a
[Protocol assessment workflow](protocol-assessment.md) coverage matrix and fill
the [protocol assessment report template](templates/protocol-assessment-report.md).
Then attach that report alongside the reviewer packet below.

## Launch and review checklist

1. **Pick the evidence path.** Start with the committed guided-sim assessment
   evidence for the protocol under review: a guided-sim root with its generated
   artifacts and assessment.
2. **Run the guided-sim flow.** From the workspace root:

   ```bash
   riptide sim run .riptide/sim --flows <N> --out <run-path>
   riptide sim surface <run-path> --sim .riptide/sim
   riptide assess <run-path>
   riptide review <run-path>
   ```

   If the review runs in CI, attach the workflow run URL and download the
   generated guided-sim artifacts from it.

3. **Attach the expected evidence.** Include the guided-sim root, the generated
   artifacts (`risk-surface.json`, `campaign-summary.json`,
   `retention-manifest.json`, `assessment.json`, `assessment.md`), the rerun
   commands, `riptide assess`/`riptide review` stdout, commit SHA, toolchain
   notes, and any completed assessment report.
4. **Write reviewer notes.** State what was reproduced, what did not
   reproduce, which assumptions were inspected, and which claim remains
   untrusted.
5. **Open follow-up issues for blockers.** Do not fold drift,
   confusing docs, adapter gaps, or missing provenance into the
   original claim. Track them as explicit follow-up work.

## Expected evidence

| Item | Expected value |
| --- | --- |
| Guided-sim root | `<path to the guided-sim root under review>` |
| Sweep run command | `riptide sim run .riptide/sim --flows <N> --out <run-path>` |
| Cartography build command | `riptide sim surface <run-path> --sim .riptide/sim` |
| Assessment command | `riptide assess <run-path>` |
| Review command | `riptide review <run-path>` |
| Generated artifacts | `risk-surface.json`, `campaign-summary.json`, `retention-manifest.json`, `assessment.json`, `assessment.md` |
| Review exit behavior | `riptide review` can exit non-zero when invariant firings or absent provenance are the expected signal; the deterministic artifacts must still reproduce. |

## Reviewer packet template

````markdown
# Riptide evidence review request

## Context

- Repo:
- Commit:
- Evidence path:
- Intended claim:
- Known limits:

## Please do one or more

- Reproduce the guided-sim run and compare the generated artifacts.
- Falsify the input, invariant, sweep range, or scope assumptions.
- Identify any trust blocker in the guided-sim root, CI run, runbook, or docs.
- Report whether the evidence changes your launch, review, or risk decision.

## Commands

```bash
riptide sim run .riptide/sim --flows <N> --out <run-path>
riptide sim surface <run-path> --sim .riptide/sim
riptide assess <run-path>
riptide review <run-path>
```

## Attachments

- Guided-sim root:
- Generated artifacts (`risk-surface.json`, `assessment.md`, ...):
- `riptide assess` stdout:
- `riptide review` stdout:
- Rerun commands:
- CI run URL:
- Case-study readiness notes:

## Result

- Reproduced? yes/no/partial
- Artifacts matched? yes/no
- Trust blockers:
- Suggested follow-up:
````

## Follow-up issue format

````markdown
# Evidence trust blocker: <short title>

## Environment

- OS:
- Riptide commit:
- Riptide version:
- Node/Rust/Solana versions:

## Evidence path

- Guided-sim root, sweep run, or guided artifact:
- Rerun command:
- Generated artifacts (`risk-surface.json` / `assessment.md` / ...):
- Reproduced artifacts match? yes/no/partial:

## Commands and output

```bash
<exact command>
```

```text
<stdout/stderr excerpt>
```

## What blocks trust

- Reproduction drift:
- Missing or confusing input:
- Weak or ambiguous invariant:
- CI or toolchain concern:
- Documentation gap:

## Proposed next step

<smallest change that would make this reviewable>
````

## Decision record

For launch or audit-prep use, close the loop with one of these
outcomes:

- Reproduced and accepted as useful simulation evidence for the named
  claim.
- Reproduced but not decision-changing; document why.
- Drifted; investigate before updating the pinned evidence.
- Blocked by missing inputs, weak invariants, unclear docs, or
  toolchain concerns.
- Out of scope for Riptide; route to audit, formal methods, manual
  review, or protocol-specific monitoring.

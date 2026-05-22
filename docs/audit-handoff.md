# Reviewer and audit handoff packet

Use this packet when Riptide evidence is part of a protocol launch
review, external pilot, audit-prep discussion, or security-minded
engineering review. The goal is to make the ask concrete: rerun this,
falsify it, or explain what blocks trust.

For protocol-team outreach that spans multiple campaigns, guided sims, blocked
surfaces, or non-findings, first assemble a
[Protocol assessment workflow](protocol-assessment.md) coverage matrix and fill
the [protocol assessment report template](templates/protocol-assessment-report.md).
Then attach that report alongside the reviewer packet below.

## Launch and review checklist

1. **Pick the evidence path.** Start with the flagship
   `lst-lending-contagion-proof` unless your review has its own
   committed replay, scenario, campaign, or guided-sim artifact.
2. **Run the proof or workflow.** For the flagship local path:

   ```bash
   bash fixtures/replays/lst-lending-contagion-proof/rerun.sh
   riptide review .riptide/pack/replay-multi-lst-lending-contagion-proof-upstream
   ```

   For CI, use the green
   [contagion proof workflow](../.github/workflows/contagion-proof-ci.yml)
   run and download the `contagion-proof-pack` artifact.

3. **Attach the expected evidence.** Include the pack directory or
   artifact, rerun stdout, review stdout, canonical hash, commit SHA,
   toolchain notes, any completed assessment report, and any Studio
   screenshots or report links used in the review.
4. **Write reviewer notes.** State what was reproduced, what did not
   reproduce, which assumptions were inspected, and which claim remains
   untrusted.
5. **Open follow-up issues for blockers.** Do not fold drift,
   confusing docs, adapter gaps, or missing provenance into the
   original claim. Track them as explicit follow-up work.

## Expected flagship evidence

| Item | Expected value |
| --- | --- |
| Proof path | `fixtures/replays/lst-lending-contagion-proof/` |
| Local rerun command | `bash fixtures/replays/lst-lending-contagion-proof/rerun.sh` |
| Pack review command | `riptide review .riptide/pack/replay-multi-lst-lending-contagion-proof-upstream` |
| Canonical hash | `d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb` |
| CI workflow | `.github/workflows/contagion-proof-ci.yml` |
| CI artifact | `contagion-proof-pack` |
| Review exit behavior | `riptide review` exits `1` for this proof because invariant firings are the expected signal; hash verification must still pass. |

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

- Reproduce the run and compare the canonical hash.
- Falsify the input, bridge, invariant, or scope assumptions.
- Identify any trust blocker in the pack, CI workflow, runbook, or docs.
- Report whether the evidence changes your launch, review, or risk decision.

## Commands

```bash
bash fixtures/replays/lst-lending-contagion-proof/rerun.sh
riptide review .riptide/pack/replay-multi-lst-lending-contagion-proof-upstream
```

Expected canonical hash:

```text
d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb
```

## Attachments

- Rerun stdout:
- Review stdout:
- Pack artifact:
- CI run URL:
- Studio notes or screenshots:
- Case-study readiness notes:

## Result

- Reproduced? yes/no/partial
- Hash matched? yes/no
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

- Proof, scenario, campaign, or guided artifact:
- Expected canonical hash:
- Actual canonical hash:
- Pack path or artifact URL:

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
- Drifted; investigate before updating the pinned hash.
- Blocked by missing inputs, weak invariants, unclear docs, or
  toolchain concerns.
- Out of scope for Riptide; route to audit, formal methods, manual
  review, or protocol-specific monitoring.

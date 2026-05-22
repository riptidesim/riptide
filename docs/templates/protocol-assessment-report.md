# Protocol assessment report

Use this template after real Riptide runs. Replace bracketed text with the
specific protocol, commit, commands, artifacts, hashes, and reviewer notes.

This report records simulation evidence. It is not audit signoff, complete
protocol safety, formal verification, mainnet monitoring, or certification.

## Executive summary

- **Protocol:** [protocol name]
- **Repository:** [repo URL or local path]
- **Commit:** [commit SHA]
- **Assessment date:** [Month day, year]
- **Riptide version or commit:** [version or commit]
- **Verdict:** [ready_to_send | needs_guided_sim | needs_campaign_tuning | blocked | unsupported]
- **Headline claim:** [one narrow claim tied to the Risk Plan and evidence]
- **Main finding:** [finding summary, or "No finding under the declared inputs"]
- **Main limit:** [largest blocked, out-of-scope, or not-assessed surface]

Short summary:

[Two to five sentences. State what Riptide ran, what it observed, what it did
not assess, and what the protocol team should review next.]

## Scope

### In scope

- [P0/P1 flow, instruction family, account path, or scenario family]
- [Campaign or guided-sim path]
- [Invariant, metric, or assertion]

### Out of scope

- [Flow or surface intentionally excluded]
- [Manual audit, formal proof, monitoring, or production behavior not claimed]

### Claim boundary

This report supports only the declared simulation evidence. It does not claim
complete protocol safety, audit signoff, historical mainnet behavior, or
coverage of flows outside the matrix below.

## Risk Plan

- **Protocol class:** [lending, AMM, staking, payments, governance, bridge, or other]
- **Target claim:** [narrow statement this report can support]
- **Evidence profile:** [calibration, focused campaign, adversarial campaign, guided sim, negative control]
- **P0 flows:** [list]
- **P1 flows:** [list]
- **Expected failure modes:** [list]
- **Guided-sim boundaries:** [what requires guided sim, if any]
- **Known coverage limits:** [list]

## Coverage Matrix

Use only these status values: `covered`, `covered by guided sim`, `blocked`,
`out of scope`, and `not assessed`.

| Priority | Flow | Status | Evidence tier | Commands | Artifacts and hashes | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | [flow name] | [covered] | [focused campaign] | [`command`] | [path, hash] | [claim or limit] |
| P0 | [flow name] | [covered by guided sim] | [guided sim] | [`command`] | [path, hash] | [claim or limit] |
| P0 | [flow name] | [blocked] | [blocked] | [blocked command or none] | [missing artifact] | [blocker and next step] |
| P1 | [flow name] | [not assessed] | [not assessed] | [none] | [none] | [why not assessed] |

## Simulations run

### Calibration

- **Command:**

  ```bash
  [exact command]
  ```

- **Result:** [passed, failed, or blocked]
- **Artifacts:** [paths]
- **Hashes:** [canonical hash, selected account hash, or "not emitted"]
- **Notes:** [what this proves and what it does not prove]

### Focused campaigns

| Objective | Command | Result | Retained evidence | Hashes | Notes |
| --- | --- | --- | --- | --- | --- |
| [objective] | [`riptide campaign run ...`] | [result] | [path] | [hash] | [notes] |

### Adversarial campaigns

| Failure mode | Command | Result | Retained evidence | Hashes | Notes |
| --- | --- | --- | --- | --- | --- |
| [failure mode] | [`riptide campaign run ...`] | [result] | [path] | [hash] | [notes] |

### Guided sims

| Flow | Command | Result | Artifact | Hashes | Notes |
| --- | --- | --- | --- | --- | --- |
| [flow] | [`riptide sim run ...`] | [result] | [path] | [hash] | [notes] |

### Negative controls

| Control | Expected result | Actual result | Command | Artifact | Notes |
| --- | --- | --- | --- | --- | --- |
| [control] | [expected failure or rejection] | [actual] | [`command`] | [path] | [notes] |

## Findings

Use this section only for reproducible issues or risk signals observed in the
declared simulations.

### Finding 1: [short title]

- **Severity or priority:** [P0, P1, or informational]
- **Affected flow:** [flow]
- **Evidence tier:** [focused campaign, adversarial campaign, guided sim, or negative control]
- **Reproduction command:**

  ```bash
  [exact command]
  ```

- **Artifacts:** [paths]
- **Hashes:** [hashes]
- **Observed result:** [what happened]
- **Why it matters:** [economic or operational impact]
- **Recommended fix or review:** [next protocol-owner action]

## Non-Findings

Use this section for tested claims where no declared invariant fired under the
listed inputs. Do not phrase a non-finding as proof that the protocol is safe.

| Flow | Evidence | Statement | Limit |
| --- | --- | --- | --- |
| [flow] | [command, artifact, hash] | [No declared invariant fired under these inputs.] | [limit] |

## Blocked and out-of-scope surfaces

| Surface | Status | Reason | Needed next step | Owner |
| --- | --- | --- | --- | --- |
| [surface] | [blocked] | [missing IDL, fixture, service, account layout, or command failure] | [next step] | [owner] |
| [surface] | [out of scope] | [why excluded] | [audit, manual review, guided sim, or monitoring] | [owner] |

## Reproduction Commands

Run these commands from the repository root at commit `[commit SHA]`.

```bash
[exact command 1]
[exact command 2]
[exact command 3]
```

Expected artifacts:

| Command | Expected artifact | Expected hash or result |
| --- | --- | --- |
| [`command`] | [path] | [hash or result] |

## Toolchain

- **OS:** [OS and version]
- **Rust:** [rustc version]
- **Cargo:** [cargo version]
- **Solana:** [solana version or not used]
- **Node.js:** [node version or not used]
- **Riptide:** [version or commit]
- **Program binaries:** [paths and build notes]
- **IDL:** [path and generation notes]
- **Environment notes:** [anything needed to reproduce]

## Recommended next work

- [Smallest next campaign tuning step]
- [Guided sim needed for dynamic flow]
- [Protocol-owner input needed]
- [Manual review, audit, formal methods, or monitoring step outside Riptide]

## Reviewer checklist

Before forwarding this report, verify each item.

- [ ] The commit SHA is present and matches the assessed checkout.
- [ ] Every headline claim points to a command, artifact, and hash when one
      was emitted.
- [ ] Every P0 Risk Plan flow appears in the Coverage Matrix.
- [ ] `blocked`, `out of scope`, and `not assessed` rows explain why the flow
      is not covered.
- [ ] Findings and Non-Findings are separate.
- [ ] Non-Findings use bounded language such as "no declared invariant fired
      under these inputs."
- [ ] Reproduction Commands are exact and runnable from the repository root.
- [ ] Artifacts are attached or their paths are valid for the reviewer.
- [ ] Hashes are copied exactly from the Riptide output or marked "not emitted."
- [ ] Toolchain notes include Riptide, Rust, Solana, Node.js, program binary,
      and IDL details where relevant.
- [ ] The report says this is simulation evidence, not audit signoff or
      complete protocol safety.

# Submission Package

This is the pre-submission demo package for Riptide's current shipped
surface. It is a script and copy source, not a publishing step.

## Demo Script

Target length: 3 to 4 minutes.

### 1. Problem

Solana teams can run unit tests and audits, but economic failures often
come from interactions between accounts, actors, oracle inputs, and market
conditions. Riptide gives those teams a deterministic local way to map a
declared stress case before they launch or change risk parameters.

### 2. Studio Walkthrough

Open the local Studio route:

```bash
riptide studio --no-open --case-studies-root <path-to-case-studies>
```

Use `raydium-cp-swap` for the current Studio walkthrough because the
workspace has real `.riptide/` artifacts: adapter, scenario, campaign,
run collection, packs, readiness reports, and persisted job history.

Show:

- Reports defaulting to `run-collection.json`, with 33 indexed artifacts.
- The `Open dashboard` drilldown loading
  `/dashboard?workspace=raydium-cp-swap&source=.riptide/run-collection.json`.
- The Adapter page simulation diagram with workspace, adapter, campaign,
  personas, scenario, engine, run, and pack nodes.
- Campaign preview showing the exact allowlisted command:

  ```text
  riptide campaign run .riptide/campaigns/raydium-cp-swap-smoke.campaign.toml --harness .riptide/harness
  ```

- Agent chat / config handoff as a prompt handoff surface, not automatic
  file mutation or hidden agent execution.

### 3. CLI Evidence

Switch to the flagship proof from the repository root:

```bash
bash fixtures/replays/lst-lending-contagion-proof/rerun.sh
```

Expected canonical hash:

```text
d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb
```

Then validate the emitted pack:

```bash
riptide review .riptide/pack/replay-multi-lst-lending-contagion-proof-upstream
```

The review command exits `1` for this proof because invariant firings are
the expected signal. The useful check is that hash verification passes
and the invariant section identifies the upstream slash and downstream
bad-debt trace.

### 4. Trust Boundary

Close with the boundary: Riptide produces deterministic simulation
evidence from declared inputs. It helps reviewers reproduce, inspect, or
challenge a risk claim. It is not audit signoff, formal verification,
mainnet monitoring, Cloud, or a promise that every failure mode was found.

## Shot List

| Shot | Surface | Capture |
| --- | --- | --- |
| Problem setup | Title terminal or README | One sentence: deterministic stress testing for Solana economic risk. |
| Studio workspace | Studio Reports | `raydium-cp-swap`, 33 artifacts, `run-collection.json`. |
| Evidence viewer | Studio Reports | Markdown/JSON report viewer and artifact details. |
| Dashboard drilldown | Studio dashboard | Scoped `workspace` + `source` URL and run collection table. |
| Simulation diagram | Studio Adapter | Graph nodes and clicked adapter source path. |
| Job preview | Studio Campaigns | Allowlisted `argv`, `cwd`, expected artifact, notes. |
| Config handoff | Studio Agent chat | Prompt/handoff surface; no automatic file edits. |
| Flagship rerun | Terminal | `rerun.sh`, canonical hash line. |
| Review boundary | Terminal | `riptide review`, hash verification, invariant firings, exit-code note. |
| Closing | Trust docs | Link trust page, CI handoff, pack docs, and known limits. |

## Submission Copy

### One Sentence

Riptide is an open-source local simulation framework that helps Solana
teams run deterministic multi-agent stress tests and forward
reproducible evidence packs before launch or risk-parameter changes.

### Short Description

Riptide runs declared Solana protocol scenarios in LiteSVM, drives them
with configurable actor personas, and writes reviewer-facing evidence:
reports, dashboards, canonical hashes, rerun scripts, and CI handoff
workflows. The current trust path includes a flagship multi-program
LST-to-lending contagion proof that reruns from committed inputs and
asserts canonical hash
`d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb`.
Riptide Studio is the local visual workflow for inspecting real
workspace artifacts, previewing allowlisted jobs, and preparing
`riptide-config` handoff prompts.

### Longer Summary

Riptide is built for Solana teams that need more than a happy-path local
test but cannot afford heavyweight bespoke risk infrastructure. A team
declares adapters, accounts, personas, scenarios, campaigns, and
invariants in its repo. Riptide executes those experiments locally in a
deterministic LiteSVM-backed engine, then writes evidence that another
engineer can inspect or rerun.

The current pre-submission package focuses on trust over breadth. The
flagship proof models an upstream liquid-staking slash propagating into
downstream lending bad debt through one declared bridge. The proof ships
with a runbook, expected canonical hash, review command, and GitHub
Actions handoff. Studio shows the local workspace path: artifact library,
report viewer, simulation graph, dashboard drilldown, campaign job
preview, and setup handoff. The case-study readiness page separates
demo-ready rows from blocked rows so the project does not claim every
external protocol is wired end to end.

Riptide's boundary is explicit: this is simulation evidence, not audit
signoff. Useful outcomes include reproducing the evidence, finding drift,
falsifying an assumption, opening a blocker issue, or deciding that a
risk parameter or launch plan needs more review.

## Links

- [Trust and review path](trust.md)
- [Flagship proof runbook](../fixtures/replays/lst-lending-contagion-proof/README.md)
- [Evidence packs](pack.md)
- [CI handoff](ci-handoff.md)
- [Case-study corpus readiness](case-study-corpus.md)
- [Studio](studio.md)
- [Audit handoff packet](audit-handoff.md)

## Explicit Cuts

- No public publishing happens as part of this package.
- No hidden network dependency is required for the reviewer rerun path.
- No Cloud, telemetry, mainnet monitoring, alerting, remote job execution,
  generic shell, or automatic push/publish flow is included.
- Actual video recording is separate from this script and shot list.

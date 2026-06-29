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

### 2. Guided-sim Walkthrough

Walk the guided-sim assessment flow on a real workspace. Use
`anchor-uniswap-v2` because it has working `.riptide/` artifacts: adapter,
guided-sim manifest, Rust flows, and a reviewable artifact.

```bash
riptide init
# run /riptide-config to finish the adapter and guided sim
riptide sim generate --adapter .riptide/adapters/anchor-uniswap-v2.toml
riptide sim run .riptide/sim --flows 20 --out /tmp/auv2-run
riptide sim surface /tmp/auv2-run --sim .riptide/sim
riptide assess /tmp/auv2-run
riptide review /tmp/auv2-run
```

Show:

- `riptide sim run` producing a deterministic guided-sim artifact.
- `riptide sim surface` building the cartography artifacts
  (`risk-surface.json`, `campaign-summary.json`, `retention-manifest.json`)
  from the parameter sweep.
- `riptide assess` generating the byte-deterministic assessment report.
- `riptide review` accepting the guided-sim root.
- `/riptide-config` as a prompt handoff surface, not automatic file mutation
  or hidden agent execution.

### 3. Determinism Check

Re-run the assessment over the same root to show the bytes are stable:

```bash
riptide assess /tmp/auv2-run
riptide assess /tmp/auv2-run
```

`riptide assess` is ingest-only and byte-deterministic: two runs over the same
guided-sim root produce byte-identical `assessment.json` and `assessment.md`,
so a reviewer can reproduce the exact bytes.

### 4. Trust Boundary

Close with the boundary: Riptide produces deterministic simulation
evidence from declared inputs. It helps reviewers reproduce, inspect, or
challenge a risk claim. It is not audit signoff, formal verification,
mainnet monitoring, Cloud, or a promise that every failure mode was found.

## Shot List

| Shot | Surface | Capture |
| --- | --- | --- |
| Problem setup | Title terminal or README | One sentence: deterministic stress testing for Solana economic risk. |
| Guided-sim run | Terminal | `riptide sim run`, deterministic guided-sim artifact path. |
| Cartography build | Terminal | `riptide sim surface`, `risk-surface.json` + `campaign-summary.json`. |
| Assessment | Terminal | `riptide assess`, generated `assessment.md`. |
| Review boundary | Terminal | `riptide review`, accepted root, invariant section, exit-code note. |
| Config handoff | Terminal | `/riptide-config` prompt/handoff surface; no automatic file edits. |
| Determinism | Terminal | Second `riptide assess`, byte-identical artifacts. |
| Closing | Trust docs | Link trust page, case-study readiness, and known limits. |

## Submission Copy

### One Sentence

Riptide is an open-source local simulation framework that helps Solana
teams run deterministic multi-agent stress tests and forward
reproducible evidence before launch or risk-parameter changes.

### Short Description

Riptide runs declared Solana protocol scenarios in LiteSVM, drives them
with configurable actor personas, and writes reviewer-facing evidence:
guided-sim artifacts, risk-surface and assessment reports, and exact rerun
commands. The current trust path is the guided-sim assessment flow: generate
a guided sim, run a parameter sweep, build the cartography artifacts with
`riptide sim surface`, and generate a byte-deterministic report with
`riptide assess`. `/riptide-config` is the agent handoff that finishes a
repo's adapter and guided sim.

### Longer Summary

Riptide is built for Solana teams that need more than a happy-path local
test but cannot afford heavyweight bespoke risk infrastructure. A team
declares adapters, accounts, personas, scenarios, and invariants in its
repo. Riptide executes those experiments locally in a deterministic
LiteSVM-backed simulation, then writes evidence that another engineer can
inspect or rerun.

The current pre-submission package focuses on trust over breadth. The
guided-sim assessment flow takes a Solana program repo to a reviewable
report: a guided-sim parameter sweep produces `risk-surface.json` and
`campaign-summary.json` through `riptide sim surface`, and `riptide assess`
turns a guided-sim root into a byte-deterministic assessment that another
engineer can reproduce or rerun. The case-study readiness page separates
demo-ready rows from blocked rows so the project does not claim every
external protocol is wired end to end.

Riptide's boundary is explicit: this is simulation evidence, not audit
signoff. Useful outcomes include reproducing the evidence, finding drift,
falsifying an assumption, opening a blocker issue, or deciding that a
risk parameter or launch plan needs more review.

## Links

- [Trust and review path](trust.md)
- [Protocol assessment workflow](protocol-assessment.md)
- [Guided sim](guided-sim.md)
- [Case-study corpus readiness](case-study-corpus.md)
- [Audit handoff packet](audit-handoff.md)

## Explicit Cuts

- No public publishing happens as part of this package.
- No hidden network dependency is required for the reviewer rerun path.
- No Cloud, telemetry, mainnet monitoring, alerting, remote job execution,
  generic shell, or automatic push/publish flow is included.
- Actual video recording is separate from this script and shot list.

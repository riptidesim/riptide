# Trust and review path

Riptide is meant to make simulation evidence easy to rerun, inspect,
and challenge. It does not certify a protocol. A useful review can
confirm reproduction, find a drift, falsify an assumption, or explain
what still blocks trust.

## Evidence path

Riptide evidence is a guided-sim run: a declared parameter sweep against a
Solana program adapter, retained as a reviewer-forwardable artifact. A guided
sim runs the experiment the developer picked, retains the failing case, and
emits an artifact (`guided-sim-run.json` + `rerun.sh`) that anyone can re-run
and validate.

Produce and forward evidence from the repository root:

```bash
riptide init
riptide sim generate --adapter .riptide/adapters/<program-name>.toml
riptide sim run .riptide/sim --flows 64 --out .riptide/sim/artifacts/run-001
riptide sim surface .riptide/sim/artifacts/run-001 --sim .riptide/sim
riptide assess .riptide/sim/artifacts/run-001
riptide review .riptide/sim/artifacts/run-001
```

`riptide sim surface` builds the cartography artifacts
(`campaign-summary.json`, `risk-surface.json`, `retention-manifest.json`) from
the sweep. `riptide review` validates the retained artifact read-only and
prints the failing seed, flow counts, labelled transaction outcomes, failure
reason, and rerun command. The review command is expected to exit non-zero when
the run intentionally records invariant firings; the reviewer signal is that
the artifact is well-formed and its `rerun.sh` is present and parseable.

## Evidence surfaces

| Surface | What to inspect |
| --- | --- |
| [Guided simulation](guided-sim.md) | How a guided sim is generated, run, and retained, and what the artifact records. |
| [Reviewer command](reviewer.md) | Read-only artifact validation and review exit-code behavior. |
| [Protocol assessment](protocol-assessment.md) | How guided-sim artifacts roll up into a protocol-level assessment report. |
| [Case-study corpus readiness](case-study-corpus.md) | Current demo-ready versus blocked local corpus rows and their boundaries. |
| [Audit handoff packet](audit-handoff.md) | Checklist, packet template, reviewer ask, and follow-up issue format. |

## Known limits

- Simulation evidence is not an audit result, formal verification, or
  protocol safety certification.
- A guided-sim artifact describes one declared parameter sweep against the
  chosen adapter. It is not a generalized N-protocol scenario engine and not a
  forensic reproduction of a specific mainnet incident.
- The external case-study corpus keeps blocked rows' adapter, IDL, harness, or
  artifact gaps explicit rather than papering over them.
- Historical incident fixtures are economic-shape evidence with named
  boundaries, not bytecode-level reconstructions.

## What to ask reviewers for

Ask a reviewer to do at least one concrete thing:

- Reproduce a guided-sim run from a fresh checkout and confirm the artifact
  re-runs.
- Falsify the invariant or input assumptions and explain the smallest change
  that breaks the claim.
- Inspect the retained artifact and assessment report for trust blockers.
- Report whether the evidence path is understandable without private context.
- Open an issue with the exact command, exit code, artifact path, and trust
  blocker.

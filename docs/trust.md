# Trust and review path

Riptide is meant to make simulation evidence easy to rerun, inspect,
and challenge. It does not certify a protocol. A useful review can
confirm reproduction, find a drift, falsify an assumption, or explain
what still blocks trust.

## Flagship proof

The current flagship proof is
[`fixtures/replays/lst-lending-contagion-proof/`](../fixtures/replays/lst-lending-contagion-proof/):
an upstream liquid-staking slash propagates through one declared bridge
into a downstream lending oracle, then realizes downstream bad debt in
a deterministic replay.

Canonical hash:

```text
d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb
```

Run it from the repository root:

```bash
bash fixtures/replays/lst-lending-contagion-proof/rerun.sh
riptide review .riptide/pack/replay-multi-lst-lending-contagion-proof-upstream
```

The rerun should exit `0` and print a `wrote pack:` line with the
canonical hash above. The review command is expected to exit `1`
because this proof intentionally records invariant firings. The
reviewer signal is in the `Reproducibility` section: canonical hash
matches, hash verification passed, and the pack's `rerun.sh` is
present and parseable.

## Evidence surfaces

| Surface | What to inspect |
| --- | --- |
| [Flagship proof runbook](../fixtures/replays/lst-lending-contagion-proof/README.md) | Local rerun command, review command, bridge explanation, invariant firings, and honest scope. |
| [Evidence packs](pack.md) | Pack shape, canonical hash semantics, repo-relative input/output paths, and rerun script contract. |
| [CI handoff](ci-handoff.md) | Cold GitHub Actions workflow, pinned toolchain setup, canonical-hash assertion, and downstream template. |
| [Reviewer command](reviewer.md) | Read-only pack validation, hash verification, and review exit-code behavior. |
| [Case-study corpus readiness](case-study-corpus.md) | Current demo-ready versus blocked local corpus rows and their boundaries. |
| [Studio](studio.md) | Localhost-only visual review path for workspaces, evidence library, reports, diagrams, dashboard drilldown, and allowlisted jobs. |
| [Audit handoff packet](audit-handoff.md) | Checklist, packet template, reviewer ask, and follow-up issue format. |

The in-repo CI workflow is
[`.github/workflows/contagion-proof-ci.yml`](../.github/workflows/contagion-proof-ci.yml).
It reruns the same proof on a clean runner, asserts the same
canonical hash, and uploads the emitted pack as `contagion-proof-pack`.

## Known limits

- Simulation evidence is not an audit result, formal verification, or
  protocol safety certification.
- The flagship proof is replay-scoped multi-program composition. It is
  not a generalized N-protocol scenario engine and not a forensic
  reproduction of a specific mainnet incident.
- The bridge is scalar observation to scalar oracle write with an
  explicit transform. It is not an arbitrary cross-program transaction
  graph.
- The external case-study corpus currently has two demo-ready rows and
  eight blocked rows; blocked rows keep their adapter, IDL, harness, or
  artifact gaps explicit.
- Studio is a localhost control plane. It is not Cloud, telemetry,
  mainnet monitoring, alerting, or a remote execution service.
- Historical incident fixtures are economic-shape replay evidence with
  named boundaries, not bytecode-level reconstructions.

## What to ask reviewers for

Ask a reviewer to do at least one concrete thing:

- Reproduce the flagship proof from a fresh checkout and compare the
  canonical hash.
- Falsify the bridge, invariant, or input assumptions and explain the
  smallest change that breaks the claim.
- Inspect the emitted pack and CI workflow for trust blockers.
- Run Studio locally against a real workspace and report whether the
  evidence path is understandable without private context.
- Open an issue with the exact command, exit code, expected hash,
  actual hash if different, pack path or artifact, and trust blocker.

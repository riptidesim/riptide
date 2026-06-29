# Vision

**Purpose:** explain Riptide's claim surface and its boundaries.

Riptide makes one strong promise: a declared economic experiment against a Solana program can be rerun, reviewed, and compared byte-for-byte.

It does not promise that the experiment is the right one. That choice remains with the protocol team, auditor, or reviewer.

## Lab, Not Oracle

Riptide runs the experiment the developer picked. It does not discover every bug, certify safety, or infer the full intent of a protocol.

That stance has practical consequences:

- **Inputs are explicit.** Adapter TOML, personas, scenarios, guided-sim parameters, oracle paths, and invariants live on disk.
- **Results are reproducible.** The same committed inputs and the same build produce the same guided-sim artifact.
- **Claims are bounded.** A failing invariant describes one declared run, not a global safety verdict.
- **Review is possible.** The guided-sim artifact carries the run record and rerun recipe needed to challenge the claim.

## Two Paths In

Use Riptide directly when you know the experiment. Bootstrap the workspace,
generate a guided sim against your adapter, run a parameter sweep, build the
cartography artifacts, then assess and review the result:

```bash
cd ~/path/to/your-anchor-program
riptide init
riptide sim generate --adapter .riptide/adapters/<program-name>.toml
riptide sim run .riptide/sim --flows 64 --out .riptide/sim/artifacts/run-001
riptide sim surface .riptide/sim/artifacts/run-001 --sim .riptide/sim
riptide assess .riptide/sim/artifacts/run-001
riptide review .riptide/sim/artifacts/run-001
```

Use the optional skills when you want a first draft:

- `/riptide-config` owns adapter repair, Rust harness setup, starter
  scenarios, and the guided-sim readiness loop in one pass.
- `riptide-narrative` can help summarize an emitted run.

The skills are authoring accelerators. Riptide only needs the plain files they produce.

## Explicit Non-Goals

| Riptide is not... | Boundary |
| --- | --- |
| A validator fork | LiteSVM does not model gossip, voting, PoH, or consensus. Use validator tests when those surfaces matter. |
| A MEV simulator | Personas are deterministic actors, not searchers racing for ordering. |
| A fuzzer | It runs bounded scenarios instead of arbitrary byte generation. |
| A code-certification shortcut | It helps turn economic concerns into evidence, but it does not certify code. |
| A mainnet forecast | It maps modeled conditions; the model is only as good as the declared assumptions. |

## What Good Evidence Looks Like

A strong Riptide claim should include:

- The adapter used for the run.
- The personas and guided-sim parameters.
- The invariant that fired or held.
- The guided-sim artifact for the emitted run.
- A rerun command.
- A short statement of what the run does not prove.

The [Solend-fork case study](case-studies/lending.md) is the canonical example: it maps a whale-share × price-shock region and stops at the mapping claim.

## Related Docs

- [Architecture](architecture.md) for the stack and runtime model.
- [Reviewer command](reviewer.md) for validating a guided-sim artifact as the reviewer handoff.

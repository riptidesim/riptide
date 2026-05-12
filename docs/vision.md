# Vision

**Purpose:** explain Riptide's claim surface and its boundaries.

Riptide makes one strong promise: a declared economic experiment against a Solana program can be rerun, reviewed, and compared byte-for-byte.

It does not promise that the experiment is the right one. That choice remains with the protocol team, auditor, or reviewer.

## Lab, Not Oracle

Riptide runs the experiment the developer picked. It does not discover every bug, certify safety, or infer the full intent of a protocol.

That stance has practical consequences:

- **Inputs are explicit.** Adapter TOML, personas, scenarios, replay state, oracle paths, and invariants live on disk.
- **Results are reproducible.** Same committed inputs and same engine build produce the same canonical artifact.
- **Claims are bounded.** A failing invariant describes one declared run, not a global safety verdict.
- **Review is possible.** Evidence packs include the manifest, trace, rerun recipe, and canonical hash needed to challenge the claim.

## Two Paths In

Use Riptide directly when you know the experiment:

```bash
cd ~/path/to/your-anchor-program
riptide run --adapter .riptide/adapters/<program-name>.toml --serve
```

Use the optional merged skill when you want a first draft:

- `riptide-config` owns adapter repair, Rust harness setup, starter
  scenarios, campaign readiness, and the validation loop in one pass.
- `riptide-narrative` can help summarize an emitted run.

The skills are authoring accelerators. The engine only needs the plain files they produce.

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

- The adapter and lineage block used for the run.
- The personas and scenario parameters.
- The invariant that fired or held.
- The canonical hash of the emitted result.
- A rerun command or evidence pack.
- A short statement of what the run does not prove.

The [Solend-fork case study](case-studies/lending.md) is the canonical example: it maps a whale-share × price-shock region and stops at the mapping claim.

## Related Docs

- [Architecture](architecture.md) for the six-layer stack and runtime model.
- [Evidence packs](pack.md) for the reviewer handoff artifact.
- [CI handoff](ci-handoff.md) for replaying a proof from a fresh GitHub Actions runner.

# Crucible-Inspired Discovery

**Purpose:** capture what Riptide should learn from Crucible without blurring Riptide's reviewer-first claim surface.

Crucible is a Solana coverage-guided fuzzer from Asymmetric Research. The inspected upstream revision was `689e63a2db055c2cae4f8d6dabcfe411ef2c2b55` from `https://github.com/asymmetric-research/crucible`, licensed under MIT.

The license allows reuse, modification, and sublicensing, provided the Crucible copyright and permission notice are preserved in copied substantial portions. Small ideas can be reimplemented normally; direct code copies should carry an attribution comment and, when large enough, a third-party notice entry.

## Product Fit

Riptide should not become a generic byte fuzzer by default. Its strongest claim remains deterministic, declared economic simulation: adapters, personas, scenarios, invariants, replays, campaign results, and evidence packs that reviewers can rerun.

The right fit is a **fuzz-assisted discovery layer** beside guided simulations:

1. Search for interesting action sequences with coverage, state, and invariant feedback.
2. Retain the seed, action sequence, account hashes, coverage summary, and failure reason.
3. Minimize the sequence.
4. Promote the minimized finding into a normal Riptide replay, scenario, campaign cell, or guided-sim artifact.

That keeps fuzzing as a discovery tool and Riptide evidence as the reviewed artifact.

## Ideas To Borrow

| Crucible idea | Riptide fit | Copy/adapt guidance |
| --- | --- | --- |
| `TestContext` builder API for program calls, raw calls, accounts, signers, batching, account reads/writes, time control, and mock oracles | Good fit for `riptide_sim::World`; it would make generated guided sims much less verbose | Reimplement in Riptide style first. Copy only narrow builder mechanics if needed, with MIT attribution. |
| Structured action sequences instead of arbitrary bytes | Good fit for generated guided sims and a future guided discovery command | Adapt the concept: typed flow/action enum, range constraints, deterministic encoding, readable JSON metadata. |
| Sequence and parameter mutators | Good fit once Riptide has typed actions | Reimplement the operations: insert, delete, duplicate, swap, shuffle, truncate, splice, and range-biased numeric mutation. Crucible's implementation is MIT-copyable if that is faster. |
| `#[range(...)]` constraints | Good fit for flow/action parameters and generated account/user indexes | Reimplement in `riptide-sim-macros`; keep constraints visible in generated docs and metadata. |
| Crash metadata, replay, and `tmin` | Excellent fit for guided-sim findings | Implement early. Riptide already retains failing seeds; it should also retain action lists and minimize them. |
| Corpus minimization by greedy set cover | Good fit after coverage exists | Algorithm is small and easy to reimplement; direct copy is acceptable with attribution. |
| Bytecode and source-level LCOV coverage from LiteSVM traces | High value, but dependency-sensitive | Treat as a dedicated milestone. Validate LiteSVM trace API compatibility before copying coverage code. |
| Stateful fuzzing with a coverage-indexed state pool | Valuable but heavy | Later-stage work. It changes execution semantics and memory behavior enough to need its own design and benchmark pass. |
| Coverage/state-aware scheduling | Good fit after coverage and state fingerprints exist | Start simple: prefer seeds that add coverage, trigger new invariant observations, or reach rare action/state paths. |
| Remote fuzzing protocol and pulse output | Useful later | Add only after local artifacts are stable. Riptide's first-class output should remain JSON artifacts and evidence packs. |

## What Not To Copy Wholesale

- Do not import LibAFL as the first step. It would add a large engine dependency before Riptide has its own typed action artifact format.
- Do not copy Crucible's public macro surface verbatim. Riptide should keep `#[riptide_sim]`, `#[flow]`, and generated crate ownership clear.
- Do not make coverage a blanket safety claim. Coverage is diagnostic evidence; it does not mean the modeled economic experiment is sufficient.
- Do not replace adapter campaigns with fuzzing. Campaigns answer "where does this declared risk frontier break?" Fuzzing answers "can the search find a surprising path worth promoting?"

## Roadmap Layers

### Guided-Sim Ergonomics

`World` should keep growing into a compact transaction builder shaped like:

```rust
world
    .program(program_id)
    .instruction(ix)
    .signers(&[user])
    .label("deposit")
    .send()?;
```

Raw instruction helpers, explicit expected-error handling, and
account/time helper parity make generated guided sims less verbose
without changing the public command surface.

### Trace And Review Foundation

Guided-sim artifacts now carry the reproducibility fields needed before
public discovery tooling makes sense:

- ordered flow trace metadata;
- first failure and first failing flow-step pointers;
- seed, transaction labels, and transaction outcomes;
- compact review markdown and JSON summaries;
- an internal replay-by-flow-index hook for tests and future design.

This is evidence plumbing. It helps a reviewer understand how a guided
run reached its result, but it is not a minimizer, corpus, scheduler, or
public replay feature.

### Replay And Minimization

Public replay and minimization should stay deferred until the artifact
format can represent a full action sequence, not only the selected flow
indexes. The next design step is a reviewed JSON shape for retained
action lists, per-action RNG draws, and minimized output. Only after that
should Riptide expose local commands for replaying or shrinking guided
findings.

### Structured Guided Discovery

Introduce typed actions for guided sims:

```rust
#[action]
fn deposit(&mut self, #[range(1..1_000_000)] amount: u64) -> Result<()>;
```

Generated metadata should describe each action, parameter type, range,
and signer/account assumptions. The runner can then search over a
`Vec<Action>` instead of just choosing weighted `#[flow]` methods
independently.

### Coverage Output

Enable `sim.coverage.enabled = true` only when the runner can emit a real artifact:

- bytecode-level edge summary;
- optional LCOV file;
- optional source mapping when a matching debug binary is provided;
- coverage summary embedded in `guided-sim-run.json` and `riptide review`.

This removes the current guided-sim coverage guarded gap while keeping the claim honest.

### Corpus And Scheduling

Add corpus input/output directories, then schedule actions by:

- new edge coverage;
- new invariant-observation states;
- rare action n-grams;
- successful state transitions;
- minimized corpus preservation.

This can start without LibAFL. LibAFL becomes attractive only if Riptide's local structured runner hits scheduler or multicore limits.

### Stateful Pool

Add state-pool fuzzing only after the stateless structured runner has stable artifacts. A state pool needs bounded memory, state fingerprints, eviction policy, parent-chain reconstruction, and clear review output for the path that produced a finding.

## Near-Term Work Items

1. Update guided-sim generation so `main.rs` can dispatch multiple generated action methods, not only one `guided_flow`.
2. Continue expanding the `riptide_sim::World` builder API where it removes real guided-flow boilerplate.
3. Extend trace metadata from selected flow indexes to typed action sequences when the generated action model exists.
4. Harden the internal replay-by-sequence hook before exposing a user-facing replay workflow.
5. Design minimization artifacts before exposing a minimization workflow.
6. Add typed action metadata and range constraints.
7. Add coverage artifact support behind the existing `sim.coverage` manifest flag.
8. Promote minimized findings into replay/campaign artifacts so they enter normal Riptide review.

## Claim Boundary

When this lands, the user-facing language should be:

> Riptide can use fuzz-inspired search to discover candidate failure paths, then turn them into deterministic evidence.

It should not be:

> Riptide proves your program safe because fuzzing found no crash.

That distinction is the difference between useful discovery and an overclaimed audit substitute.

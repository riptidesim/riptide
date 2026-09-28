# Guided simulations

**Audience:** contributors to the Engine and the Skill. Users never read or
edit a guided simulation: the `/riptide-assess` Skill authors it as an
Internal Artifact in the Workspace and drives the Engine over it (see
[ADR 0001](adr/0001-skill-is-the-only-user-surface.md) and the glossary in
[`CONTEXT.md`](../CONTEXT.md)).

A guided simulation is a Rust crate under `.riptide/sim/`. The support claim
is deliberately bounded: the Engine runs a guided simulation correctly when
`.riptide/sim/Riptide.toml` and the crate's flow, invariant and service code
are correct. It does not infer every protocol flow, model every oracle
layout, prove complete Coverage or provide audit signoff.

A guided simulation owns its pre-tick-0 setup: it bootstraps external
programs and account snapshots through `Riptide.toml`, then owns dynamic
behaviour: multi-instruction transactions, computed `remaining_accounts`,
target-vs-agent selection, and local services such as oracle or orderbook
models.

## Support boundary

| Surface | Current claim | Boundary |
|---------|---------------|----------|
| Project-owned flows and services | Supported | Protocol behavior is Rust under `src/flows.rs`, `src/invariants.rs`, and `src/services/`. Riptide does not infer meaningful flows from source. |
| Dependency programs | Supported for local `.so` files | Generic local programs are declared in `Riptide.toml`. Protocol-specific dependency behavior belongs in project code. |
| Local account snapshots | Supported | Base64 account snapshots are declared in `Riptide.toml`. Snapshot bytes and owner/layout assumptions are the project's responsibility. |
| Account-snapshot fork/cache | Supported as explicit account snapshots | This is not a live validator fork. Cached snapshots include provenance and data hashes; cached runs stay offline unless deliberately refreshed. |
| Dynamic `remaining_accounts` and multi-instruction transactions | Supported in project-owned Rust | Generated builders expose hooks, but the project chooses accounts, ordering, signers, and flow logic. |
| Account mutation and local services | Supported in project-owned Rust | Services can mutate generic SVM accounts through `World`; Riptide core does not contain Pyth, Switchboard, OpenBook, Drift, Mango, Marinade, Whirlpool, or similar layouts. |
| Metrics, regression, and artifacts | Supported for guided runs | `sim run --out <dir>` writes stable JSON with seeds, flow counts, tx outcomes, compute units, service ticks, failing seed, selected account hashes, and a reviewer rerun script. |
| Coverage | Guarded gap | LiteSVM binary loading does not emit local guided-run coverage yet. `sim.coverage.enabled = true` fails lint until an entrypoint/binary coverage collector exists. |
| Review integration | Supported for guided artifacts | `review <artifact-dir>` reads `guided-sim-run.json`, validates `rerun.sh` when present, and summarizes flow counts, transaction labels, failure reason, retained seed, and rerun command. |
| Cartography / assessment | Supported | `sim surface` turns a guided-sim parameter sweep into a risk surface, and `assess` renders the Engine Output from it. |
| Audit-equivalent or automatic universal fuzzing | Out of scope | A green guided simulation is simulation evidence for the declared setup, not an audit result or complete coverage proof. |

## The generated crate

`sim generate --adapter <adapter.toml>` writes the crate from an IDL-backed
adapter. By default it lands at `.riptide/sim/`:

```text
.riptide/sim/
├── Cargo.toml
├── Riptide.toml
└── src/
    ├── main.rs
    ├── types.rs
    ├── accounts.rs
    ├── flows.rs
    ├── invariants.rs
    ├── violations.rs
    └── services/
```

`types.rs` contains generated typed builders from the adapter IDL.
`accounts.rs` contains generated address-storage fields from the
adapter's `[accounts.*]` entries. Treat both files as regenerated code.

The crate depends on the `riptide-sim` runtime. From a Riptide source
checkout, the generator writes live path dependencies into the checkout
so runtime changes are picked up without regenerating. From an
installed CLI, it copies the runtime crates into `.riptide/sim/vendor/`
and writes relative path dependencies, so the crate is self-contained:
it builds with only Rust and Cargo present, can be committed alongside
the user's program, and survives Engine upgrades. The vendored copy is refreshed
on every full `sim generate`.

Protocol behaviour lives in `flows.rs`, invariant checks in
`invariants.rs`, the violation each invariant's Firing Check injects in
`violations.rs`, and project-local mocks in `services/`.

## Bootstrap external state

`Riptide.toml` is applied before `flows::init`. Use it for external
dependencies that are generic to the SVM rather than specific to one
oracle protocol:

```toml
[[sim.programs]]
address = "So11111111111111111111111111111111111111112"
program = "../target/deploy/dependency.so"
loader = "direct"

[[sim.accounts]]
address = "11111111111111111111111111111111"
filename = "fixtures/accounts/dependency-account.json"

[[sim.fork]]
address = "SysvarC1ock11111111111111111111111111111111"
cluster = "mainnet"
filename = "fork-cache/mainnet/dependency-account.json"
overwrite = false

[sim.metrics]
enabled = false
filename = "artifacts/guided-sim-metrics.json"

[sim.regression]
enabled = false
accounts = []
state_hashes = []

[sim.coverage]
enabled = false
```

Forking is account-snapshot forking, not a live validator fork. The
first run fetches a base64 account snapshot from the declared RPC and
caches it; later runs reuse the cache unless `overwrite = true`.
Snapshots record address, owner, executable flag, data hash,
cluster/RPC, fetched slot when RPC returns one, and local filename. If a
forked account is an upgradeable loader program account, Riptide also
loads the paired program-data account from cache or fetches it to a
sibling cache file. If the pair cannot be loaded, the error names the
program-data account and says to cache it locally or fall back to a
direct local `.so`.
Protocol-specific updates, such as advancing an oracle price or
orderbook state between flows, belong in `src/services/` and can write
accounts through `World::set_account`.

`sim lint` validates the manifest before the crate runs. It resolves paths relative to `Riptide.toml`, validates local
program and account snapshot files, checks Solana pubkeys, rejects bad
base64 account data, catches duplicate bootstrap addresses, verifies
cached snapshot `pubkey` values against the manifest address, and fails
unsupported loader declarations. It does not build programs, fetch RPC
accounts, or run the simulation.

Schema reference:

| Section | Fields | Notes |
|---------|--------|-------|
| `[[sim.programs]]` | `address`, `program`, `loader` | `program` is a local `.so`. `address` is optional only when loading the primary program from the sibling keypair. `loader` defaults to `direct`; other loader declarations fail lint. |
| `[[sim.accounts]]` | `address`, `filename` | `filename` points to a base64 account snapshot. Top-level snapshot `pubkey`, when present, must match `address`. |
| `[[sim.fork]]` | `address`, `cluster`, `filename`, `overwrite` | `cluster` accepts `mainnet`, `m`, `devnet`, `d`, `testnet`, `t`, or a custom RPC URL. Missing cache files warn because the first run may fetch them. |
| `[sim.metrics]` | `enabled`, `filename` | Enables guided-run metrics in the JSON artifact. `sim run --out <dir>` chooses a stable directory; `filename` lets the manifest choose the JSON file path. |
| `[sim.regression]` | `enabled`, `accounts`, `state_hashes` | Hashes selected accounts in the JSON artifact. Accounts must be valid pubkeys; duplicate regression accounts fail lint. |
| `[sim.coverage]` | `enabled` | Coverage is declared but unavailable here. `enabled = true` fails lint until guided runs emit coverage output. |

When a transaction is supposed to be rejected, use
`world.process_transaction_expect_error(...)` and assert against the
returned `TxOutcome`. Use `world.process_transaction(...)` or
`world.process_transaction_expect_success(...)` when rejection should
fail the simulation.

`World` exposes the generic LiteSVM controls used by guided services:
`get_sysvar`, `set_sysvar`, `clock`, `set_clock`, slot/epoch/timestamp
warp helpers, deterministic `advance_clock`, direct dependency program
loading, raw `get_account` / `set_account` / `mutate_account`, and Borsh
read/write helpers. `svm()` and `svm_mut()` remain the final escape hatch
when LiteSVM exposes something Riptide does not wrap.

## Run artifacts

`sim fork` creates or refreshes an explicit account cache, and `sim run`
builds and runs the crate over the declared sweep.

The generated binary prints the iteration seed before each run and, when
`--out` is present, writes `guided-sim-run.json` plus a POSIX-parseable
`rerun.sh`. The artifact includes the base seed, per-iteration derived
seeds, flow counts, labelled transaction outcomes, compute units,
expected-error counts, service tick count, regression account hashes when
enabled, and the retained failing seed.

The artifact also carries additive ordered trace metadata. Root
`trace_schema_version` labels the trace shape without replacing
`schema_version`. Each iteration has `flow_trace`, an ordered list of
flow steps with:

- `step_index`, `flow_index`, and `flow_name`
- `tx_log_start` and `tx_log_end` offsets into that iteration's
  `tx_outcomes` array
- `service_ticks_before` and `service_ticks_after`
- `status`: `passed`, `returned_error`, or `panic`
- `expected_errors` and `unexpected_errors` for the transaction outcomes
  in that step's offset range
- `failure_message`, which is `null` for passed steps

Passed iterations set `first_failure` and `first_failing_flow_step` to
`null`. Failed iterations set `first_failure` to the first failed stage
with status, tx-log offsets, service-tick offsets, and a failure
message. When the failure happened inside a flow step,
`first_failing_flow_step` copies that non-passed trace entry; failures
from `init`, flow selection, `end`, or regression hashing keep
`first_failing_flow_step` null so the artifact does not misattribute a
non-flow failure to a flow. These fields are additive: older
`guided-sim-run.json` artifacts that only have `schema_version`,
`flow_counts`, `tx_outcomes`, `totals`, and `retained_failing_seed`
remain valid review inputs.

`review` reads a run's artifact directory cold. It does not rerun the
simulation, execute `rerun.sh`, or claim exhaustive coverage. It summarizes the
retained failing seed, flow table, compact flow trace, labelled
transaction outcomes, failure reason, first failing flow step when one is
present, and rerun command so another reviewer can decide whether to
rerun or inspect the Rust flow/service code.

Trace-bearing artifacts get a small `Flow Trace` table that reports step
counts, status counts, a flow-name preview, transaction-log offsets, and
expected/unexpected error counts. Older artifacts that do not have trace
fields still review normally; review output marks them as legacy trace
inputs and falls back to `flow_counts` and `tx_outcomes`. JSON review
payloads include stable `trace_summary`, `first_failure`, and
`first_failing_flow_step` fields for downstream tooling.

`sim debug --seed <hex>` replays one retained seed with verbose labelled
transaction logging; the Skill writes each Breach's Causal Trace from it.

## Refresh generated files

After an IDL or adapter account-list change, `sim refresh` regenerates
only the generated files. It replaces `types.rs` and `accounts.rs` and
preserves `flows.rs`, `invariants.rs`, `violations.rs`, `types_ext.rs`, and
`services/`. `types_ext.rs` holds hand-written builders or IDL type overrides
that must survive refresh. `--force-generated` also replaces the
project-owned files, for a clean slate.

## From a sweep to Engine Output

One `sim run` produces one guided-sim artifact over the `[sim.sweep]` region.
`sim surface` reads that run plus the `[sim.sweep]` block in `Riptide.toml`
and writes the cartography artifacts (`risk-surface.json`,
`campaign-summary.json`, `retention-manifest.json`) into the assess root.
`assess` then renders the byte-deterministic Engine Output from them, which
the Skill composes with its Assessment Context (see
[ADR 0002](adr/0002-deterministic-engine-output-vs-agent-context.md)).

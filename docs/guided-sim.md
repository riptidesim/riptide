# Guided simulations

Guided simulations are project-owned Rust crates under `.riptide/sim/`.
Use them when the adapter and setup harness aren't expressive enough for
the protocol flow you need to test.

The public support claim is deliberately bounded: Riptide provides
Trident-class guided simulation support when the project supplies correct
`.riptide/sim/Riptide.toml` configuration and project-owned Rust flow,
invariant, and service code. This means Riptide can run the same class of
manual setups that external-account Solana fuzzers rely on; it does not
mean Riptide automatically infers every protocol flow, models every
oracle layout, proves complete coverage, or provides audit signoff.

The harness still owns pre-tick-0 setup for adapter/campaign runs.
Guided simulations can bootstrap their own external programs and account
snapshots through `Riptide.toml`, then own dynamic behavior:
multi-instruction transactions, computed `remaining_accounts`,
target-vs-agent selection, and local services such as oracle or
orderbook models.

## Support boundary

| Surface | Current claim | Boundary |
|---------|---------------|----------|
| Project-owned flows and services | Supported | Write protocol behavior in Rust under `src/flows.rs`, `src/invariants.rs`, and `src/services/`. Riptide does not infer meaningful flows from source. |
| Dependency programs | Supported for local `.so` files | Declare generic local programs in `Riptide.toml`. Protocol-specific dependency behavior belongs in project code. |
| Local account snapshots | Supported | Declare base64 account snapshots in `Riptide.toml`. Snapshot bytes and owner/layout assumptions are the project's responsibility. |
| Account-snapshot fork/cache | Supported as explicit account snapshots | This is not a live validator fork. Cached snapshots must be pinned and rerun offline unless deliberately refreshed. |
| Dynamic `remaining_accounts` and multi-instruction transactions | Supported in project-owned Rust | Generated builders expose hooks, but the project chooses accounts, ordering, signers, and flow logic. |
| Account mutation and local services | Supported in project-owned Rust | Services can mutate generic SVM accounts through `World`; Riptide core does not contain Pyth, Switchboard, OpenBook, Drift, Mango, Marinade, Whirlpool, or similar layouts. |
| Metrics, regression, artifacts, and coverage | Partial / guarded | Basic run output exists. Machine-readable guided-sim evidence and coverage are separate capabilities and must not be claimed unless the local run emits them. |
| Campaign and review integration | Partial / separate | Adapter campaigns and evidence packs remain distinct from guided sims unless a guided-sim artifact/review path is explicitly used. |
| Audit-equivalent or automatic universal fuzzing | Out of scope | A green guided simulation is simulation evidence for the declared setup, not an audit result or complete coverage proof. |

## Generate the crate

Run the generator against an IDL-backed generic adapter:

```bash
riptide sim generate --adapter .riptide/adapters/<program>.toml
```

By default, the crate lands at `.riptide/sim/`:

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
    └── services/
```

`types.rs` contains generated typed builders from the adapter IDL.
`accounts.rs` contains generated address-storage fields from the
adapter's `[accounts.*]` entries. Treat both files as regenerated code.

Write protocol behavior in `flows.rs`, invariant checks in
`invariants.rs`, and project-local mocks in `services/`.

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
Protocol-specific updates, such as advancing an oracle price or
orderbook state between flows, belong in `src/services/` and can write
accounts through `World::set_account`.

Validate the manifest before running the crate:

```bash
riptide sim lint .riptide/sim
```

The linter resolves paths relative to `Riptide.toml`, validates local
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
| `[sim.metrics]` | `enabled`, `filename` | Guarded declaration. `enabled = true` fails lint until guided runs emit metrics artifacts. |
| `[sim.regression]` | `enabled`, `accounts`, `state_hashes` | Guarded declaration. Accounts must be valid pubkeys; duplicate regression accounts fail lint; `enabled = true` fails until guided runs emit regression hashes. |
| `[sim.coverage]` | `enabled` | Coverage is declared but unavailable here. `enabled = true` fails lint until guided runs emit coverage output. |

When a transaction is supposed to be rejected, use
`world.process_transaction_expect_error(...)` and assert against the
returned `TxOutcome`. Use `world.process_transaction(...)` or
`world.process_transaction_expect_success(...)` when rejection should
fail the simulation.

## Run the simulation

Use `riptide sim run` from the repo root:

```bash
riptide sim run .riptide/sim --iterations 5 --flows 20 --seed deadbeef
```

The generated binary prints the iteration seed before each run. Reuse
that seed with `riptide sim debug` to dump labelled transaction outcomes:

```bash
riptide sim debug .riptide/sim --seed deadbeef
```

## Refresh generated files

After an IDL or adapter account-list change, refresh only generated
files:

```bash
riptide sim refresh --adapter .riptide/adapters/<program>.toml --dir .riptide/sim
```

This replaces `types.rs` and `accounts.rs` and preserves `flows.rs`,
`invariants.rs`, and `services/`. Use the `--force-generated` flag only
when you intentionally want a clean slate for user-owned files too.

## When not to use it

Use the adapter and harness path when the protocol fits static action
dispatch and deterministic setup. Guided simulations are for flows that
need Rust code during the action loop; they don't replace campaign
runs, scenario presets, or evidence packs.

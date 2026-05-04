# Guided simulations

Guided simulations are project-owned Rust crates under `.riptide/sim/`.
Use them when the adapter and setup harness aren't expressive enough for
the protocol flow you need to test.

The harness still owns pre-tick-0 setup for adapter/campaign runs.
Guided simulations can bootstrap their own external programs and account
snapshots through `Riptide.toml`, then own dynamic behavior:
multi-instruction transactions, computed `remaining_accounts`,
target-vs-agent selection, and local services such as oracle or
orderbook models.

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
address = "11111111111111111111111111111111"
program = "../target/deploy/dependency.so"

[[sim.accounts]]
address = "11111111111111111111111111111111"
filename = "fixtures/accounts/dependency-account.json"

[[sim.fork]]
address = "11111111111111111111111111111111"
cluster = "mainnet"
filename = "fork-cache/mainnet/dependency-account.json"
overwrite = false
```

Forking is account-snapshot forking, not a live validator fork. The
first run fetches a base64 account snapshot from the declared RPC and
caches it; later runs reuse the cache unless `overwrite = true`.
Protocol-specific updates, such as advancing an oracle price or
orderbook state between flows, belong in `src/services/` and can write
accounts through `World::set_account`.

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

# Adapter lineage

Adapter TOMLs can declare an optional `[lineage]` block that names the
IDL the adapter was authored against, the generator that produced it
(or `hand-authored`), the inferred assumptions the author made that
are not literally in the IDL, and the IDL fields the adapter
intentionally does not model. The top-level `riptide lineage
<adapter>` command prints the block in a reviewer-readable format.

**Simulation evidence, not audit signoff.** Lineage is an authored
declaration — a reviewer reads it to understand what the adapter
*claims* to model. It is not an automated check of the adapter against
the IDL.

## Block shape

```toml
[lineage]
idl_source = "fixtures/idls/liquid-staking-fork.json"
generator  = "hand-authored"
inferred_assumptions = [
  "`protocol = \"generic\"` instead of `Protocol::LiquidStaking` — classification reads instruction/observation names, so the dedicated variant would be cosmetic.",
  "`initialize_pool` is not mapped as a runtime action; the processor lazy-inits the pool on first touch at a 1:1 exchange rate.",
]
unsupported_fields = [
  "instruction `initialize_pool(initial_exchange_rate_bps)` — admin setup, handled by lazy init",
  "account `pool.admin` / `pool.oracle` / `pool.is_initialized` — pubkey/bool metadata, not persona-observable",
]
```

All four fields are optional. A block with only `idl_source` and
`generator` set is a valid minimum surface — missing fields render as
empty bullet lists under their headings.

### Field semantics

- **`idl_source`** — the repo-relative path to a committed IDL file
  (`fixtures/idls/*.json`) or, for primitives without a distinct IDL,
  a path to the program's Rust source of record (e.g.
  `programs/lending_pool/src/state.rs`). Riptide does **not** fetch
  IDLs at run time; the value is an inspection pointer, not a dynamic
  fetch target.
- **`generator`** — one of `hand-authored`, `riptide-adapt`, a pinned
  identifier such as `riptide-adapt@<git-sha>`, or any string a
  reviewer can trace back to a specific authoring pass. Free-form.
- **`inferred_assumptions`** — a list of short human-readable strings.
  Each entry names one decision the author made that is not
  forced by the IDL: simplifications, protocol classification,
  unmapped admin instructions, oracle binding choices, invariant
  thresholds derived from the author's reading rather than a spec.
- **`unsupported_fields`** — a list of IDL fields the adapter
  intentionally does not model. Each entry should name the field and
  briefly explain why (admin-only, zero-arg metadata, sweep dimension
  lives in scenarios, etc.).

Both list-valued fields accept up to 1024 bytes per entry. Multi-clause
entries with em-dashes and parenthetical detail are expected and
encouraged — one honest multi-clause entry beats two vague ones.

## Inspection command

```sh
riptide lineage <adapter>
```

The `<adapter>` argument resolves two ways: as a short name (e.g.
`solend-fork`), the command loads
`fixtures/adapters/<adapter>.toml` relative to the monorepo root
(override via `$RIPTIDE_FIXTURES_ROOT`); as a path containing `/`,
the platform separator, or a `.toml` suffix, the command loads the
file directly.

The command prints the block as reviewer-readable sections (headings,
bulleted assumptions, bulleted unsupported fields, IDL source path)
and exits 0. On an adapter without a `[lineage]` block, it prints
`no lineage recorded for <adapter-name>; pre-dates the lineage
surface` and exits 0 — explicit silence, never a false claim.

An adapter file that cannot be parsed (unknown name, missing TOML
file, malformed content) exits 2 with a diagnostic.

## Shipping lineage blocks

Four protocol-class adapters carry hand-reviewed `[lineage]` blocks:

- [`fixtures/adapters/solend-fork.toml`](../fixtures/adapters/solend-fork.toml)
- [`fixtures/adapters/perps-fork.toml`](../fixtures/adapters/perps-fork.toml)
- [`fixtures/adapters/amm-fork.toml`](../fixtures/adapters/amm-fork.toml)
- [`fixtures/adapters/liquid-staking-fork.toml`](../fixtures/adapters/liquid-staking-fork.toml)

The generic `resource-grinder` adapter ships without a block on
purpose — it exercises the `no lineage recorded` path end-to-end.

## Honest scope

- **Inspection only.** `riptide lineage` does not fetch IDLs, does not
  validate the adapter against the IDL, and does not generate lineage
  automatically. The block is an authored declaration a reviewer
  reads, not a machine-derived proof of coverage.
- **No run-time dependency.** Lineage metadata is serialized in the
  adapter TOML and read only by the `riptide lineage` command (and,
  in a future release, by an adapter linter). The engine does not
  consume it on a run — adapters without lineage blocks load and run
  exactly as they did before the surface existed.
- **Accuracy is load-bearing.** An `inferred_assumptions` list that
  lies is worse than silence. Each entry must be reviewable against
  the actual adapter and the committed IDL; when an assumption stops
  being true, the block must be updated (or removed) in the same PR
  that changes the adapter.
- **Not yet covered.** IDL-vs-adapter coverage validation is deferred
  (an adapter linter that reads the IDL + the lineage block and flags
  drift is the next surface in this area). Auto-generation of lineage
  from a program-id or a remote IDL fetch is not in scope. Lineage
  blocks are hand-authored today.

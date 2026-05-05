# Adapter lineage

Adapter TOMLs can declare an optional `[lineage]` block that names the
IDL the adapter was authored against, the generator that produced it
(or `hand-authored`), the inferred assumptions the author made that
are not literally in the IDL, and the IDL fields the adapter
intentionally does not model. The top-level `riptide lineage
<adapter>` command prints the block in a reviewer-readable format;
the top-level `riptide lint <adapter>` command machine-validates the
adapter against the IDL **when the source is a JSON IDL** (see
[Machine validation — `riptide lint`](#machine-validation--riptide-lint)
below).

**Simulation evidence, not audit signoff.** Lineage is an authored
declaration — a reviewer reads it to understand what the adapter
*claims* to model. `riptide lint` raises the bar to a machine check
for JSON-IDL sources — but it does not fetch IDLs, does not generate
lineage, and does not promise full semantic coverage.

## Block shape

```toml
[lineage]
idl_source = "fixtures/idls/liquid-staking.json"
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
- **`generator`** — one of `hand-authored`, `riptide-config`, a pinned
  identifier such as `riptide-config@<git-sha>`, or any string a
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
`lending`), the command loads
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

Five protocol-class adapters carry hand-reviewed `[lineage]` blocks:

- [`fixtures/adapters/lending.toml`](../fixtures/adapters/lending.toml)
- [`fixtures/adapters/perpetuals.toml`](../fixtures/adapters/perpetuals.toml)
- [`fixtures/adapters/amm.toml`](../fixtures/adapters/amm.toml)
- [`fixtures/adapters/liquid-staking.toml`](../fixtures/adapters/liquid-staking.toml)
- [`fixtures/adapters/stablecoin.toml`](../fixtures/adapters/stablecoin.toml)

The generic `resource-grinder` adapter ships without a block on
purpose — it exercises the `no lineage recorded` path end-to-end.

## Machine validation — `riptide lint`

```sh
riptide lint <adapter>
```

`riptide lint` reads the adapter TOML, classifies `[lineage].idl_source`,
and — when the source is a **JSON IDL** — cross-checks every
adapter-mapped instruction, arg, account, and dotted `account.field`
reference against the IDL's declared surface.

- **JSON IDL** (`fixtures/idls/<name>.json`): machine-checked. Every
  `[instructions].*`, `[[scheduled_actions]].*.instruction`,
  `[accounts].*`, `[state_mapping]."account.field"`,
  `[observations]."account.field"`, and `[[invariants]].*.field` that
  dereferences a dotted `account.field` is resolved against the IDL.
  Positive mismatches fail with `exit 2`, naming the adapter file,
  the missing symbol, and the list of valid candidates. Uncovered
  source surfaces (IDL instructions or `account.field` entries the
  adapter neither maps nor names in `[lineage].unsupported_fields`)
  surface as warnings (`exit 1`) with a next-step hint; an adapter
  can silence a warning either by mapping the surface or by naming
  it explicitly in `[lineage].unsupported_fields`.
- **Non-JSON source** (for example a Rust source-of-record path like
  `programs/lending_pool/src/state.rs`): explicit `WARN` with `exit
  1` and no false PASS. The linter does **not** ship a Rust parser
  today. `lending` is the canonical warn-only case.
- **Missing `[lineage]` block**: explicit `SKIP` with `exit 0`. There
  is nothing to machine-check; `riptide doctor` additionally lands
  this on its WARN surface at the report level so a
  downstream-installed CLI flags the gap without failing.

`riptide adapt` runs the same analyzer as a preflight: when the
adapter's lineage source is machine-checkable (JSON IDL), adapt
lint-checks before spawning the engine and aborts on any concrete
fail; lineage-warn and lineage-skip cases continue through to the
smoke test so non-machine-checkable adapters still smoke end-to-end.

`riptide doctor` aggregates per-adapter lint status into a single
summary table across every discovered adapter. It never rebuilds
programs, never fetches IDLs, and never runs a simulation — it is a
static diagnostic only.

## Honest scope

- **Inspection and positive machine validation, nothing beyond.**
  `riptide lineage` prints the authored block reviewer-readably.
  `riptide lint` machine-validates JSON-IDL-backed adapters; it does
  not fetch IDLs, does not generate lineage, does not auto-fix
  adapters, and does not promise full semantic coverage. Non-JSON
  lineage sources warn honestly; missing blocks skip.
- **No run-time dependency.** Lineage metadata is serialized in the
  adapter TOML and read only by `riptide lineage`, `riptide lint`,
  and `riptide doctor`. The engine does not consume it on a run —
  adapters without lineage blocks load and run exactly as they did
  before the surface existed.
- **Accuracy is load-bearing.** An `inferred_assumptions` list that
  lies is worse than silence. Each entry must be reviewable against
  the actual adapter and the committed IDL; when an assumption stops
  being true, the block must be updated (or removed) in the same PR
  that changes the adapter. The linter catches the "field no longer
  in the IDL" class of drift automatically for JSON-IDL-backed
  adapters; the rest (assumptions, intentional unsupported-field
  prose) still relies on honest human review.
- **Not yet covered.** Machine validation of non-JSON lineage sources
  (Rust source of record for adapters like `lending`) is not in
  scope — those stay inspection-only and warn. Auto-generation of
  lineage from a program-id, remote IDL fetch, LSP / editor tooling,
  and adapter-diff CLI are all out of scope. Lineage blocks are
  hand-authored today.

## Economic semantics complements lineage

Lineage is one half of the per-adapter reviewer surface. The other
half is **economic semantics**: a declarative `[semantics]` block inside
the adapter that maps raw fields to protocol-class concepts (collateral
value, debt, health, redemption pressure, margin) under versioned classes
(`lending.v1`, `perps-margin.v1`, `amm.v1`, `lst.v1`, `stablecoin.v1`)
with named roles, derived observations, expression invariants, and
protocol-specific extensions.

**Semantics complements lineage; it does not replace it.** They answer
different reviewer questions:

- **Lineage** answers *where the adapter came from*: source, IDL,
  generator, hand-authored vs auto-generated, inferred assumptions,
  intentionally unsupported fields. It is the provenance record for
  the adapter as a wiring artifact.
- **Semantics** answers *what the program's fields mean economically*:
  which account field is the collateral, which is the debt, which
  oracle the position is priced against, what derived value
  (`collateral_value`, `health`, `bad_debt`) the invariants should
  evaluate against. It is the economic-meaning record on top of the
  raw field bindings.

Both blocks ship on the protocol-class fixture adapters today. Removing
one does not subsume the other; a future Solend / Kamino / Loopscale
integration should declare both — lineage to record the IDL and authoring
trail, semantics to declare the `lending.v1` role mappings and any
protocol-specific extensions.

**Status:** `[semantics]` blocks are authorable today and the engine
emits their class, bound roles, derived observations, collections, and
expression-invariant results in simulation output. `riptide explain`
renders the parsed semantics block, while `riptide lint`, `riptide
adapt`, and `riptide doctor` use the existing lineage and adapter
surfaces to keep the raw wiring honest.

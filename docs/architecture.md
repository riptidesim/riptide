# Architecture

**Purpose:** How Riptide is assembled — the six-layer stack, the LiteSVM runtime, and the determinism model.

**Audience:** adapter authors, contributors, and reviewers who need to understand the engine's shape before reading code.

Riptide runs on two processes: a Rust engine (`engine/`) that drives the simulation, and a TypeScript CLI (`cli/`) that compiles personas, pre-validates inputs, orchestrates runs, and serves the dashboard. Every claim the engine makes is declared in TOML on disk, so nothing about a run is carried only in a binary.

## The six-layer stack

Each bundle layers six declarative surfaces on top of your program. All six live in files under `fixtures/`; none require editing engine code.

```mermaid
flowchart TB
    P(["Your Solana Program<br>BPF .so + IDL"])

    subgraph Stack["Six-Layer Stack — all declarative TOML"]
        direction TB
        L1["1. Adapter<br><small>program wiring: accounts, actions,<br>observations, invariants</small>"]
        L2["2. Personas<br><small>agent behavior via trigger DSL</small>"]
        L3["3. Scenarios<br><small>engine shocks: oracle trajectories,<br>scheduled actions</small>"]
        L4["4. Parameters<br><small>run-config knobs that sweep dimensions</small>"]
        L5["5. Failure-mode taxonomy<br><small>named categories the riptide-scenarios<br>skill matches against</small>"]
        L6["6. Invariants<br><small>machine-checkable properties<br>in the adapter</small>"]
    end

    P --> Stack
    Stack --> R["Riptide Engine<br>+ LiteSVM"]
    R --> O["simulation-result.json<br>byte-deterministic"]
```

1. **Adapter** — one TOML under `fixtures/adapters/` declaring your program, its actions, its observations, and its invariants. Examples: `lending.toml`, `perpetuals.toml`, `amm.toml`, `liquid-staking.toml`, `stablecoin.toml`, `resource-grinder.toml`.
2. **Personas** — TOML under `fixtures/personas/` describing agent behavior with a trigger DSL (`player.gold < 100 → craft`). Each bundle ships a persona library the scenarios skill can compose from.
3. **Scenarios** — engine shocks (oracle trajectories, scheduled actions) mounted from declarative presets. See `fixtures/scenarios/` and `engine/src/scenario/preset_spec.rs`.
4. **Parameters** — run-config knobs that sweep over the dimensions that matter: whale share, shock magnitude, trade size, leverage, depositor concentration.
5. **Failure-mode taxonomy** — categories like `whale_concentration`, `margin_cascade_from_oracle_shock`, `price_manipulation_via_swap`, `impermanent_loss_spike`. The `riptide-scenarios` skill matches your adapter's shape against this taxonomy.
6. **Invariants** — machine-checkable properties (`no_bad_debt`, `reserve_a > 0`, `k == reserve_a * reserve_b` within tolerance) declared inline in the adapter. The engine exits non-zero when any invariant fires, so invariants double as CI gates.

Five shipping protocol-class bundles exercise every layer end-to-end: **lending** (Solend fork), **perps** (perps-lite), **AMM** (constant-product), **liquid staking** (`liquid-staking` — a minimal pooled-stake / withdrawal-queue surface, not a fork of any real LST codebase), and **stablecoin** (`stablecoin` — a minimal collateral / stable-supply / reserve-buffer / redemption-queue surface with one admin-gated `apply_hedge_loss` stress mutation, not a fork of any real stablecoin codebase). A sixth generic bundle (`resource-grinder`) drives a non-DeFi SBF program end-to-end — if it runs, you can wire Riptide to your protocol.

The liquid-staking bundle ships two named rerunnable single-program proof artifacts at `fixtures/replays/liquid-staking-depeg-redemption-run/` and `fixtures/replays/liquid-staking-slash-with-open-queue/` — depeg + withdrawal-run pressure replays against the minimal fork, historical inspiration: the 2024 Kelp / rsETH depeg. Framed explicitly as **simulation evidence**, not audit signoff. See the bundle-local READMEs for the load-bearing invariant firings, rerun commands, and what the proofs do and do not prove.

The stablecoin bundle ships one named rerunnable single-program proof artifact at `fixtures/replays/stablecoin-uxd-style-collateral-cascade/` — a UXD-style collateral-cascade + redemption-run pressure replay against the minimal `stablecoin`, historical inspiration: the November 2022 UXD delta-neutral backing gap after the Mango exploit wiped the hedge leg. The proof is explicitly framed as **UXD-style pressure geometry** rather than a literal UXD replay: the hedge-gap is internalized as an admin-gated program-local `apply_hedge_loss` mutation, not a cross-program stablecoin ↔ perps-venue composition. Three declared adapter invariants fire at named ticks (`no_hedge_loss_during_healthy_run` @ T3, `full_backing` @ T3, `no_redemption_queue_formation` @ T4). The proof's regression hash is pinned by `engine/tests/replay_stablecoin_uxd_style_collateral_cascade.rs`.

One **cross-protocol contagion proof** also ships at `fixtures/replays/lst-lending-contagion-proof/` — upstream liquid-staking slash propagates through one declared scalar-observation → scalar-oracle-write bridge into a downstream lending oracle inside a single deterministic replay, realizing a machine-checkable bad-debt firing that attributes to the upstream shock. This is a **replay-scoped multi-program proof** of contagion, not a generalized N-protocol scenario engine or an audit artifact — see the bundle-local README for the bridge description, per-tick trace, and honest scope notes. The proof's regression hash is pinned by `engine/tests/replay_lst_lending_contagion_proof.rs`.

> **Skills are optional accelerators, not requirements.** The `riptide-adapt`, `riptide-scenarios`, and `riptide-narrative` Claude Code skills produce first-pass TOML / run-configs / reports by letting a session-native LLM do the typing. Every artifact the skills generate is plain TOML or markdown you can hand-author instead — see `fixtures/adapters/resource-grinder.toml` for a minimal from-scratch example.

## LiteSVM runtime — default, with honest caveats

The engine's default backend is **LiteSVM** (in-process SVM). For the same `100 agents × 180 ticks` lending workload, LiteSVM completes in **0.898s** end-to-end; `solana-test-validator` with `--bpf-program` preload and warm caches takes **901.461s** (measured 2026-04-12, see `TOOLCHAIN.md`). That is roughly **~900x**, entirely from RPC and confirmation overhead removal — both paths execute the same `lending_pool.so` BPF program logic.

What LiteSVM does not model: gossip, vote, PoH, full consensus behavior. The speedup is infrastructure overhead removal, not a program-level optimization. When validator-level parity matters, the parity test at `engine/tests/lending_integration.rs` stays gated on `RIPTIDE_RUN_VALIDATOR_TESTS=1` as the diagnostic reference path. LiteSVM is the default runtime; the validator path is diagnostic only.

## Determinism

Same seed in, same bytes out, byte-for-byte, across the lending, perps, AMM, and generic bundles. The `e2e_determinism` integration test enforces this on every `cargo test -p riptide-engine` run by executing the same fixture twice and asserting the result JSON is byte-identical. Replay mode extends the same guarantee to declared trajectories — `riptide replay fixtures/replays/lending-whale-bad-debt/config.json` runs the shipping whale-concentrated-borrow bad-debt trajectory (historical inspiration: Solend's June 2022 whale-risk incident) deterministically against its replay-scoped adapter and asserts the declared `no_bad_debt` invariant fires at the declared cascade tick. The replay is a byte-stable run of a declared scenario, not a forensic reconstruction of mainnet state.

Determinism is what makes the grid re-derivable by an adversarial reviewer: the adapter TOML + persona TOML + run-config + engine binary are the whole input. Nothing else is load-bearing.

## Adapter pipeline — TOML to engine

Inputs flow through two validators that share one mental model. The CLI reads adapter + persona + run-config TOML and runs them through Zod schemas (`cli/src/schemas/adapter.ts`, `cli/src/compiler/schema.ts`) before ever invoking the engine — this is the user-facing error surface, tuned for readable messages. The engine then deserializes the same shapes with serde. The two schemas mirror each other on purpose: the Zod layer catches shape errors fast in TypeScript with a friendly error; serde is the canonical truth at the Rust boundary. When they drift, serde wins and the CLI schema is the bug.

On a run, the CLI compiles personas, pre-validates adapter + run-config, then shells out to the release-build engine binary with the config, policies, and output paths. The engine loads the adapter, boots LiteSVM, deploys the pinned `.so` from `programs/<name>/target/deploy/`, ticks the scenario, and writes `simulation-result.json`. Invariants are evaluated at exit; any firing causes a non-zero exit. The dashboard reads the result JSON — the engine has no network surface of its own.

## Scenario discovery

`riptide run` with no positional argument discovers every scenario the current repo declares and executes them sequentially. The convention is `.riptide/scenarios/**/run-config.json` walked recursively from the CWD — every matching file is treated as a scenario, and the scenario name is the directory path relative to `.riptide/scenarios/` with `/` preserved as the grouping separator (so `.riptide/scenarios/hero-grid/w25-s40/run-config.json` becomes scenario name `hero-grid/w25-s40`, matching jest's `describe` nesting). Names are stable and sorted, so reruns produce identical scenario ordering regardless of filesystem traversal order.

Three invocation shapes share one command. `riptide run` runs everything discovered. `riptide run <pattern>` filters the discovered list by glob (`'*w25*'`, `'hero-grid/*'`). `riptide run <file-path>` runs a single run-config directly — the backward-compat path that scripts, CI, and the shipping fixtures still rely on; the file-existence check disambiguates it from a pattern. `riptide list` prints the discovered scenario list one per line, useful for CI integrations that want to know what will run before running it.

Per-scenario results and the aggregate summary land in `.riptide/last-run.json` (schema pinned in `cli/src/run/last-run.ts`); `riptide run --only-failing` reads that file to rerun only the scenarios that failed or aborted most recently. The convention pairs with `.riptide/adapters/` and `.riptide/personas/` so every artifact Riptide reads — adapter, personas, scenarios — lives under the same version-controlled tree in the user's own repo.

Inside the Riptide monorepo itself, `.riptide/scenarios/` is a symlink to `fixtures/scenarios/`, so shipping scenarios are discoverable via the same convention as user-authored scenarios in any other repo — `riptide list` and `riptide run` work identically in both contexts. The symlink is tracked in git (mode `120000`), keeps every existing `fixtures/scenarios/…` reference in scripts and CI resolving unchanged, and adds no determinism risk because the engine never observes which path it traversed to reach a run-config.

## Oracle binding for generic adapters

Generic adapters can bind one shared account as the oracle the engine targets for shock injection. The binding lives in a single `[[oracles]]` block plus an optional `owner` on the referenced `[accounts.<name>]`:

- **`kind`** — `"admin-mock"` (shipping mock layout) or `"pyth"` (real 3312-byte Pyth aggregate-price layout the `pyth-sdk-solana` parser accepts unchanged).
- **`account`** — the declared `[accounts.<name>]` the oracle layout bytes live in. Must be `kind = "shared"`; binding to an agent-scoped account or to a missing name is a loader error.
- **`base_price` + `exponent`** — the oracle state the harness writes into the bound account before tick 0, so the first observation already sees the adapter-declared price.
- **`owner`** on the bound account — optional. Omitted, the shared account is owned by the simulated program. Declared, exactly one of `owner.program_so = "<path>.so"` (owner pubkey derived from the companion `target/deploy/<name>-keypair.json` the rest of the repo already uses) or `owner.pubkey = "<base58>"` (literal — for real external programs such as Pyth) is accepted. Declaring both or neither is a key-level loader error.

On every scenario/replay oracle update the generic harness encodes through the same layout dispatcher the shipping `admin_mock_oracle` and real-SDK Pyth gates use, then writes into the bound account preserving owner and lamports — so a program that enforces account-owner asserts at read time sees the sibling-program pubkey, not a silent fallback to the simulated program id. The end-to-end proof for the sibling-owned admin-mock case lives in `engine/tests/perps_sibling_oracle_proof.rs`; the real-SDK parser proof lives in `engine/tests/pyth_real_layout.rs`.

What this surface does **not** yet cover:

- **Multi-oracle generic adapters.** Declaring 2+ `[[oracles]]` entries on a generic adapter fails fast with a single-oracle-for-now diagnostic — the current scenario/replay surfaces emit one oracle-update stream.
- **Pairwise generic liquidation.** `GenericHarness::execute_action` still ignores `target_idx`, so `liquidate_position`'s victim plumbing is a follow-up.
- **Generalized multi-program scenario sweeps.** The cross-protocol proof at `fixtures/replays/lst-lending-contagion-proof/` is replay-only composition: two shipping bundles plus one declared scalar-observation → scalar-oracle-write bridge in one deterministic replay run. Synthetic multi-program persona sweeps, arbitrary cross-program transaction graphs, a multi-program LST → stablecoin → lending chain, governance-contagion bundles, and cascade-graph dashboards are not in today's claim surface.
- **Production LST / stablecoin / DeFi codebase coverage.** The `liquid-staking`, `stablecoin`, and `lending_pool` programs the bundles ship against are minimal forks chosen for determinism and clarity of the failure shape. No real Kelp / rsETH / Marinade / Jito / Sanctum / Kamino / Marginfi / UXD / Perena / Parrot / Ethena program is wired as an adapter today.
- **Literal UXD / live hedge-venue integration / generalized peg-defense.** The `stablecoin` bundle captures UXD-style *pressure geometry* via a program-local `apply_hedge_loss(loss_bps)` stress mutation, not a stablecoin ↔ perps-venue composition. There is no live hedge-venue plumbing, no dynamic peg-defense policy engine, and no oracle-gated mint/redeem pricing in the shipping bundle — the stablecoin proof's backing stress is driven by on-account state only. A later bundle can add those layers without reshaping the current adapter.
- **Watch mode / parallel scenario execution / `--serve` multi-scenario aggregation** remain follow-ups.
- **Machine validation of non-JSON lineage sources.** `riptide lint` (added in the DX-hardening pass) machine-checks adapters whose `[lineage].idl_source` is a JSON IDL — mapped instructions, args, accounts, and `account.field` references must all resolve in the IDL. Rust-source-of-record adapters like `lending` stay inspection-only and warn honestly; there is no Rust parser in the linter today.
- **Auto-adapter-from-program-id, live mainnet IDL fetch, LSP / editor tooling, adapter-diff CLI.** Every artifact Riptide reads is committed on disk; no run-time network dependency, no IDE integration.

## Operator DX surfaces

Three commands share one mental model for first-run diagnosis before any scenario runs:

- **`riptide doctor`** is a static health check. It probes the documented toolchain surface (`node`, `npm`, `rustc`, `cargo`, `solana`, `cargo-build-sbf`) via `execFile` without spawning a shell, resolves the `riptide-engine` binary through the same path `adapt` / `run` already trust (`$RIPTIDE_ENGINE_BIN` → `<repo>/target/release/` fallback → module-derived monorepo fallback), walks adapters under `<cwd>/.riptide/adapters/*.toml` and `<cwd>/fixtures/adapters/*.toml` (layered — the downstream user-repo layer wins when it exists, so a user repo's own adapters never accidentally inherit shipping fixtures), and runs the lint analyzer in-process against each. No build, no network, no simulation, no engine spawn. Exit codes are `0` all-pass / `1` warnings-only / `2` at least one fail.
- **`riptide lint <adapter>`** is the static validator. When `[lineage].idl_source` is a JSON IDL, it cross-checks every adapter-mapped instruction, arg, account, and dotted `account.field` reference against the IDL. Positive mismatches fail loudly (`exit 2`) with a next-step hint naming the missing symbol; uncovered source surfaces may warn when the adapter neither maps them nor names them in `[lineage].unsupported_fields`. Non-JSON lineage sources (for example `programs/<name>/src/state.rs` on `lending`) land as explicit `WARN` with no false PASS — there is no Rust parser today. Missing `[lineage]` blocks land as explicit `SKIP`.
- **`riptide adapt --adapter <toml>`** is the existing smoke-test harness, now with a lint preflight: when the adapter's lineage source is machine-checkable, adapt runs lint first and aborts before engine spawn on a concrete fail. Lineage-warn and lineage-skip cases continue through to the smoke test unchanged.

These commands are the install-first operator surface — they exist so a new user can install Riptide, confirm their environment, static-check their adapter, and smoke-test it end-to-end before running a single scenario. They do not replace `cargo test -p riptide-engine` or the repo's regression gates; they exist upstream of them.

## Reviewer handoff surfaces

Riptide's reviewer-forwardable substrate lives in three files every
`riptide run` and `riptide replay` touches:

- **Every run emits a pack.** `.riptide/pack/<run-id>/` carries
  `manifest.json`, `summary.md`, `trace.md`, `rerun.sh`, and
  `inputs/` + `outputs/` path indices with repo-relative paths only.
  The pack is byte-stable for byte-stable input — see
  [`pack.md`](pack.md) for the shape reference and the pinned
  per-file hashes.
- **One named proof reruns cold in GitHub Actions.** The shipping
  `.github/workflows/contagion-proof-ci.yml` workflow reruns the
  cross-protocol contagion proof from a cold checkout on every push /
  PR / `workflow_dispatch`, emits the pack, and asserts the canonical
  hash against the committed pin via
  `scripts/ci/assert-canonical-hash.sh`. A copy-friendly template
  ships at `.github/workflows/riptide-handoff-template.yml.example`
  for downstream adopters pinning their own replay to their own hash
  — see [`ci-handoff.md`](ci-handoff.md).
- **Shipping adapters declare their lineage, and JSON-IDL-backed
  adapters get positive machine validation.** The five shipping
  protocol-class adapters (`lending`, `perpetuals`, `amm`,
  `liquid-staking`, `stablecoin`) carry `[lineage]` blocks
  naming the IDL source, inferred assumptions, and unsupported
  fields. `riptide lineage <adapter>` prints the block
  reviewer-readably (inspection-only — no IDL fetch). `riptide lint
  <adapter>` then cross-checks every mapped instruction, arg,
  account, and dotted `account.field` reference against the JSON IDL
  when `[lineage].idl_source` is a JSON IDL, and `riptide adapt`
  runs the same analyzer in-process as a preflight. Non-JSON lineage
  sources (e.g. `lending`'s Rust source of record) stay
  inspection-only WARN with no false PASS; no live mainnet IDL
  fetch in either command. See [`adapter-lineage.md`](adapter-lineage.md).

These surfaces are **simulation evidence**, not audit signoff. A
green CI run is a reproducibility guarantee, not a security
attestation; a lineage block is an authored declaration, not a
machine-verified coverage claim.

## Further reading

- [`vision.md`](vision.md) — why this shape, what's in scope, what isn't.
- [`install.md`](install.md) — the install, Docker, and from-source paths.
- [`pack.md`](pack.md) — the reviewer-ready evidence pack shape.
- [`ci-handoff.md`](ci-handoff.md) — the cold-start CI handoff recipe and downstream template.
- [`adapter-lineage.md`](adapter-lineage.md) — the optional `[lineage]` block and the `riptide lineage` inspection command.
- [`../TOOLCHAIN.md`](../TOOLCHAIN.md) — the Rust / Solana CLI / SBF / Node pins the engine and programs build against.

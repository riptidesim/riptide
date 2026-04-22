# UXD-Style Collateral-Cascade Proof

Named stablecoin proof artifact for the Riptide `stablecoin-fork`
bundle. Replay-mode rendering of a **single-program failure shape**:
an authority-gated `apply_hedge_loss` shrinks delegated collateral,
the effective collateral ratio falls below par, and a subsequent
panic-redemption cohort overruns the pool's reserve buffer and lands
on the pending-redemption queue.

Historical inspiration: the **November 2022 UXD delta-neutral
backing gap** after the Mango Markets exploit wiped UXD's hedge leg.
The geometry this proof models is generic to any delta-neutral /
reserve-backed stablecoin whose backing can be impaired by an
off-protocol event (UXD's Mango hedge gap, Ethena-style USDe hedge
slippage scenarios, reserve-backed stables whose reserves are partly
delegated to external yield venues, …) — the fixture names the
*shape*, not a specific protocol.

## What this proof is

An **abstracted pressure replay** of a UXD-style collateral-cascade +
redemption-run geometry against the shipped `stablecoin-fork`
bundle. It is NOT:

- a literal byte-level replay of the UXD / Mango 2022 incident,
- a live hedge-venue integration (UXD's real failure crossed a
  stablecoin ↔ perps-venue boundary; this bundle internalizes the
  hedge-gap as a narrow program-local mutation instead),
- a multi-program stablecoin ↔ lending ↔ LST contagion claim (that
  is an explicit later composition story, out of scope for this
  bundle),
- an audit or a safety claim about any real stablecoin program.

It IS a discrete, rerunnable, machine-checkable pressure replay of a
**single-program** collateral-cascade + redemption-run geometry that
can be shown to auditors, engineers, and launch-stage founders as
*simulation evidence* — distinct from audit signoff.

## Executive summary

A scheduled `apply_hedge_loss(4_000 bps)` shrinks the stablecoin
pool's delegated collateral at tick 3, dropping the
effective collateral ratio from 133 % to 91 % and breaching the
`full_backing` floor; a panic-redemption cohort at tick 4 then
overruns the reserve buffer (`reserve_buffer_assets = 2_000 → 500`)
and queues three accounts for 4_500 units, breaching the
`no_redemption_queue_formation` floor. Three declared invariants
fire at named ticks across a six-tick trajectory, with a
byte-stable `simulation-result.json` sha256 pinned for regression.
This is the load-bearing signal: a single-program, rerunnable
collateral-cascade + redemption-run pressure shape, framed as
simulation evidence — not a UXD replay, not an audit, not a live
hedge-venue integration claim.

## Load-bearing claim

Three declared adapter invariants fire at named ticks because the
pool's observable state materially changed:

| Invariant                          | Field                                              | First firing tick | Why                                                                         |
| ---------------------------------- | -------------------------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `no_hedge_loss_during_healthy_run` | `pool.cumulative_hedge_loss_bps == 0`              | **tick 3**        | `apply_hedge_loss(4000 bps)` lands; `cumulative_hedge_loss_bps = 4_000`     |
| `full_backing`                     | `pool.effective_collateral_ratio_bps >= 10_000`    | **tick 3**        | Haircut shrinks delegated collateral; ratio drops from 13_333 bps to 9_066  |
| `no_redemption_queue_formation`    | `pool.pending_redemption_count == 0`               | **tick 4**        | Panic cohort exceeds reserve after the first claim; 3 accounts queue        |

Counterfactually, the pre-haircut tick 0–2 baseline passes all three
invariants cleanly — the firings are not a bootstrap artifact, they
are the materially-changed outcome of the scheduled hedge-loss +
redemption-run trajectory.

## Technical notes — discrete economic trajectory

- **Pre-tick 0 (initial state):** admin calls `initialize_pool`, then
  five stakers each deposit 2_000 units of collateral and mint 1_500
  stablecoins. Post-bootstrap pool: `collateral_assets = 10_000,
  reserve_buffer_assets = 2_000 (20 %), stable_supply = 7_500,
  pending_redemption_assets = 0, effective_collateral_ratio_bps =
  13_333` (133 % backed against the queue-free formula).
- **Tick 0–2:** quiet window. Oracle holds at price 1.00 (exp −2).
  All three invariants pass.
- **Tick 3 — scheduled hedge-loss.** Admin fires
  `apply_hedge_loss(loss_bps = 4_000)`. The haircut hits delegated
  collateral only (`collateral_assets − reserve_buffer_assets =
  8_000`), shrinking it by 40 % → `cumulative_hedge_loss_bps =
  4_000, collateral_assets = 6_800, effective_collateral_ratio_bps =
  9_066` (under-backed by 9.3 %).
  `no_hedge_loss_during_healthy_run` and `full_backing` fire for the
  first time. Oracle trajectory drops to 0.91.
- **Tick 4 — panic redemption cohort.** Stakers 0–3 each call
  `request_redeem(1_500)`. Staker-0 settles from the reserve buffer
  (`reserve_buffer_assets 2_000 → 500`, `claimable_collateral =
  1_500`). Stakers 1–3 each exceed the remaining 500-unit reserve
  and land on the queue (`pending_redemption_count = 3,
  pending_redemption_assets = 4_500`). Ratio falls to 5_333 bps.
  `no_redemption_queue_formation` fires for the first time. Oracle
  → 0.85.
- **Tick 5 — partial claim.** Staker-0 calls `claim_redeem` and
  flushes the 1_500-unit claimable balance. Stakers 1–3 remain
  queued because `reserve_buffer_assets (500) <
  per-account pending (1_500)` — the queue does not settle. Oracle
  → 0.80.
- **Tick 6 — terminal snapshot.** Queue still has 3 accounts
  totalling 4_500 units pending. `cumulative_hedge_loss_bps =
  4_000`. Oracle → 0.75. All three invariants persist.

## Rerun command

```
cd /path/to/riptide     # monorepo root (contains fixtures/, programs/)
riptide replay fixtures/replays/stablecoin-uxd-style-collateral-cascade/config.json \
  --allow-invariant-violations
```

`--allow-invariant-violations` is load-bearing: the proof *wants*
invariants to fire — that's the evidence signal. Without the flag
the CLI exits 1 on the first firing, which is the right shape for a
CI gate on a healthy-path run but the wrong shape for an evidence
replay.

The command writes the full artifact bundle
(`simulation-result.json` + `report.md`) into the proof's own
`riptide-output/replays/stablecoin-uxd-style-collateral-cascade/`
sub-tree — the `output_path` in `config.json` resolves relative to
the config file's directory, not the current working directory —
**and** emits a reviewer-ready evidence pack at
`.riptide/pack/replay-stablecoin-uxd-style-collateral-cascade/`
(relative to the current working directory).

A byte-stable gate that asserts the exact firing ticks + canonical
`simulation-result.json` SHA-256 runs as an engine integration test:

```
cargo test -p riptide-engine --release --features litesvm-backend \
  --test replay_stablecoin_uxd_style_collateral_cascade
```

Canonical regression hash (over the committed
`simulation-result.json` bytes, pinned in `expected-summary.json`):
`2f61c0a7cfd592b0e625060ddc076cccb62093a1f0d5b5779fc8f548f7c2f2bf`.
The pack surface carries its own `canonical_hash` in
`manifest.json` (derived over the canonicalized pack contents, not
over `simulation-result.json`) — the two are deliberately distinct
substrates; the regression hash above is the one the engine gate
asserts against.

## Forwardable evidence pack

The pack at
`.riptide/pack/replay-stablecoin-uxd-style-collateral-cascade/` is
the canonical surface a reviewer forwards. It carries the same shape
every Riptide run emits: `manifest.json` (machine-readable index with
canonical hash, declared-vs-firing invariant rollup, exit code, and
repo-relative input / output paths), `summary.md` (executive
summary), `trace.md` (per-tick events of interest — the
`apply_hedge_loss` at tick 3 and the redemption-run at tick 4
surface in the trace table), `rerun.sh` (POSIX-sh rerun recipe), and
`inputs/` + `outputs/` path indices. Paths are repo-relative; the
pack embeds no absolute host paths. See
[`../../../docs/pack.md`](../../../docs/pack.md) for the full pack shape
reference.

## Artifacts

- `adapter.toml` — replay-scoped stablecoin-fork adapter (mirrors
  the shipping file, adds `full_backing` and
  `no_redemption_queue_formation` invariants that the shipping
  adapter deliberately omits to stay tick-0-safe on the generic
  zero-byte bootstrap).
- `initial-state.json` — pre-tick bootstrap (`initialize_pool` +
  5 × `deposit_collateral(2000)` + 5 × `mint_stable(1500)`).
- `trajectory.json` — per-tick instruction stream
  (`apply_hedge_loss`, four `request_redeem` calls, one
  `claim_redeem`).
- `oracle-trajectory.json` — admin-mock oracle price walk
  1.00 → 0.91 → 0.85 → 0.80 → 0.75 over ticks 0, 3, 4, 5, 6.
- `config.json` — the replay-config JSON the CLI consumes.
- `expected-summary.json` — canonical SHA-256 + invariant firing
  baseline the engine test asserts against.
- `riptide-output/replays/stablecoin-uxd-style-collateral-cascade/`
  (inside this fixture directory, because `config.json::output_path`
  resolves relative to the config file) — rerun-generated artifacts:
  - `simulation-result.json` — full canonical result.
  - `report.md` — CLI-generated human-readable summary.

## What this proof does NOT prove

- **Nothing about mainnet risk of any specific stablecoin program.**
  This is a simulation against a minimal fork that captures the
  failure geometry. It cannot tell you whether any production
  stablecoin (UXD, Perena, Parrot, USDH, Ondo USDY, Ethena USDe, …)
  will or will not lose its backing.
- **No live hedge-venue integration.** The UXD real-world failure
  carried its delta hedge on an off-program perps venue (Mango);
  this proof internalizes the hedge-gap as a narrow program-local
  mutation (`apply_hedge_loss(loss_bps)`) rather than modeling a
  cross-program stablecoin ↔ perps composition. Live venue plumbing
  is explicitly out of scope for this bundle.
- **No cross-protocol contagion.** The proof does not model the
  stablecoin's propagation into a downstream lending market, an LST
  collateralized position, or an AMM liquidity pool for the
  stablecoin's native pair. Those are separate bundles.
- **No oracle staleness or NAV-drift dynamics.** The bound oracle
  receives real admin-mock bytes per the declared trajectory, but
  the shipping `stablecoin_fork` processor does not read the oracle
  — backing is driven by on-account state only. A later bundle can
  add oracle-gated pricing without reshaping this fixture.
- **Not a fork of any real stablecoin codebase.** The
  `stablecoin-fork` program is a minimal surface chosen for
  determinism and clarity of the failure shape, not production
  fidelity.

## Related fixtures

- [`../liquid-staking-depeg-redemption-run/`](../liquid-staking-depeg-redemption-run/)
  — the LST analogue: `apply_slash` + withdrawal-run instead of
  `apply_hedge_loss` + redemption-run. Same two-phase pressure
  geometry on a different protocol class.
- [`../lst-lending-contagion-proof/`](../lst-lending-contagion-proof/)
  — the multi-program composition shape this bundle explicitly does
  NOT extend into. Kept here as an example of how a later stablecoin
  ↔ downstream-protocol composition *would* look.

## Honesty framing

Simulation evidence is not audit signoff. A rerunnable invariant
firing at a named tick is stronger than a hand-waved "stress test",
but weaker than a formal proof or a mainnet post-mortem. Treat this
artifact as a starting point for a conversation with an auditor or
security-minded engineer, not as a certification.

## Sources

- Background on the November 2022 UXD delta-neutral backing gap
  after the Mango exploit (public reporting). UXD Protocol's
  incident disclosures describe the hedge leg's impairment on an
  off-program venue.
- Program surface + state machine:
  `programs/stablecoin-fork/src/`
- Shipping adapter + invariants:
  `fixtures/adapters/stablecoin-fork.toml`
- Bundle-level context (stablecoin class, generic-oracle path,
  single-program boundary, hedge-gap internalization rationale):
  `.specs/features/sprint-14-stablecoin-bundle/spec.md`

# LST Depeg + Withdrawal-Run Pressure Replay

Named liquid-staking proof artifact for the Riptide
`liquid-staking` bundle. Replay-mode rendering of a
**single-program failure shape**: an authority-gated `apply_slash`
shrinks delegated assets, the exchange rate falls, and a subsequent
redemption cohort overruns the pool's liquid reserve and lands on
the withdrawal queue.

Historical inspiration: the 2024 Kelp / rsETH depeg. The geometry
this proof models is generic to any LST with a delayed-withdrawal
queue (Lido, Jito, Marinade, Sanctum, rsETH, Kelp …) — the fixture
names the *shape*, not a specific protocol.

## What this proof is

An **abstracted pressure replay** of an LST depeg + redemption-run
geometry against the shipped `liquid-staking` bundle. It is NOT:

- a byte-level replay of any specific on-chain incident,
- a cross-protocol contagion claim (LST collateral in Aave / Morpho /
  Euler / etc. — that is explicitly **out of scope** for this bundle),
- an audit or a safety claim about any real LST program.

It IS a discrete, rerunnable, machine-checkable pressure replay of a
**single-program** depeg + queue-formation geometry that can be shown
to auditors, engineers, and launch-stage founders as *simulation
evidence* — distinct from audit signoff.

## Load-bearing claim

Two declared adapter invariants fire at named ticks because the
pool's observable state materially changed:

| Invariant                       | Field                             | First firing tick | Why                                                                        |
| ------------------------------- | --------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `no_slash_during_healthy_run`   | `pool.cumulative_slashed == 0`    | **tick 3**        | `apply_slash(2500 bps)` shrinks delegated stake; `cumulative_slashed=2000` |
| `no_queue_formation`            | `pool.pending_unstake_count == 0` | **tick 4**        | Redemption demand at tick 4 exceeds `reserve_buffer`; 4 accounts queued    |

Counterfactually, a pre-slash tick 0–2 baseline passes both
invariants cleanly — the firings are not a bootstrap artifact, they
are the materially-changed outcome of the scheduled slash +
redemption-run trajectory.

## Discrete economic trajectory

- **Pre-tick 0 (initial state):** admin calls `initialize_pool` at
  exchange-rate 10_000 bps (1:1), then five stakers each deposit 2_000
  units. Post-bootstrap pool: `total_assets=10_000, reserve_buffer=2_000
  (20 %), lst_supply=10_000, exchange_rate_bps=10_000`.
- **Tick 0–2:** quiet window. Oracle holds at price 1.00 (exp −2).
  Both invariants pass.
- **Tick 3 — scheduled slash.** Admin fires `apply_slash(slash_bps=2500)`.
  The slash hits delegated stake only (`total_assets − reserve_buffer
  = 8_000`), shrinking it by 25 % → `cumulative_slashed = 2000`,
  `total_assets = 8_000`, `exchange_rate_bps = 8_000` (20 % depeg).
  `no_slash_during_healthy_run` fires for the first time.
  Oracle trajectory drops to 0.85.
- **Tick 4 — withdrawal run.** Each staker requests `1500 LST` of
  redemption. At the post-slash rate, `owed = 1500 × 8000 / 10000 =
  1200` units per call. Only staker-0 settles from reserve
  (`reserve_buffer` 2_000 → 800, `claimable_assets = 1200`). Stakers
  1–4 each exceed the remaining 800-unit reserve and land on the
  queue (`pending_unstake_count = 4, pending_unstake_assets = 4800`).
  `no_queue_formation` fires for the first time. Oracle → 0.80.
- **Tick 5 — partial claim.** Staker-0 calls `claim_unstake` and
  flushes the 1_200-unit claimable balance. Stakers 1–4 remain queued
  because `reserve_buffer (800) < per-account pending (1200)` — the
  queue does not settle. Oracle → 0.75.
- **Tick 6 — terminal snapshot.** Queue still has 4 accounts
  totalling 4_800 units pending. `cumulative_slashed = 2000`. Oracle
  → 0.70. Both invariants persist.

## Rerun command

```
cd /path/to/riptide     # monorepo root (contains fixtures/, programs/)
riptide replay fixtures/replays/liquid-staking-depeg-redemption-run/config.json \
  --allow-invariant-violations
```

`--allow-invariant-violations` is load-bearing: the proof *wants*
invariants to fire — that's the evidence signal. Without the flag
the CLI exits 1 on the first firing, which is the right shape for a
CI gate on a healthy-path run but the wrong shape for an evidence
replay.

The command writes the full artifact bundle
(`simulation-result.json` + `report.md`) into
`riptide-output/replays/liquid-staking-depeg-redemption-run/`
**and** emits a reviewer-ready evidence pack at
`.riptide/pack/replay-liquid-staking-depeg-redemption-run/`
(relative to the current working directory).

A byte-stable gate that asserts the exact firing ticks + canonical
SHA-256 runs as an engine integration test:

```
cargo test -p riptide-engine --release --features litesvm-backend \
  --test replay_liquid_staking_depeg_redemption_run
```

## Forwardable evidence pack

The pack at
`.riptide/pack/replay-liquid-staking-depeg-redemption-run/` is the
canonical surface a reviewer forwards. It carries the same shape every
Riptide run emits: `manifest.json` (machine-readable index with
canonical hash, declared-vs-firing invariant rollup, exit code, and
repo-relative input / output paths), `summary.md` (executive summary),
`trace.md` (per-tick events of interest — the `apply_slash` at tick 3
and the redemption-run at tick 4 surface in the trace table),
`rerun.sh` (POSIX-sh rerun recipe), and `inputs/` + `outputs/` path
indices. Paths are repo-relative; the pack embeds no absolute host
paths. See [`../../docs/pack.md`](../../docs/pack.md) for the full
pack shape reference.

## Artifacts

- `adapter.toml` — replay-scoped liquid-staking adapter (mirrors
  the shipping file, adds `no_queue_formation` invariant).
- `initial-state.json` — pre-tick bootstrap (`initialize_pool` +
  5 × `stake(2000)`).
- `trajectory.json` — per-tick instruction stream (apply_slash, five
  request_unstake calls, one claim_unstake).
- `oracle-trajectory.json` — admin-mock oracle price walk
  1.00 → 0.85 → 0.80 → 0.75 → 0.70 over ticks 0, 3, 4, 5, 6.
- `config.json` — the replay-config JSON the CLI consumes.
- `expected-summary.json` — canonical SHA-256 + invariant firing
  baseline the engine test asserts against.
- `riptide-output/replays/liquid-staking-depeg-redemption-run/` —
  rerun-generated artifacts:
  - `simulation-result.json` — full canonical result.
  - `report.md` — CLI-generated human-readable summary.

## What this proof does NOT prove

- **Nothing about mainnet risk of any specific LST program.** This is
  a simulation against a minimal fork that captures the failure
  geometry. It cannot tell you whether any production pool (Kelp,
  Marinade, Jito, Sanctum, Lido, …) will or will not depeg.
- **No cross-protocol contagion.** The proof does not model LST
  collateral in a downstream lending market, rehypothecation into
  leverage protocols, or AMM-pool depth for the LST–native pair.
  Those are separate bundles.
- **No oracle staleness dynamics.** The bound oracle receives real
  admin-mock bytes per the declared trajectory; the engine's generic
  path does not currently expose a per-tick oracle-lag knob, so the
  proof does not stress the redemption-vs-stale-price gap.
- **Not a fork of any real LST codebase.** The `liquid-staking`
  program is a minimal surface chosen for determinism and clarity of
  the failure shape, not production fidelity.

## Related fixture

A sibling fixture,
[`liquid-staking-slash-with-open-queue/`](../liquid-staking-slash-with-open-queue/),
reorders the trajectory so the withdrawal queue opens *before* the
slash. That ordering exercises the specific rate-formula regime where
`pending_unstake_assets > 0` at slash time — see that fixture's
README for the full write-up.

## Honesty framing

Simulation evidence is not audit signoff. A rerunnable invariant
firing at a named tick is stronger than a hand-waved "stress test",
but weaker than a formal proof or a mainnet post-mortem. Treat this
artifact as a starting point for a conversation with an auditor or
security-minded engineer, not as a certification.

## Sources

- Background on the 2024 Kelp / rsETH depeg (public reporting):
  `https://www.theblock.co/post/302443/kelp-rseth-depeg-june-2024`
- Program surface + state machine: `programs/liquid-staking/src/`
- Shipping adapter + invariants: `fixtures/adapters/liquid-staking.toml`
- Bundle-level context (LST class, generic-oracle path,
  single-program boundary):
  `.specs/features/sprint-10-liquid-staking-proof/spec.md`

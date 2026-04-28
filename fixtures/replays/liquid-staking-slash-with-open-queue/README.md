# LST Slash-With-Open-Queue Pressure Replay

Sibling of
[`fixtures/replays/liquid-staking-depeg-redemption-run/`](../liquid-staking-depeg-redemption-run/).
Same bundle, same program, same 5-staker bootstrap — but the
trajectory is reordered so the **withdrawal queue opens before the
slash fires**. That ordering is what the pre-fix
`recompute_exchange_rate` formula got wrong, and is the regime the
sibling fixture does not exercise (the sibling slashes at tick 3
before any `request_unstake`, so `pending_unstake_assets = 0` at
slash time and both the buggy and fixed formulas give the same
result).

This fixture pins the corrected formula in-program: the slash lands
on an open queue carrying 6_000 units of pending liability, so the
honest backing-for-active-LST collapses from 10_000 bps to 2_000 bps
(an 80 % depeg). A pre-fix implementation of `recompute_exchange_rate`
that ignored `pending_unstake_assets` would instead report ~26_000
bps (peg appears to *strengthen*) and the `no_catastrophic_depeg`
invariant would never fire.

Historical inspiration: the 2024 Kelp / rsETH depeg. The geometry
this proof models is generic to any LST with a delayed-withdrawal
queue — the fixture names the *shape*, not a specific protocol.

## Load-bearing claim

Three adapter invariants fire at named ticks:

| Invariant                       | Field                              | Op  | Thresh | First firing tick | Why                                                                    |
| ------------------------------- | ---------------------------------- | --- | ------ | ----------------- | ---------------------------------------------------------------------- |
| `no_queue_formation`            | `pool.pending_unstake_count`       | ==  | 0      | **tick 3**        | 5 × `request_unstake(1500)`; 4 stakers queue (reserve covers only 1)   |
| `no_slash_during_healthy_run`   | `pool.cumulative_slashed`          | ==  | 0      | **tick 4**        | `apply_slash(2500 bps)` shrinks delegated by 25 %                      |
| `no_catastrophic_depeg`         | `pool.exchange_rate_bps`           | >=  | 5000   | **tick 4**        | Post-slash rate collapses to 2_000 bps (fires only under the fix)      |

`no_catastrophic_depeg` is the uniquely load-bearing firing: it is
observable-proof that `recompute_exchange_rate` correctly subtracts
`pending_unstake_assets` from `total_assets`.

## Discrete economic trajectory

- **Pre-tick 0 (initial state):** admin calls `initialize_pool` at
  exchange-rate 10_000 bps, then five stakers each deposit 2_000.
  Post-bootstrap pool: `total_assets=10_000, reserve_buffer=2_000
  (20 %), lst_supply=10_000, pending=0, rate=10_000`.
- **Tick 0–2:** quiet window. Oracle holds at price 1.00. All three
  invariants pass.
- **Tick 3 — withdrawal run.** Each staker calls
  `request_unstake(1500)` at rate 10_000 (so `assets_owed = 1500`).
  Staker-0 settles from the reserve (`reserve 2_000 → 500, total
  10_000 → 8_500, claimable_0 = 1_500`). Stakers 1–4 each exceed
  the remaining 500-unit reserve and land on the queue
  (`pending_unstake_count = 4, pending_unstake_assets = 6_000`).
  `no_queue_formation` fires for the first time. `lst_supply` has
  dropped to 2_500. Oracle → 0.90.
- **Tick 4 — slash while queue is open.** Admin fires
  `apply_slash(slash_bps=2500)`. The slash hits `total_assets -
  reserve_buffer = 8_000` by 25 %, removing 2_000 units of delegated
  stake. `total_assets = 6_500`, `cumulative_slashed = 2_000`. The
  corrected formula computes `rate = (total - pending) * BPS /
  lst_supply = (6_500 − 6_000) × 10_000 / 2_500 = 2_000 bps` — an
  80 % depeg absorbed entirely by the 2_500 remaining active LST.
  Queue holders are senior: their claims remain pinned at the 6_000
  units committed at tick 3's pre-slash rate.
  `no_slash_during_healthy_run` and `no_catastrophic_depeg` fire for
  the first time. Oracle → 0.20.
- **Tick 5 — partial claim.** Staker-0 calls `claim_unstake` and
  flushes their 1_500 claimable balance. Stakers 1–4 remain queued
  because `reserve_buffer (500) < per-account pending (1_500)` — the
  queue does not settle.

## Rerun command

```
cd /path/to/riptide     # monorepo root
riptide replay fixtures/replays/liquid-staking-slash-with-open-queue/config.json \
  --allow-invariant-violations
```

`--allow-invariant-violations` is load-bearing: the proof *wants*
invariants to fire — that's the evidence signal.

The command writes the full artifact bundle
(`simulation-result.json` + `report.md`) into
`riptide-output/replays/liquid-staking-slash-with-open-queue/`
**and** emits a reviewer-ready evidence pack at
`.riptide/pack/replay-liquid-staking-slash-with-open-queue/`
(relative to the current working directory).

A byte-stable gate that asserts the exact firing ticks + canonical
SHA-256 runs as an engine integration test:

```
cargo test -p riptide-engine --release --features litesvm-backend \
  --test replay_liquid_staking_slash_with_open_queue
```

## Forwardable evidence pack

The pack at
`.riptide/pack/replay-liquid-staking-slash-with-open-queue/` is the
canonical forwardable surface — same shape every Riptide run emits:
`manifest.json` (canonical hash, declared-vs-firing invariants, exit
code, repo-relative paths), `summary.md`, `trace.md` (per-tick events
of interest — the `request_unstake` cohort at tick 3, the
`apply_slash` at tick 4 against the open queue, and the
`no_catastrophic_depeg` firing are all surfaced), `rerun.sh`, and
`inputs/` + `outputs/` path indices. Paths are repo-relative. See
[`../../docs/pack.md`](../../docs/pack.md) for the full pack shape
reference.

## Regenerating `expected-summary.json`

After a deliberate program or fixture change, the pinned hash will
drift. Regenerate with:

```
RIPTIDE_DUMP_EXPECTED=1 cargo test --features litesvm-backend \
  --test replay_liquid_staking_slash_with_open_queue \
  dump_expected_summary -- --nocapture
```

Then copy the printed JSON block into `expected-summary.json`.

## Artifacts

- `adapter.toml` — replay-scoped adapter (adds `no_catastrophic_depeg`
  on top of the sibling's two invariants).
- `initial-state.json` — pre-tick bootstrap (same as sibling).
- `trajectory.json` — tick 3: withdrawal run, tick 4: slash, tick 5:
  partial claim.
- `oracle-trajectory.json` — price walk 1.00 → 0.90 → 0.20 → 0.20.
- `config.json` — replay-config JSON the CLI consumes.
- `expected-summary.json` — canonical SHA-256 + invariant baseline.
- `riptide-output/replays/liquid-staking-slash-with-open-queue/` —
  rerun-generated `simulation-result.json` + `report.md`.

## Relation to the sibling fixture

Both fixtures exist because a **single trajectory cannot cover both
regimes**:

- The sibling
  ([`liquid-staking-depeg-redemption-run/`](../liquid-staking-depeg-redemption-run/))
  slashes first, then opens the queue — it proves the depeg +
  redemption-run *shape*, but never reaches the
  queue-open-during-slash branch of the rate formula. Pre-fix and
  post-fix code give identical results there.
- This fixture reorders the ticks so the slash lands on an open
  queue — it proves the rate formula correctly subtracts
  `pending_unstake_assets`. Pre-fix and post-fix code diverge in the
  observable output (rate 26_000 bps vs 2_000 bps).

The two fixtures together are the proof surface for the Sprint 10
R1.2 depeg claim.

## Honesty framing

Simulation evidence has explicit boundaries. This fixture proves the
in-program accounting is internally consistent under a
pro-rata-senior queue model; it does not certify that any real LST
protocol models slashes the same way. Production LSTs (Kelp / rsETH
/ Marinade / Jito / Sanctum / Lido) each have their own
withdrawal-queue semantics and their own slashing economics.

## Sources

- Background on the 2024 Kelp / rsETH depeg dynamics:
  `https://www.theblock.co/post/302443/kelp-rseth-depeg-june-2024`
- Program surface + corrected formula:
  `programs/liquid-staking/src/state.rs`
  (`recompute_exchange_rate`)
- Sibling fixture:
  [`fixtures/replays/liquid-staking-depeg-redemption-run/`](../liquid-staking-depeg-redemption-run/)

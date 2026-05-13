# Drift-Shape Fake-Collateral Vault-Drain Replay

Named failure-shape replay artifact for Riptide's Solana lending fork.
Captures the geometry of accepted fake or mispriced collateral that lets
an attacker draw real borrow value, then leaves the protocol holding bad
debt once the collateral mark collapses.

## What this proof is

This is an **economic-shape replay** inspired by the April 2026 Drift
incident. It is NOT:

- a byte-level reproduction of Drift's program, admin controls, oracle
  accounts, or incident slot state,
- an audit or safety claim about Drift, Drift v2, or any deployed
  Solana perps protocol,
- a faithful model of the off-chain social-engineering path, signer
  compromise, durable nonce behavior, governance, market whitelisting,
  or production risk engine.

It IS a discrete, rerunnable, machine-checkable pressure replay of the
**accepted collateral mark -> borrow/withdraw -> mark collapse ->
bad-debt** geometry, against Riptide's shipped Solend-fork toy lending
program, using explicit per-tick instructions and a declared oracle
trajectory.

## Historical Inspiration

On April 1, 2026, Drift reported an incident that caused substantial
user losses. Public writeups frame the primary root cause as
off-chain/privileged-control compromise, not a pure smart-contract
math exploit. The useful Riptide slice is the on-chain economic shape
after that control boundary was crossed:

1. A privileged action makes fake or mispriced collateral acceptable.
2. The collateral mark gives the attacker borrow power against shared
   liquidity.
3. Real assets leave the pool while the backing asset is economically
   weak.
4. The mark or accepted value collapses.
5. Liquidation cannot recover enough value, so the protocol realizes
   bad debt.

This pack reproduces that protocol-level outcome on Riptide's Solana
toy lending fork by representing the accepted collateral mark and
collapse as declared oracle ticks.

## Load-Bearing Claim

Bootstrap at the accepted collateral mark 1000:

- attacker deposits 100 collateral units; no debt yet.

Tick 1 - accepted mark remains 1000:

- attacker borrows 70000 against the marked collateral.
- collateral_value = 100 * 1000 = 100000.
- max_borrow_value = 100000 * 0.7 = 70000.
- liquidation_value = 100000 * 0.8 = 80000.
- health_factor = 80000 * 10000 / 70000 ~= **11428 bps**.

Tick 2 - mark collapses to 20 + liquidator settles:

- pre-liquidate liquidation_value = 100 * 20 * 0.8 = 1600.
- health_factor = 1600 * 10000 / 70000 ~= **228 bps**.
- liquidator-0 calls `liquidate(target = attacker, repay_amount = 70000)`.
- seized_value = 70000 * 1.05 = 73500.
- collateral_to_seize = ceil(73500 / 20) = 3675.
- actual_collateral = min(3675, 100) = 100.
- shortfall = 73500 - 100 * 20 = **71500**, accrued as `pool.bad_debt`.

Final pinned values (`expected-summary.json`):

- `result_sha256` = `84c4a8e9a83a79298de3f350535e3cb793b2dac1cc5028481b4f57142d8b9702`
- `total_bad_debt` = `71500.0`
- `bad_debt_invariant_firings` = `1` at `terminal_bad_debt_tick = 2`
- `largest_single_tick_drawdown` = `0.98` (the 1000 -> 20 mark collapse)

Credibility gate: the replay-scoped adapter declares a single
`collateral_backing` invariant (`pool.bad_debt == 0`). The integration
test asserts the invariant fires at tick 2 - the cascade tick - and
only there.

## Files

- `initial-state.json` - attacker's bootstrap deposit at the accepted
  collateral mark.
- `trajectory.json` - tick-1 borrow at the accepted mark + tick-2
  liquidation after the collapse.
- `oracle-trajectory.json` - three-tick mark path: accepted mark
  (1000), accepted mark (1000), collapsed mark (20).
- `adapter.toml` - replay-scoped lending adapter with the
  `collateral_backing` invariant. The shipping
  `fixtures/adapters/lending.toml` stays clean to preserve existing
  lending and incident replay determinism.
- `config.json` - the replay-config JSON the CLI consumes.
- `expected-summary.json` - canonical SHA-256 + invariant firing
  baseline the engine test asserts against.
- `manifest.json`, `summary.md`, `trace.md`, `rerun.sh`, `inputs/`,
  `outputs/`, `riptide-output/` - rerun-generated artifacts.

## Rerun Command

```
cd /path/to/riptide
riptide replay fixtures/replays/drift-fake-collateral-vault-drain/config.json \
  --allow-invariant-violations
```

`--allow-invariant-violations` is load-bearing: the proof wants the
`collateral_backing` invariant to fire at tick 2.

The byte-stable gate runs as an engine integration test:

```
cargo test -p riptide-engine --features litesvm-backend \
  --test replay_drift_fake_collateral_vault_drain
```

## Sources

- Drift recovery plan for affected users:
  - https://www.drift.trade/updates/recovery-plan-for-affected-users
- Drift incident recovery update, April 16, 2026:
  - https://www.drift.trade/updates/incident-recovery-update-april-16-2026-now
- Chainalysis analysis of lessons from the Drift hack:
  - https://www.chainalysis.com/blog/lessons-from-the-drift-hack/

## Honesty Framing

Simulation evidence has explicit boundaries. A rerunnable invariant
firing at a named tick on a minimal Solana lending fork is stronger
than a hand-waved "stress test", but weaker than a formal proof or a
mainnet bytecode replay. The fixture names the shape of the failure
mode it models; Drift is cited above as inspiration, not as a
byte-level reproduced fact. A follow-up protocol-v2 guided simulation
would be the right path for stronger Drift-specific evidence.

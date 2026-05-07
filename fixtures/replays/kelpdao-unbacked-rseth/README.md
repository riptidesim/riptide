# KelpDAO-Shape Unbacked-LST Replay

Named failure-shape replay artifact for Riptide's Solana liquid-staking
fork. Captures the geometry of an admin path that mints LST into
circulation without depositing underlying assets and without
recomputing the exchange rate — the LST claim then exceeds the pool's
backing.

## What this proof is

This is an **economic-shape replay** of the unbacked-mint geometry
behind KelpDAO's June 2024 bridge-trust incident. It is NOT:

- a byte-level reproduction of EigenLayer / Kelp Protocol / rsETH
  source, or the specific bridge transactions involved in the
  incident,
- an audit or safety claim about Kelp Protocol, EigenLayer, or any
  deployed restaking platform,
- a cross-chain replay (KelpDAO is on Ethereum; this pack reproduces
  the *economic shape* on Riptide's Solana liquid-staking toy
  program).

It IS a discrete, rerunnable, machine-checkable pressure replay of the
**unauthorized-mint → backing-shortfall** geometry, using a single
admin-only `AdminMintLst` instruction that the toy program ships
specifically to model this failure mode.

## Historical inspiration

In June 2024, KelpDAO's restaking system experienced a depeg event
where rsETH (the LST minted against staked ETH that had been
re-delegated to EigenLayer) traded below its expected ETH-backing
exchange rate after a bridge-trust failure put unbacked rsETH into
circulation. The shape of the incident:

- the rsETH supply on the receiving side of a cross-chain bridge
  exceeded the actual restaked ETH backing it,
- this unbacked rsETH was used as collateral in lending markets,
- arbitrage and panic redemptions drove the LST/ETH rate well below 1.

This pack reproduces the **same accounting flaw** on Riptide's Solana
toy liquid-staking fork. The toy program ships an `AdminMintLst`
instruction that mints LST without depositing underlying assets and
without recomputing the exchange rate — the structural mirror of the
unbacked-mint condition. The Riptide engine's `full_backing` semantic
invariant
(`lst_supply * exchange_rate_bps <= total_assets * 10000`) then fires
deterministically.

## Load-bearing claim

Initial state (5 stakers, 1:1 exchange rate):

- `total_assets = 10000`, `lst_supply = 10000`, `exchange_rate_bps = 10000`.
- `full_backing` evaluates `10000 × 10000 ≤ 10000 × 10000`. Holds at equality.

Tick 1 (`admin_mint_lst(5000)`):

- `total_assets = 10000` (unchanged), `lst_supply = 15000`, `exchange_rate_bps = 10000`.
- `full_backing` evaluates `15000 × 10000 ≤ 10000 × 10000`. Fails.

Final pinned values (`expected-summary.json`):

- `result_sha256` = `ff46b6a1bbcddc4064f1f6eae58c65c291b4856167e800c1c475825c788d0b09`
- `total_ticks` = `2`, `event_count` = `3`
- `expression_invariant_firings.full_backing` = `2` (fires at the mint
  tick and persists through the terminal tick)
- `expression_invariant_first_firing_tick.full_backing` = `1`

Credibility gate: the replay-scoped adapter declares a single
`full_backing` semantic invariant at severity `error`. The integration
test asserts the invariant fires at tick 1 — the named instruction —
with the pinned firing count.

## Files

- `initial-state.json` — pool init + 5 stakers' bootstrap stakes.
- `trajectory.json` — single-tick `admin_mint_lst(5000)` event at tick 1.
- `oracle-trajectory.json` — flat price path (this geometry is
  on-account-state only; oracle is not the driver).
- `adapter.toml` — replay-scoped liquid-staking adapter with the
  `full_backing` semantic invariant. The shipping
  `fixtures/adapters/liquid-staking.toml` stays clean — its
  `lst_supply_backed_by_pool_rate` invariant at severity `warn` keeps
  byte-stability for the depeg-redemption-run replay's pinned hash.
- `config.json` — the replay-config JSON the CLI consumes.
- `expected-summary.json` — canonical SHA-256 + invariant firing
  baseline the engine test asserts against. The hash is the same hash
  the pack tool writes into `manifest.json` (semantics + derived
  observations + expression_invariants are stripped from the canonical
  hash input).
- `manifest.json`, `summary.md`, `trace.md`, `rerun.sh`, `inputs/`,
  `outputs/`, `riptide-output/` — rerun-generated artifacts.

## Rerun command

```
cd /path/to/riptide     # monorepo root
riptide replay fixtures/replays/kelpdao-unbacked-rseth/config.json \
  --allow-invariant-violations
```

`--allow-invariant-violations` is load-bearing: the proof *wants* the
`full_backing` invariant to fire — that's the evidence signal.

The byte-stable gate runs as an engine integration test:

```
cargo test -p riptide-engine --features litesvm-backend \
  --test replay_kelpdao_unbacked_rseth
```

## Sources

- The Block coverage of the KelpDAO / rsETH depeg:
  - https://www.theblock.co/post/302443/kelp-rseth-depeg-june-2024
- KelpDAO governance retrospective on the bridge incident
- Internal parameter-boundary reference:
  - `docs/case-studies/liquid-staking.md`

## Honesty framing

Simulation evidence has explicit boundaries. A rerunnable invariant
firing at a named tick on a minimal Solana liquid-staking fork is
stronger than a hand-waved "stress test", but weaker than a formal
proof or an EVM-level reconstruction of the original incident. The
fixture names the *shape* of the failure mode it models; KelpDAO is
cited above as inspiration, not as a byte-level reproduced fact.

The toy program also ships the `AdminMintLst` instruction
**explicitly** as an admin-only stress hook — it does not pretend the
toy LST has the unbacked-mint path organically. The proof shows that
when the geometry executes, the engine's machine-checkable invariant
framework fires on it; that is the credibility claim, not "we found
this path in the program by accident".

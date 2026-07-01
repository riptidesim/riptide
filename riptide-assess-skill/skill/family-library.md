# Family Library

A starting knowledge base of the personas, invariants, and stress scenarios that
recur per protocol family. **Consult this file during Scope, before inventing a
simulation campaign from scratch.** For the detected family, read its entry,
apply or adapt what genuinely fits the target program's real instructions and
accounts, then add the protocol-specific personas/invariants/axes the program's
own flows demand. This is a menu of well-worn starting points, not a mandate —
skip anything the program doesn't actually expose, and never seed an actor or an
invariant the code cannot support.

How the three columns map onto the guided-sim contract:

- **Known personas** → adapter `[personas]`. Each is an actor archetype with an
  action vocabulary; codegen renders them into `flows.rs`. Seed the ones whose
  actions the program actually exposes; edit `action_weights` to match.
- **Known invariants** → `[[invariants]]`. Semantic expressions checked over
  recorded observations. A flat aggregate (e.g. "no bad debt") becomes a metric
  you `world.record_metric` and a `[[invariants]]` expr that fires when it
  crosses the stated line. Wire the underlying observation first — an invariant
  over a field you never record is dead.
- **Known stress scenarios** → the `[sim.sweep]` axis. Each names an exogenous
  stress to sweep with a fixed-seed region and a healthy control at the origin.
  The [worst-case-playbook.md](./worst-case-playbook.md) entry for the family
  turns the chosen scenario into the worst case to hunt, the deciding metric,
  and the signal trap.

Every family also inherits a shared **generic persona pool** —
`arbitrageur`, `liquidator`, `whale`, `sandwich-attacker` (approximate),
`rug-puller` (opportunistic exit), `lp-provider`, `swapper`,
`leveraged-long`/`-short`, `delta-neutral-farmer`, `funding-arbitrageur`
(proxy). Pull any of these into any family when the program's surface warrants
it (a `liquidator` on anything with a liquidation path, a `whale` wherever
size concentration matters), then re-weight their actions to the real vocab.

---

## lending

- **Known personas:** `steady-lp` (long-tail supplier), `cautious-yield-farmer`,
  `degen-borrower`, `aggressive-arb-bot`, `panic-whale` (mass withdraw),
  `whale` (outsized borrow). Plus `liquidator` from the generic pool — anything
  with a `liquidate` path wants a third-party liquidator actor (Trigger C).
- **Known invariants:**
  - `no_bad_debt` — cumulative bad debt stays at zero; fires on any liquidation
    insolvency (the deciding invariant for the crash-outruns-liquidation case).
  - `debt_below_collateral` — `debt_value <= collateral_value` per position.
  - `debt_below_max_borrow` — `debt_value <= max_borrow_value` per position.
  - `health_factor_positive` — `health_factor > 1.0` per position.
  - `utilization_bound` — pool utilization stays `<= 100%`.
- **Known stress scenarios:**
  - **Oracle price shock** — crash the collateral oracle mid-run (a 40% drop is
    the classic preset); surfaces under-collateralized positions and bad-debt
    events. Swept as `collateral_price_drop_bps`.
  - **Bank run** — a steeper, longer-tailed drop with mass withdrawals
    (`panic-whale` + `degen-borrower` + `cautious-yield-farmer`); stresses the
    withdrawal path and reserve under concentrated exit.

## amm

- **Known personas:** `swapper` (vanilla A→B), `arbitrageur` (one-sided
  swapper), `lp-provider`, `sandwich-attacker` (approximate), `rug-puller`
  (opportunistic LP exit).
- **Known invariants:**
  - `k_invariant` — the constant product `k` does not decrease after fees
    (template; wire a reserve-product observation first). Value leaking below
    `k` net of fees is a real defect, distinct from LP impermanent loss.
- **Known stress scenarios:**
  - **Baseline smoke** — normal price noise, no perturbation; the wiring smoke
    test every family shares.
  - **External price divergence** — move the paired asset's external-market
    price and let an `arbitrageur` rebalance the pool toward it; the swept axis
    is `price_divergence_bps`. AMMs frequently classify as `baseline-sim`; the
    interesting signal is LP redeemable value versus hold, not the spot price.

## perps

- **Known personas:** `leveraged-long`, `leveraged-short`,
  `delta-neutral-farmer`, `funding-arbitrageur` (proxy), `liquidator`.
- **Known invariants:**
  - `no_socialized_loss` — a socialized-loss observation stays at zero once the
    funding and liquidation paths are wired (template).
  - `leverage_bound` — observed max leverage stays under the protocol cap
    (template; default cap 10x — set to the program's real cap).
- **Known stress scenarios:**
  - **Baseline smoke** — normal price noise, no perturbation.
  - **Mark-price gap** — gap the mark oracle past maintenance margin so
    liquidation recovers less than the position's loss; swept as
    `mark_gap_bps`. The deciding signal is insurance-fund drawdown /
    socialized loss, not "did liquidation fire".

## lst (liquid staking)

- **Known personas:** `steady-staker`, `yield-maxi`, `panic-exiter`,
  `arb-redeemer`.
- **Known invariants:**
  - Stake-pool solvency — the pool's redeemable backing covers outstanding
    LST supply at the posted exchange rate (wire a backing/supply observation,
    then check `backing_value >= lst_supply * exchange_rate`).
- **Known stress scenarios:**
  - **Baseline smoke** — normal price noise, no perturbation.
  - **Backing markdown / validator slash** — mark down staked backing (a slash)
    while the exchange rate is stale-high and a `panic-exiter`/`arb-redeemer`
    runs the withdrawal queue; swept as `backing_markdown_bps`. The signal is
    realized redeemed value per share versus true backing (first-mover
    dilution), not the posted exchange rate.

## stablecoin

- **Known personas:** `cautious-minter`, `leverage-looper`, `panic-redeemer`,
  `arb-redeemer`.
- **Known invariants:**
  - `backing_ratio` — collateral backing stays `>= 1` (100%) once supply and
    backing observations are wired (template).
- **Known stress scenarios:**
  - **Baseline smoke** — normal price noise, no perturbation.
  - **Collateral crash under redemption race** — drop the collateral oracle
    while `panic-redeemer`/`arb-redeemer` race the redemption/PSM path; swept
    as `collateral_price_drop_bps`. The signal is realized redeemable collateral
    per unit for the *marginal* (last) redeemer, not the peg or total supply.

## orderbook

- No prebuilt persona/invariant/scenario bucket ships for orderbooks — derive
  from the target program's match/settle flows. Settlement is a keeper-driven
  third-party flow (**Trigger C**): model the keeper/matcher/settler as a
  distinct actor operating on positions/orders it does not own. The worst case
  is typically a settle/match at a stale or crossed price; sweep the price
  staleness / spread-cross magnitude and measure realized fill value versus a
  fair reference.

## custom / other

- No family bucket. Fall back to the generic persona pool, derive invariants
  from the program's own conservation laws (what quantity must be conserved,
  bounded, or monotonic?), and pick the swept axis from the single most
  economically consequential exogenous input the P0 flow reads (a price, a
  rate, an attestation, a demand fraction). The A–F triggers in
  [detect-and-scope.md](./detect-and-scope.md) tell you which authoring
  patterns that input forces.

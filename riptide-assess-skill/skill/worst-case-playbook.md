# Worst-Case Playbook

Per-archetype authoring guidance for guided-sim assessments. The riptide-assess
skill loads this file when the execution-path classification returns
`guided-sim-authored`: the archetype from the classification note selects an
entry, and the entry tells the authoring pass what worst case to hunt before
any code is written.

Every entry uses the same fields:

- **Worst case to hunt** — the economically real failure this archetype is
  exposed to, stated as a concrete scenario against the target program, not a
  generic category.
- **Swept axis** — the exogenous stress parameter to sweep (declared as
  `[sim.sweep]` in `.riptide/sim/Riptide.toml`) and the range that brackets
  the interesting region.
- **Deciding invariant / metric** — the invariant or metric whose movement
  decides the verdict, with the severity that makes the failure gradient
  visible on the risk surface.
- **Signal trap** — where a naive measurement reads flat while the real
  signal moves; name the field to measure instead.
- **Honest framing** — how to state the result: inherent risk versus bug,
  the swept axis as exogenous stress rather than a protocol knob, and the
  reminder that a held invariant across the full sweep is a robustness
  result, not a failed assessment.

If the target program's archetype has no entry here (a niche or hybrid family),
derive the worst case from the target program's actual P0 flows and its
conservation laws, and keep the five fields above as the working structure. The
[family-library.md](./family-library.md) entry for the family names the personas,
invariants, and stress scenarios these entries build on.

## irs (interest-rate swap)

- **Worst case to hunt:** The LP pool is the unhedged counterparty to a
  one-sided book under a rate move that goes against it. A balanced book
  self-hedges and shows zero LP loss, so seed the **adversarial** book: every
  trader on the same side (e.g. all-PayFixed), then shock the rate index in the
  direction that makes that side win. The pool pays the winners. Run the full
  lifecycle on the real program: LPs deposit → traders `open_swap` (all one
  side) → a rate-index shock via the program's oracle setter → `settle_period`
  → third-party `liquidate_position` → LP `request_withdrawal`, with negative
  controls (a stale-index `open_swap` must reject; a healthy-position
  liquidation must reject).
- **Swept axis:** Rate-shock magnitude in bps (the exogenous market rate move),
  bracketed from `0` (healthy control) up to just under the program's
  per-period rate breaker — e.g. `rate_shock_bps ∈ {0, 100, 200, 300, 400, 490}`
  under a 5%/period breaker. Declare it `[sim.sweep]` with a healthy `0` control.
- **Deciding invariant / metric:** Metric `lp_outflow` — the LP pool's payout
  to the winning side, summed from each position's realized PnL. The deciding
  invariant fires (error-severity, e.g. `lp_outflow_material`) when outflow
  crosses a **stated** risk line (e.g. 1% of seeded reserve), which gives the
  surface a visible gradient; the hard solvency bound
  (`collateral_vault + lp_vault` covers all claims, no `unpaid_pnl`) is checked
  separately and is expected to hold.
- **Signal trap:** Measure **`realized_pnl` summed across positions**, not
  `lp_nav` or an LP-share token balance. The pool's bookkeeping NAV field can
  read flat while value is actually flowing to the winning traders; the real
  outflow only shows up in the positions' settled PnL. Reading the stub-inert
  NAV field is how an agent concludes "no signal" on a pool that is in fact
  bleeding.
- **Honest framing:** Directional LP P&L under a one-sided book is the
  **inherent risk an LP underwrites**, not a protocol bug — a balanced book
  hedges it away. The rate shock is an **exogenous** market move, not a protocol
  knob, so the report's "keep `rate_shock_bps` in {…}" line must be reframed as
  a statement about where the outflow threshold sits (a surface fact), not a
  tuning instruction. Solvency holding across the whole sweep is a **robustness
  result** worth stating plainly; the heatmap "failure rate" is the rate at
  which outflow crossed the chosen line, not an insolvency rate. If an external
  reserve is inert in stub-oracle mode, say the on-chain threshold is a
  conservative (early) bound. *(Validated on a real interest-rate-swap protocol: solvency held to the 490
  bps breaker; LP outflow crossed 1% of the $1M reserve above ~300 bps.)*

## lending

- **Worst case to hunt:** A collateral price crash that **outruns** liquidation,
  so recovery is capped below the outstanding debt and the lender (or protocol)
  eats the shortfall as bad debt. The realistic worst case is the crash landing
  **before** the liquidator reacts — and check *who* may liquidate: if
  `liquidate_loan` is permissioned (lender-only, or keeper-only) there is no
  third-party backstop on an active position, which widens the exposure window.
  Run the lifecycle on the real program: borrower posts collateral at the
  healthy ratio → lender funds → **crash the collateral oracle by the swept
  bps** → liquidate → measure recovered collateral vs outstanding debt. Negative
  control: a healthy (un-crashed) loan must reject liquidation.
- **Swept axis:** Collateral crash magnitude in bps (exogenous price move),
  bracketed across and past the liquidation threshold — e.g.
  `collateral_price_drop_bps ∈ {0, 1000, …, 6000}` (0–60%) so the surface spans
  both the "liquidation becomes eligible" knee and the "collateral < debt" onset.
  Crash via the **oracle account bytes** (see the Pyth `PriceUpdateV2` helper in
  the authoring patterns), not a primitive argument.
- **Deciding invariant / metric:** Metric `bad_debt` — the USD shortfall
  (`outstanding_debt − recovered_collateral_value`, clamped at zero) the lender
  absorbs. The invariant fires (e.g. `lender_bad_debt`) when bad debt crosses a
  stated line (e.g. 1% of debt value). Note the **two** thresholds the gradient
  reveals: liquidation becomes *available* at one crash level (the
  `liquidation_threshold` ratio) but the lender stays whole until a *later*
  level where collateral value crosses below debt — report both.
- **Signal trap:** Measure the **realized shortfall** from actual recovered vs
  owed value after the liquidation transaction runs — not a health-factor or
  LTV field, and not "did liquidation succeed." Liquidation can transition the
  loan to `Liquidated` correctly (status flips, accounting is right) while the
  lender still eats bad debt; an agent that checks only the status byte or a
  pre-crash health ratio reads "liquidation worked → safe" and misses the
  shortfall entirely. The signal is the money, measured post-liquidation.
- **Honest framing:** Bad debt when a crash outruns liquidation is the
  **inherent risk of collateralized lending**, not an accounting bug — the
  liquidation math is doing exactly what it should (payout capped at collateral
  held). The crash is **exogenous**. Surface the permissioning nuance as a
  deliberate design question (no third-party backstop on an active underwater
  loan), not a defect. If you drive the oracle directly, state the oracle's own
  staleness/confidence/verification guards are out of scope — you are isolating
  the protocol's response to a price *path*. *(Validated on a real lending protocol: liquidation
  accounting correct at every level; lender bad-debt onset at ~33% crash —
  liquidation eligible at ~20%, lender whole until ~33%; `liquidate_loan`
  lender-only.)*

## nav-vault

- **Worst case to hunt:** A first-mover dilution run: a real asset markdown lands
  on the vault while a **stale-high** NAV attestation is still inside its
  freshness/TTL window, so an early withdrawer can redeem against the stale-high
  NAV and drain value from the investor who stays. Run the lifecycle on the real
  program: initialize → two investors `deposit` at par against a fresh
  attestation → a real asset markdown of the swept magnitude lands **while the
  prior high attestation is still in-window** (not yet refreshed) → the early
  investor `initiate_withdrawal` → `finalize_withdrawal` under the stale-high NAV
  → the staying investor withdraws against the refreshed, true NAV. Measure how
  much the early mover extracted beyond fair share and how much the stayer lost.
- **Swept axis:** Markdown magnitude in bps of real vault assets lost while the
  high attestation is in-window — e.g. `nav_markdown_bps ∈ {0, 500, …, 5000}`
  (0–50%). `0` is the **positive control**: a fresh-and-true NAV must pay exact
  pro-rata (this is the baseline the execution-honesty gates require).
- **Deciding invariant / metric:** Metrics `dilution_loss` (the stayer's
  shortfall vs fair value) and `early_overpayment` (the runner's excess over
  fair value), both in base units. The invariant fires (e.g. `investor_dilution`)
  when `dilution_loss` crosses a stated line (e.g. 1% of the stayer's fair
  value). A flat-zero `dilution_loss` across the full markdown sweep is the
  robustness result — but it is only meaningful if the positive control passed
  and the withdrawal lifecycle actually executed (both enforced by the
  execution-honesty gates).
- **Signal trap:** Measure the **realized payout deltas** — `a_payout`/`b_payout`
  vs each investor's `fair_value` (i.e. vault-drain), the value that actually
  left the vault — not the attested NAV field. The NAV number is a
  trusted-but-bounded *input* you constructed; reading it back tells you nothing
  about whether value was extracted. A stale-high NAV that merely raises a
  one-sided cap (payout = `min(real_pro_rata, nav_value × fraction)`) never binds
  upward, so the drain is zero *because of the cap's direction* — which you can
  only see by measuring payouts, not the NAV.
- **Honest framing:** A held (flat-zero) surface is **evidence over the tested
  region, not unconditional safety** — say so explicitly. The markdown is an
  exogenous asset-value move; the NAV attestation is trusted-but-bounded (you
  test the mechanics' response to a NAV *path*, not the attestor's honesty — the
  authority signer, TTL cap, and value cap are the controls on the attestation
  itself and you rely on them). When the guard holds, explain the **structural
  reason** (e.g. the NAV cap is one-sided and can only *lower* a payout priced
  off the real vault balance) rather than asserting safety. *(Validated on
  a real NAV-vault protocol: zero dilution across 0–50% markdown; the audit-fix NAV cap held
  structurally; positive control at markdown 0 paid exact pro-rata.)*

## amm

AMMs frequently classify as `baseline-sim` — primitive swap args, self-signed
actions, no externally owned bytes to evolve. When they do, run the sweep below
inside the same crate; the worst case is still worth hunting.

- **Worst case to hunt:** Value leaking *below* the constant product net of fees
  — not the LP impermanent loss an arbitrageur realizes when an exogenous
  external-market price move lets them rebalance the pool (that is inherent LP
  risk), but a rounding/fee-accounting path where `k` actually decreases, so the
  pool is drained beyond what IL explains. Run the lifecycle on the real
  program: LP `add_liquidity` → an `arbitrageur` swaps the pool toward the
  shocked external price over several ticks → LP `remove_liquidity`. Compare LP
  redeemable value to a hold baseline, and watch `k` across every swap.
- **Swept axis:** External price divergence in bps — how far the paired asset's
  market price moves away from the pool's implied price, `price_divergence_bps ∈
  {0, 500, …, 5000}` (0–50%). `0` is the positive control: no divergence must
  leave `k` and LP value flat.
- **Deciding invariant / metric:** Metric `lp_value_delta` — LP redeemable value
  at exit minus the hold-both-tokens baseline, which isolates protocol-induced
  leak from ordinary IL. The invariant `k_non_decreasing` (`k_after >= k_before`
  net of fees) fires error-severity on any true value leak — that, not the IL
  magnitude, is the defect signal.
- **Signal trap:** Measure **LP redeemable value versus hold**, not the spot
  price or the raw reserve balances. The pool marking to the new price is
  correct behavior; reserves moving is correct behavior. An agent that reads
  "price moved, reserves moved" concludes "working as designed" and misses a
  fee-rounding drain that only shows up as `k` slipping below its pre-swap value.
- **Honest framing:** Impermanent loss under a price move is the **inherent risk
  an LP underwrites**, not a bug — say so and do not report it as a failure. The
  price divergence is **exogenous**. A `k` that holds (never decreases net of
  fees) across the full sweep is a **robustness result** worth stating plainly;
  only a real `k` decrease is a finding.

## perps

Perps almost always classify as `guided-sim-authored`: liquidation is a
third-party flow (**Trigger C**) and the mark price is an oracle-account read
(**Trigger B**).

- **Worst case to hunt:** A mark-price **gap** that blows through maintenance
  margin faster than liquidation can act, so the liquidation recovers less than
  the position's loss and the shortfall socializes — onto the counterparty, the
  insurance fund, or (via ADL) profitable traders. Run the lifecycle on the real
  program: trader opens a leveraged position at healthy margin → funding accrues
  → **gap the mark oracle past the maintenance-margin band in one step** → a
  third-party `liquidator` liquidates → measure recovered margin vs the
  position's realized loss. Negative control: a within-margin position must
  reject liquidation.
- **Swept axis:** Mark-price gap in bps past the maintenance-margin threshold
  (exogenous), bracketed from `0` through and past the point where the loss
  exceeds posted margin — e.g. `mark_gap_bps ∈ {0, 500, …, 4000}`. Gap via the
  **oracle account bytes** (the Pyth `PriceUpdateV2` helper), not a primitive
  argument. `0` is the positive control.
- **Deciding invariant / metric:** Metric `socialized_loss` — the shortfall
  (`position_loss − recovered_margin`, clamped at zero) that lands on someone
  other than the position holder, plus `insurance_fund_drawdown`. The invariant
  `no_socialized_loss` fires when the shortfall crosses a stated line. Note the
  two knees: liquidation becomes *eligible* at one gap level, but the fund stays
  whole until a *later* level where the loss exceeds posted margin — report both.
- **Signal trap:** Measure the **realized shortfall after liquidation runs** —
  not "did liquidation fire", not the pre-gap leverage or margin ratio.
  Liquidation can execute perfectly (position closes, status flips) while the
  recovered margin still falls short of the loss; an agent that checks only the
  close succeeded reads "liquidation worked → safe" and misses the socialized
  loss. The signal is the money the fund/counterparty absorbs, measured post-fill.
- **Honest framing:** Gap risk beyond maintenance margin is the **inherent risk
  of leveraged perps**, not a liquidation bug — the engine is capping recovery
  at margin held, exactly as it should. The gap and the funding rate are
  **exogenous** market inputs, not protocol knobs. An insurance fund that
  absorbs every gap across the sweep is a robustness result; only a fund
  *breach* (socialized loss reaching real traders) is a finding.

## lst

LSTs often classify as `baseline-sim` for the steady stake/unstake path, but a
withdrawal queue with a keeper crank is `guided-sim-authored` (**Trigger C/D**).

- **Worst case to hunt:** A first-mover run on the withdrawal queue while backing
  is **stale-high** — a validator slash or reward-loss marks down real staked
  backing, but the posted exchange rate has not caught up, so an early
  `panic-exiter`/`arb-redeemer` redeems LST at the stale-high rate and dilutes
  the staker who stays. Run the lifecycle on the real program: two stakers
  `stake` at par → a backing markdown of the swept magnitude lands **while the
  exchange rate is still stale-high** → the early staker runs `unstake` /
  withdrawal-queue redemption at the stale rate → the staying staker redeems
  against the refreshed, true rate. Measure the early mover's excess and the
  stayer's shortfall.
- **Swept axis:** Backing markdown in bps of staked value lost while the rate is
  stale-high — `backing_markdown_bps ∈ {0, 500, …, 5000}` (0–50%, a slash).
  `0` is the positive control: fresh-and-true backing must redeem exact
  pro-rata.
- **Deciding invariant / metric:** Metrics `dilution_loss` (the stayer's
  shortfall vs fair backing) and `early_overpayment` (the runner's excess),
  in base units; plus a hard `pool_solvent` check (redeemable backing covers
  outstanding LST at the true rate). The invariant `staker_dilution` fires when
  `dilution_loss` crosses a stated line. Flat-zero across the sweep is the
  robustness result — meaningful only if the positive control passed.
- **Signal trap:** Measure **realized redeemed value per share** for each staker
  vs their fair backing, not the posted exchange rate. The rate is a
  trusted-but-lagging *input*; reading it back tells you nothing about whether
  value was extracted. The drain only shows in the payout deltas between the
  runner and the stayer.
- **Honest framing:** A slash is an **exogenous** backing-value move, not a
  protocol bug; first-mover advantage in a redemption queue is a **design
  property** to surface (does the rate refresh before redemptions can race it?),
  not a defect. A held (flat-zero) dilution surface is **evidence over the tested
  region, not unconditional safety** — and when the guard holds, explain the
  structural reason (e.g. the rate refreshes atomically before any redemption).

## stablecoin

Stablecoins usually classify as `baseline-sim` for mint/redeem, tipping to
`guided-sim-authored` when redemption reads an oracle account (**Trigger B**) or
runs a PSM keeper (**Trigger C**).

- **Worst case to hunt:** A collateral crash that drives backing **below 100%**
  while redemptions race, so the reserve is drained by early redeemers and the
  **marginal (last) redeemer** cannot be made whole — the shortfall is
  under-collateralization, not a mint bug. Run the lifecycle on the real
  program: minters `mint` against healthy collateral → **crash the collateral
  oracle by the swept bps** → `panic-redeemer`/`arb-redeemer` race the
  redemption/PSM path → measure realized redeemable collateral per unit for the
  first vs the last redeemer. Negative control: a fully-backed redemption must
  pay par.
- **Swept axis:** Collateral price drop in bps (exogenous), bracketed across and
  past the point where backing crosses 100% — e.g. `collateral_price_drop_bps ∈
  {0, 1000, …, 6000}` (0–60%). Crash via the **oracle account bytes**, not a
  primitive argument. `0` is the positive control.
- **Deciding invariant / metric:** Metric `redemption_shortfall` — par value owed
  minus realized collateral paid for the marginal redeemer — and `backing_ratio`
  (total collateral value / outstanding supply). The invariant `fully_backed`
  (`backing_ratio >= 1`) fires when backing crosses below par; the shortfall
  metric shows *who* eats it. Report both the crash level where backing crosses
  100% and the level where the last redeemer starts taking a haircut.
- **Signal trap:** Measure the **realized redeemable collateral per unit for the
  last redeemer**, not the peg price, the oracle, or total supply. A stablecoin
  can hold its quoted peg and keep minting/redeeming correctly right up until the
  reserve empties; an agent that watches the peg reads "still $1 → safe" and
  misses that late redeemers are being paid in cents. The signal is the
  marginal redemption, measured post-crash.
- **Honest framing:** Under-collateralization under a large enough collateral
  crash is the **inherent risk of collateralized stablecoins**, not an accounting
  bug — redemptions are paying out exactly the collateral held. The crash is
  **exogenous**. Backing that holds `>= 1` across the whole sweep is a
  **robustness result**; the "failure rate" on the surface is the rate at which
  the marginal redeemer took a haircut, not a de-peg probability.

## orderbook

Orderbooks classify as `guided-sim-authored`: settlement and matching are
keeper-driven third-party flows (**Trigger C**), often multi-instruction
(**Trigger D**). No prebuilt bucket ships — derive from the program's real
match/settle flows.

- **Worst case to hunt:** A settle or match that fills at a **stale or crossed**
  reference price, letting one side extract from the counterparty, or a
  settlement that leaves an **unmatched obligation** the program cannot honor.
  Run the lifecycle on the real program: maker posts an order → taker crosses →
  a third-party keeper `settle`/`match` runs → measure realized fill value vs a
  fair mid, and check every matched obligation is fully settled. Model the
  keeper/matcher as a distinct actor operating on orders it does not own (use
  `ThirdPartyDispatch`). Negative control: a settle against a non-crossed book
  must reject.
- **Swept axis:** Reference-price staleness or spread-cross magnitude in bps —
  how far the settlement price may lag the true mid before a fill becomes
  extractive, `settle_staleness_bps ∈ {0, 250, …, 2500}`. `0` (fresh reference)
  is the positive control: a fair-priced settlement must transfer exact value.
- **Deciding invariant / metric:** Metric `settlement_value_delta` — realized
  fill value minus fair-mid value for the disadvantaged side — and
  `unmatched_obligation` (base units of any obligation left unsettled after the
  crank). The invariant `conserves_value` (total in == total out across the
  match) fires on any leak; `settlement_value_delta` shows the extraction
  gradient.
- **Signal trap:** Measure **realized fill value vs a fair reference**, not "did
  the match/settle instruction succeed". A settle can complete cleanly (orders
  clear, status flips) while filling at a stale price that hands value to one
  side; an agent that checks only the crank succeeded reads "settlement worked →
  safe" and misses the extraction. The signal is the value transferred vs fair,
  measured after the crank.
- **Honest framing:** Settlement is a **keeper-driven third-party flow** — model
  the keeper explicitly, don't self-sign it. Price staleness is an **exogenous**
  input (how fresh the keeper's reference is), not a protocol knob. A book that
  conserves value and settles every obligation across the full staleness sweep
  is a **robustness result**; only a value leak or an unmatched obligation is a
  finding.

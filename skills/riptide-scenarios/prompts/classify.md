# Classify: plausible failure modes from program shape

You are running inside a Claude Code session invoked via the
`riptide-scenarios` skill. Your job right now is to read the
adapter TOML + IDL you already have in working memory and decide
which *classes* of failure mode are plausible for **this specific
program**. This is the classification step — the proposal step runs
later. Do not jump to experiments.

The goal is to produce a short working-memory note of the form:

    classification:
      whale_concentration:                flagged | not-applicable   # with reason
      shock_cascades:                     flagged | not-applicable   # with reason
      utilization_stress:                 flagged | not-applicable   # with reason
      persona_mix_instability:            flagged | not-applicable   # with reason
      oracle_lag:                         flagged | not-applicable   # with reason
      margin_cascade_from_oracle_shock:   flagged | not-applicable   # with reason
      open_interest_imbalance:            flagged | not-applicable   # with reason
      socialized_loss_accumulation:       flagged | not-applicable   # with reason

Every `flagged` line must carry a one-sentence justification that
points at a concrete feature of the adapter or IDL. Every
`not-applicable` line must say why the program shape rules the
category out. **A category flagged with no adapter-side hook is not
classification — it is boilerplate. Do not do that.**

## The five categories and the hooks that justify them

The following is a hook library. You are not required to flag every
category that has a hook; you **are** required to cite at least one
hook when flagging, and cite the adapter-side shape ruling it out
when not flagging. The point of this list is to force the
classification step to touch the adapter surface — not to hand you
the answer.

### whale_concentration

> "What happens if one participant is much bigger than the rest of
> the population, and the program offers no per-account cap or no
> concentration guardrail?"

Adapter-side hooks that justify flagging:

- `protocol = "lending"` AND the adapter exposes all five lending
  actions (deposit / borrow / repay / withdraw / liquidate). A
  fungible-pool lending market with a single shared reserve has no
  per-account borrow cap by construction — a sufficiently large
  single position can dominate pool utilization and dictate the
  liquidation path.
- A `generic` adapter whose `state_mapping` exposes a single shared
  pool / reserve / treasury / vault / marketplace-listings
  accumulator and whose actions include at least one that *writes
  into* that accumulator without a visible cap. A lone actor can
  capture outsized share of it.
- The IDL accounts include a shared reserve or pool account that
  every instruction mutates, and the per-agent accounts are thin
  (no borrow ceiling stored on the per-agent struct).
- The adapter-declared personas (generic only) include at least one
  whose action weights are lopsidedly skewed toward a single write
  action (a bot-like persona), which is itself evidence the program
  is vulnerable to concentration.

Hooks that rule it out:

- The program is an isolated-position market where each agent has
  its own independent vault and positions cannot interact. A whale
  cannot affect another agent's outcome.
- The adapter's `state_mapping` contains no accumulator — every
  observation is per-agent and there is no shared pool state.

### shock_cascades

> "What happens if an external input (price, oracle, feed, market
> demand) moves sharply and a second-order effect amplifies it?"

Adapter-side hooks that justify flagging:

- `protocol = "lending"` — any collateralized lending primitive is
  exposed to the collateral-price → liquidation-cascade path by
  definition. Solend-style markets are the textbook case.
- A `generic` adapter whose state_mapping exposes a price-like or
  cost-like observation that persona triggers can react to (e.g.
  `price_drop_percent` triggers are defined, or the adapter's
  observations include a market price the engine can shock).
- Personas defined in the adapter include `triggers` of type
  `price_drop_percent`, `health_factor_below`, or
  `portfolio_drawdown`. The presence of those triggers is evidence
  the program participants will react in a correlated way to a
  sharp move.

Hooks that rule it out:

- No price/cost observation in `state_mapping`. The program has no
  exogenous shock surface the engine can bump.
- All persona triggers are time-based or idle-based, with no
  reaction to observable state.

### utilization_stress

> "What happens when the program is driven near its capacity / rate
> limit / liquidity floor for a sustained period?"

Adapter-side hooks that justify flagging:

- `protocol = "lending"` with a shared pool — utilization above a
  kink point drives borrow rates nonlinearly, which can feed back
  into persona trigger thresholds.
- `generic` with a shared-capacity account (marketplace listings
  cap, mineable resource with finite supply, throughput-capped
  endpoint) whose state_mapping exposes the aggregate.
- Personas whose action_rate_multiplier is >1.0 or whose action
  weights skew toward one write verb — sustained pressure is
  plausible.

Hooks that rule it out:

- Per-agent isolation with no shared resource to stress.
- Adapter personas all have action_rate_multiplier <= 1.0 AND no
  trigger-based bursting.

### persona_mix_instability

> "What happens when the *ratio* of persona types in the population
> shifts — e.g. the bot / casual / cautious mix that the program
> was implicitly tuned around?"

Adapter-side hooks that justify flagging:

- `generic` adapters that declare three or more personas in the
  `[personas]` table with meaningfully different action-weight
  vectors. A mix instability sweep is directly expressible as
  varying the agent counts assigned to each.
- `lending` adapters, with the caveat that the CLI fallback
  persona catalog is thin — flag if you plan to mix the whale
  persona against a cautious / steady persona, not otherwise.

Hooks that rule it out:

- The adapter declares exactly one persona, or no personas. There
  is no mix to instability-test.

### oracle_lag

> "What happens if an oracle / feed / off-chain input is stale or
> delayed — does the program make decisions on the old value?"

Adapter-side hooks that justify flagging:

- `protocol = "lending"` with a collateral-price observation — any
  lending market is exposed to price-feed lag against liquidation
  thresholds.
- `generic` adapters whose state_mapping includes a `price`,
  `oracle`, `feed`, or `rate` observation that triggers read.
- The IDL exposes an account holding a last-updated timestamp
  alongside a numeric feed value.

Hooks that rule it out:

- No oracle-like observation in state_mapping. The program has no
  external input the engine could lag.

## Perps-specific categories

The spec (R3.4) originally listed four perps categories. One was
dropped as a downstream consequence of the T07 perps-lite scope cut:

- **`funding_rate_manipulation` — DROPPED.** The perps-fork program
  shipped without `update_funding_rate` (Sprint 5 scope cut). No
  funding rate instruction exists in the IDL, and no `funding_rate`
  observation is declared in the adapter. There is nothing for the
  hook to fire on. This category will be added in a future sprint
  when funding rate lands.

The remaining three categories apply to perpetual-futures-shaped
programs. Their hooks read the **IDL instruction list** (at the path
declared in the adapter's `idl_path` field), not just the adapter's
`[actions]` block — because the perps-specific instructions
(`open_position`, `close_position`, `liquidate_position`) may not be
runtime-dispatchable in the adapter's `[instructions]` table but are
still present in the IDL and define the program's economic shape.

**How to read the IDL for classification:** if the adapter declares
`idl_path`, load the JSON file at that path and inspect its
`instructions[].name` list. The IDL instruction names — combined with
the adapter's `[observations]` and `[state_mapping]` — are the
classification surface for perps hooks. Do NOT fall back to the
adapter's `[instructions]` or `[actions]` blocks alone for these
categories; those only reflect the runtime-dispatchable subset.

### margin_cascade_from_oracle_shock

> "What happens if a sharp oracle price move pushes leveraged
> positions below the liquidation threshold, triggering cascading
> liquidations that amplify the original shock?"

Adapter-side + IDL hooks that justify flagging:

- The IDL (at `idl_path`) declares an `open_position` instruction
  whose args include a leverage or notional parameter (e.g.
  `leverage_bps`, `notional`), AND a `liquidate_position` instruction
  — confirming the program supports leveraged positions that can be
  force-closed.
- The adapter's `[observations]` expose `market.total_oi_long` AND
  `market.total_oi_short` (aggregate open interest exists and is
  observable), AND per-position fields like `position.collateral`,
  `position.notional`, `position.liquidated` — confirming individual
  positions can be tracked through a liquidation event.
- The adapter's `[observations]` expose a leverage-related config
  field (e.g. `market.max_leverage_bps` or
  `market.liquidation_threshold_bps`) — confirming the program has
  a margin/leverage framework.

All three sub-hooks must be present to flag. This is the strongest
perps category — it directly models the Mango Markets 2022 failure
shape (oracle shock → margin calls → cascading liquidations →
protocol-level loss).

Hooks that rule it out:

- The IDL does not declare `open_position` or `liquidate_position`
  (or equivalents with leverage args). The program does not support
  leveraged positions.
- The adapter has no open-interest or position-level observations.
  There is nothing to cascade.
- `protocol = "lending"` — lending markets have their own
  collateral-liquidation path (`shock_cascades`) which is already
  covered. This category is specifically for leverage-on-derivatives,
  not collateralized lending.

### open_interest_imbalance

> "What happens when one-sided flow creates a systemic skew in open
> interest, concentrating risk on one side of the market?"

Adapter-side hooks that justify flagging:

- The adapter's `[observations]` expose **separate**
  `market.total_oi_long` AND `market.total_oi_short` fields — the
  program tracks long and short open interest independently, making
  the imbalance observable.
- The IDL declares `open_position` with a `side` argument (or
  equivalent that distinguishes long from short) — confirming agents
  can take directional positions that contribute to one side of the
  OI ledger.

Both sub-hooks must be present. The interesting axis is the ratio
of long-to-short OI, not the absolute level.

Hooks that rule it out:

- The adapter does not expose separate long/short OI observations.
  Even if the IDL has `open_position`, the imbalance is not
  observable — and unobservable failure modes are not classifiable.
- The program is a lending market (`protocol = "lending"`) — lending
  has utilization stress, not OI imbalance.
- The adapter's observations show only a single aggregate OI field
  (no long/short split). The skew cannot be measured.

### socialized_loss_accumulation

> "What happens when liquidation proceeds are insufficient to cover
> the position's debt and the protocol socializes the loss across
> remaining participants?"

Adapter-side hooks that justify flagging:

- The adapter's `[observations]` expose a
  `market.cumulative_socialized_loss` field (or equivalent: any
  observation tracking cumulative losses that exceed individual
  position margin).
- The IDL declares a `liquidate_position` instruction — confirming
  the program has a liquidation path where shortfall can occur.

Both sub-hooks must be present. This category replaces the spec'd
`insurance_fund_drain` — the economic failure mode is identical
(losses exceed posted margin, protocol absorbs the difference) but
the observable field is `cumulative_socialized_loss` rather than
`insurance_fund_balance`.

Hooks that rule it out:

- No `cumulative_socialized_loss` or equivalent loss-accumulator
  observation in the adapter. Without a loss counter, the failure
  mode is not observable.
- The program is a lending market — lending tracks `bad_debt` through
  a different mechanism already covered by `shock_cascades`.
- The IDL has no liquidation instruction. Without forced closure,
  there is no path to shortfall.

## Output

Record the classification in working memory using the exact table
shape at the top of this file. Then proceed to
`skills/riptide-scenarios/prompts/propose.md`.

You do not need to emit machine-readable JSON. The classification
step and the proposal step happen in the same session; working
memory is the channel.

## Self-check before proceeding

Before moving on, answer these two questions to yourself:

1. **Could a different adapter — one with a different `protocol`,
   different instructions, different state_mapping — have produced
   a *different* classification table?** If the answer is no, the
   classification is not reading the adapter. Re-read the adapter
   and retry.
2. **Is every `flagged` line traceable to a concrete hook in the
   adapter TOML or the IDL you have loaded?** If any flag is
   unsupported, drop it to `not-applicable`.

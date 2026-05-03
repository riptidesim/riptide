# Propose: turn a classification into 3–5 ranked experiments

You have already run `classify.md` and produced a working-memory
table of `flagged` / `not-applicable` for the five failure-mode
categories. Now turn each *flagged* category into one concrete
experiment, rank them, and write the top 3–5 to disk.

## Rules

0. **Choose output mode first. User repo mode is the default after
   `riptide init`.** If the target adapter lives under
   `.riptide/adapters/*.toml`, personas stay inline in the adapter and
   scenarios are just `.riptide/scenarios/<slug>/run-config.json` files.
   Do not write `policies.json` in user repo mode. Do not write fixture
   `manifest.json` files in user repo mode. `policies.json` is
   fixture-mode only, for scenarios intentionally written under
   `fixtures/scenarios/**`.

1. **One experiment per flagged category, minimum.** If
   classification flagged `whale_concentration`, you owe the user
   an experiment that stresses whale concentration. If
   classification flagged `persona_mix_instability`, you owe one
   that varies the mix. The flags are promises to the user — don't
   drop a flagged category just because another experiment felt
   more interesting.
2. **You may include at most one *composite* experiment** that
   stresses two flagged categories at once (e.g.
   `whale_concentration` × `shock_cascades` on a lending market).
   Composites must cite both hooks in the rationale.
2a. **Whale × shock grid rule (lending adapters).** When
    classification flagged **both** `whale_concentration` **and**
    `shock_cascades` on a `protocol = "lending"` adapter, you
    **must** emit a single combined `whale-shock-grid` proposal —
    a 2D grid that crosses the whale-share axis with the
    collateral-shock-magnitude axis — **instead of** the two
    separate 1D sweeps (`whale-share-sweep` and
    `shock-magnitude-sweep`). Use the same axis values you would
    have picked for the 1D sweeps (e.g. whale share 5% / 15% / 25%
    × shock magnitude 20% / 30% / 40% → a 3×3 grid, nine cells
    minimum). The rationale must explain that pool-level
    concentration and collateral price pressure **interact**: bad
    debt on a fungible-reserve lending market materializes where
    the two axes meet, and neither 1D sweep alone catches the
    combined effect.

    **Materialize every cell as a bootable sub-scenario.** Do not
    emit only the midpoint. If you produce nine cells in the
    rationale you owe nine bootable run-configs on disk — the
    grid's job is to let the user actually fire the corner cell
    (e.g. w25-s40, the Solend June 2022 coordinates), which they
    cannot do if only the middle cell has a `run-config.json`.
    In monorepo fixture mode, the on-disk layout mirrors the shipping hero grid at
    `fixtures/scenarios/lending/hero-grid/` — read that
    directory as the authoritative shape reference:

        fixtures/scenarios/<adapter-stem>/whale-shock-grid/
          manifest.json # grid-level metadata (not a bootable scenario)
          w5-s20/ # one subdir per (whale%, shock%) cell
            run-config.json
            policies.json
            manifest.json # per-cell scenario manifest
          w5-s30/
            …
          w25-s40/ # Solend June 2022 cell
            run-config.json
            policies.json
            manifest.json

    One subdirectory per cell, named `w<whale_pct>-s<shock_pct>`
    using bare integer percentages with **no leading zero**
    (`w5-s20`, not `w05-s20`) — match the hero grid's naming
    exactly. Each cell is a full bootable scenario triple and
    must validate on its own via
    `riptide scenarios --validate <cell-dir>`.

    **How the two axes are encoded.** The whale-share axis is
    encoded by the ratio of whale persona entries in the cell's
    `run-config.json::personas` list — with 20 agents, 5% = 1
    whale, 15% = 3 whales, 25% = 5 whales (see hero-grid cells for
    the exact list shape). The shock-magnitude axis is **not** a
    run-config field: the engine reads shock magnitude from the
    `RIPTIDE_PRICE_SHOCK_DROP` env var at run time, so every cell's
    `run-config.json` sets `"scenario": "price-shock"` and the
    s20/s30/s40 distinction lives only in the cell name, the
    cell's `output_path`, and the manifest rationale. This means
    three cells in a fixed-whale row (e.g. w5-s20, w5-s30, w5-s40)
    share byte-identical `run-config.json` except for
    `output_path`, and share byte-identical fixture-mode policy catalogs. This
    mirrors the hero grid exactly — do not invent a new
    shock-encoding field.

    **Cell manifests vs. grid manifest.** Each *cell's*
    `manifest.json` is a standard scenario manifest (shape given
    under "File shapes" below) with
    `failure_mode: "whale_concentration"` as the primary and
    `shock_cascades` called out as the secondary in the
    one-sentence rationale, which also cites the cell's
    coordinates — e.g. "Cell (whale 25%, shock 40%) of the
    whale×shock grid — the corner where bad debt on a fungible
    reserve historically materializes under combined concentration
    and price pressure." The *parent*
    `whale-shock-grid/manifest.json` is a grid-level metadata file
    describing the axes, cell list, and combined rationale; it
    does **not** follow the scenario manifest schema (no
    `failure_mode`) because the parent directory is not itself a
    bootable scenario and is never passed to
    `riptide scenarios --validate`.

    This rule is narrow on purpose:
    - If only `whale_concentration` fires (not `shock_cascades`):
      keep the 1D `whale-share-sweep`. Do not synthesize a grid.
    - If only `shock_cascades` fires (not `whale_concentration`):
      keep the 1D `shock-magnitude-sweep`. Do not synthesize a
      grid.
    - If both fire but `protocol != "lending"` (e.g. a generic
      adapter with a shared pool and a price-like observation):
      treat as two separate 1D sweeps, per the existing rules —
      the grid shortcut is specifically licensed by the
      lending-reserve shape.
    The grid proposal counts as the composite from Rule 2 — do
    not *also* emit another composite on top of it.
3. **Rank by uncertainty reduction, not by drama.** The top
   proposal should be the one where the *outcome* is hardest to
   predict from reading the adapter — because that's the
   experiment that teaches the user the most. A sweep across a
   parameter axis beats a single point.
4. **Keep the top 3–5.** Never ship more than 5. Never fewer than
   3, unless classification flagged fewer than 3 categories and
   there is genuinely nothing to propose.
5. Output mode follows the repo shape. In user repo mode
   (`.riptide/adapters/*.toml`), each proposal writes only
   `.riptide/scenarios/<slug>/run-config.json`; personas stay inline
   in the adapter and no fixture `manifest.json` or `policies.json`
   is written. In monorepo fixture mode, each proposal writes exactly
   three files to `fixtures/scenarios/<adapter-stem>/<slug>/`:
   `run-config.json`, `policies.json`, and `manifest.json`. Nothing
   else. *Exception:* the `whale-shock-grid` proposal from Rule 2a
   writes a grid-level `manifest.json` at the slug root plus one
   standard triple per cell subdirectory — see Rule 2a for the full
   layout.
   All later references to `policies.json`, `manifest.json`, scenario
   triples, and `riptide scenarios --validate` are fixture-mode only
   unless a rule explicitly says otherwise.
6. Slugs are kebab-case and describe the *experiment*, not the
   outcome. `whale-share-sweep` is a good slug;
   `solend-collapse` is not (that's a prediction, not an
   experiment).
7. Never overwrite anything under
   `fixtures/scenarios/lending/hero-grid/`. Those are sealed.

## File shapes

### user repo run-config.json

For `.riptide/scenarios/<slug>/run-config.json`, use the init-runner
shape:

```
{
  "agents":      <positive int>,
  "ticks":       <positive int>,
  "seeds":       <positive int>,
  "scenario":    "<baseline | price-shock | custom>",
  "personas":    { "<adapter-inline-persona-id>": <agent-count>, ... },
  "adapter":     "../../adapters/<adapter-stem>.toml",
  "output_path": ".riptide/runs/<slug>"
}
```

`adapter` is optional when there is exactly one TOML under
`.riptide/adapters/`, but including it makes the scenario portable
inside the scaffolded workspace. Do not include `validator_url` unless
you are writing fixture-style scenarios.

### fixture run-config.json

Matches `cli/src/compiler/schema.ts::RunConfigSchema`. Required
fields:

```
{
  "agents":         <positive int>,
  "ticks":          <positive int>,
  "scenario":       "<baseline | price-shock | custom>",
  "seed":           42,
  "personas":       ["<fixture-persona-id>", …],
  "validator_url":  "http://localhost:8899",
  "output_path":    "fixtures/scenarios/<adapter-stem>/<slug>"
}
```

In fixture mode, `personas` may still be an explicit list for byte-stable
legacy fixtures. In user repos, prefer the count-map form for concrete
mixes; an empty array is acceptable when the adapter-inline persona
catalog should be used in round-robin order.

For fixture-style scenarios generated by this skill,
`validator_url` remains present because `riptide scenarios
--validate` parses with `cli/src/compiler/schema.ts::RunConfigSchema`,
which still requires a non-empty string. The engine runs LiteSVM
in-process and ignores this field. Do not infer this field belongs in
fresh `riptide init` scaffolds; init-generated `.riptide/scenarios/**`
run configs intentionally omit it.

### policies.json (fixture mode only)

`policies.json` is fixture-mode only. Do not write it under
`.riptide/scenarios/**`; user repo personas stay inline in the adapter.

An array of objects matching
`cli/src/compiler/schema.ts::PolicySchema`:

```
{
  "persona_id":       "<kebab-case id>",
  "persona_label":    "<human label>",
  "risk_tolerance":   <0..1>,
  "action_weights":   { "<action>": <number>, … },
  "triggers":         [ … ],
  "position_sizing":  { "strategy": "fixed" | "proportional",
                        "params": { "amount": <number> } },
  "max_exposure":     <0..1>
}
```

For lending experiments, action names must be from the canonical
lending set: `deposit`, `borrow`, `repay`, `withdraw`, `liquidate`.
For generic experiments, action names must match the write-action
keys declared in the target adapter's `[instructions]` table.

If you need a whale persona, duplicate its shape into `policies.json`
for lending primitive scenarios (preferred — keeps each experiment
self-contained) or load the existing fixture library in-session for
reference. Do not write a new `fixtures/personas/<name>.toml` file
unless you are intentionally extending the fixture library. Never
write `.riptide/personas/`; init personas live inline in the adapter
TOML.

### manifest.json (fixture mode only)

```
{
  "adapter":       "fixtures/adapters/<adapter-stem>.toml",
  "slug":          "<same as directory name>",
  "failure_mode":  "<one of: whale_concentration | shock_cascades | utilization_stress | persona_mix_instability | oracle_lag | margin_cascade_from_oracle_shock | open_interest_imbalance | socialized_loss_accumulation | price_manipulation_via_swap | impermanent_loss_spike | jit_liquidity | reserve_depletion>",
  "rationale":     "<one sentence — why this experiment, tying back to the classification hook>"
}
```

`adapter` is a path relative to the monorepo root. The validator
resolves it from there.

The composite-experiment exception: if a proposal stresses two
categories, set `failure_mode` to the *primary* one and mention the
secondary in the rationale.

## Parameter knobs — pick one sweep axis per experiment

A good experiment varies one thing along an axis the classification
identified, and holds everything else constant. Some examples that
map naturally to the five failure modes:

- `whale_concentration` → sweep the *share* of whale-like agents in
  the population (e.g. 5% / 15% / 25%), or sweep the whale's
  `position_sizing.params.amount` while holding the population
  fixed. A single-point whale run is not an experiment; a sweep is.
  If you can only afford one proposal for this category, pick the
  share sweep — that's the one whose outcome is hardest to predict
  from a static read of the program.
- `shock_cascades` → sweep shock magnitude on the
  `price-shock` scenario (20% / 30% / 40%) with a fixed population.
- `utilization_stress` → sweep `action_rate_multiplier` on a
  bot-like persona against a fixed background.
- `persona_mix_instability` → sweep the *ratio* of persona counts
  in `personas[]` (e.g. 50/50 vs 20/80 vs 80/20 for two personas)
  while holding the total agents fixed.
- `oracle_lag` → not expressible as a single-knob sweep on the
  current engine surface. If flagged, propose a baseline run with
  a note in the rationale that oracle lag requires a future engine
  knob and that this proposal is a staging run for when that lands.

A "sweep" in the current engine means *one run config per axis
point, written as sibling directories under the same experiment
slug*. For this version of the skill, only write the middle point
of each sweep — the single representative run — and note the
intended axis in the `rationale`. The hero-grid runner is the full
grid machine; this skill is the entry point.

Concretely: a `whale-share-sweep` proposal is **one** scenario
directory whose `run-config.json` sets the middle whale share
(e.g. 15%), and whose `rationale` says something like "middle point
of a whale-share sweep (5% / 15% / 25%) — the classification
flagged concentration because the adapter exposes a single shared
reserve with no per-account borrow cap".

## Perps-specific proposal rules

The spec (R3.5) originally listed four perps proposal templates,
one per category. One was dropped as a downstream consequence of
the perps-lite scope cut:

- **`funding-rate-oscillation` — DROPPED.** The
  `funding_rate_manipulation` classification category was removed
  because the perpetuals program shipped without
  `update_funding_rate` ( scope cut). No funding rate
  instruction or observation exists, so no proposal can target it.
  This template will be added in a future sprint when funding rate
  lands.

The following three rules apply when classification flags one or
more of the remaining perps-specific categories
(`margin_cascade_from_oracle_shock`, `open_interest_imbalance`,
`socialized_loss_accumulation`). These rules are additive — they
do not replace or modify Rules 1–7 above.

### Rule 8 — Depositor-shock grid (perps adapters)

When classification flagged **`margin_cascade_from_oracle_shock`**,
you **must** emit a `depositor-shock-grid` proposal — a 2D grid
that crosses a **depositor-share axis** with a
**shock-magnitude axis**.

**Why depositor-share × shock instead of leverage × shock.** The
perps adapter's runtime-dispatchable actions may be limited to
`deposit` and `withdraw` (the generic runtime encodes only
single-u64-arg instructions). `open_position` (which takes
leverage + notional args) may not be runtime-dispatchable. The
depositor-share axis is the closest runtime-achievable proxy for
exposure: more agents depositing more collateral = higher total
collateral at risk when the oracle shocks. can upgrade
to a true leverage axis when the generic runtime supports
multi-arg instructions.

**Axis encoding:**

- **Depositor-share axis** — the proportion of agents whose
  persona is weighted toward heavy deposits (simulating
  high-exposure participants). With 20 agents: d25 = 5 heavy
  depositors, d50 = 10 heavy depositors, d75 = 15 heavy
  depositors. Encoded in each cell's `run-config.json::personas`
  list by varying the ratio of a `heavy-depositor` persona vs a
  `light-depositor` persona.
- **Shock-magnitude axis** — same encoding as the lending
  `whale-shock-grid`: the engine reads shock magnitude from the
  `RIPTIDE_PRICE_SHOCK_DROP` env var. Each cell's
  `run-config.json` sets `"scenario": "price-shock"` and the
  s20/s30/s40 distinction lives in the cell name, the cell's
  `output_path`, and the manifest rationale.

**Grid layout** mirrors the `whale-shock-grid` pattern exactly:

    fixtures/scenarios/<adapter-stem>/depositor-shock-grid/
      manifest.json # grid-level metadata (not bootable)
      d25-s20/ # one subdir per (depositor%, shock%) cell
        run-config.json
        policies.json
        manifest.json
      d25-s30/
        …
      d75-s40/ # high-exposure + severe shock corner
        run-config.json
        policies.json
        manifest.json

Cell naming: `d<depositor_pct>-s<shock_pct>` using bare integer
percentages with no leading zero. Each cell is a full bootable
scenario triple and must validate on its own via
`riptide scenarios --validate <cell-dir>`.

**Cell manifests.** Each cell's `manifest.json` uses
`failure_mode: "margin_cascade_from_oracle_shock"` and the
one-sentence rationale cites the cell's coordinates and explains
how depositor share proxies for exposure under the
runtime-dispatchable constraint.

**Materialize every cell.** Same discipline as the lending
`whale-shock-grid` — if the grid has 9 cells, all 9 must be
bootable sub-scenarios on disk. Midpoint-only grids are not
acceptable.

This grid counts as the composite from Rule 2. Do not also emit
another composite on top of it.

**Policies shape for perps grid cells.** Each cell's
`policies.json` declares two persona types:

- `heavy-depositor` — high `risk_tolerance`, deposit-weighted
  `action_weights` (e.g. `{ "deposit": 0.9, "withdraw": 0.1 }`),
  large `position_sizing.params.amount`.
- `light-depositor` — low `risk_tolerance`, balanced
  `action_weights` (e.g. `{ "deposit": 0.5, "withdraw": 0.5 }`),
  small `position_sizing.params.amount`.

Action names must match the target adapter's `[actions]` keys
(typically `deposit` and `withdraw` for a generic perps adapter).

### Rule 9 — OI-imbalance sweep (perps adapters)

When classification flagged **`open_interest_imbalance`**, emit an
`oi-imbalance-sweep` proposal — a 1D sweep varying the ratio of
deposit-heavy agents (proxying for long-biased participants) vs
withdraw-heavy agents (proxying for short-biased or cautious
participants).

Axis: `depositor_ratio ∈ {0.25, 0.50, 0.75}` — the proportion of
agents assigned the deposit-heavy persona. With 20 agents:
0.25 = 5 heavy depositors, 0.50 = 10, 0.75 = 15.

Write only the middle point (0.50) as the representative
run-config, following the 1D sweep convention. The rationale notes
the full sweep range and explains that depositor ratio proxies for
OI directional bias under the runtime-dispatchable constraint
(deposit-heavy agents push `total_oi_long` up indirectly via
collateral accumulation; withdraw-heavy agents pull it back).

`failure_mode: "open_interest_imbalance"` in the manifest.

### Rule 10 — Socialized-loss stress sweep (perps adapters)

When classification flagged **`socialized_loss_accumulation`**, emit
a `socialized-loss-stress` proposal — a 1D sweep of shock severity
under fixed agent composition, measuring whether
`market.cumulative_socialized_loss` climbs.

Axis: shock magnitude via `RIPTIDE_PRICE_SHOCK_DROP` env var,
values `{20, 40, 60}` (percent). Fixed population of 20 agents
with balanced persona mix.

Write only the middle point (40%) as the representative
run-config. The rationale notes the full sweep range and explains
that this experiment isolates the shock-severity → socialized-loss
relationship: at some shock level, liquidation proceeds can no
longer cover the position's debt and losses socialize.

`failure_mode: "socialized_loss_accumulation"` in the manifest.

### Perps manifest failure_mode values

For perps proposals, `failure_mode` in `manifest.json` must be one
of: `margin_cascade_from_oracle_shock`,
`open_interest_imbalance`, `socialized_loss_accumulation`. These
are the perps-specific category names from `classify.md`.

## AMM-specific proposal rules

Four rules apply when classification flags one or more of the
AMM-specific categories (`price_manipulation_via_swap`,
`impermanent_loss_spike`, `jit_liquidity`, `reserve_depletion`).
These rules are additive — they do not replace or modify Rules 1–7
or the perps Rules 8–10 above. The AMM adapter exposes `swap`
(3-arg via the multi-arg builder), `add_liquidity` (2-arg), and
`remove_liquidity` (1-arg) as runtime-dispatchable actions.
AMM-shaped user repos still use `protocol = "generic"` today; do not
invent `amm.v1` semantics or write fixture sidecars when the adapter
lives under `.riptide/adapters/`.

### Rule 11 — Trade-size × volume grid (AMM adapters)

When classification flagged **`price_manipulation_via_swap`**, you
**must** emit a `trade-size-volume-grid` proposal — a 2D grid that
crosses a **trade-size axis** with a **swap-volume axis**. This
grid counts as the composite from Rule 2.

**Why trade-size × volume.** `price_manipulation_via_swap` is about
*how much* the pool price moves per swap (trade-size) and *how
often* the attacker can compound that move (volume). A 1D sweep on
either axis alone misses the interaction: a single large trade on
a thin-volume pool leaves one price footprint; many small trades
on a heavy-volume pool leave another; their product is where real
adversarial price manipulation lives. Matches the whale-
shock and depositor-shock 2D discipline.

**Axis encoding:**

- **Trade-size axis** — the per-swap `amount_in` a trader persona
  sends, encoded via `position_sizing.params.amount` on a
  swapper-shaped persona in `policies.json`. Standard points:
  `t100`, `t1000`, `t10000` (bare integer amounts, no scale
  suffix).
- **Volume axis** — total swap throughput, encoded via `ticks` in
  each cell's `run-config.json`. More ticks = more swaps fired by
  the same population = higher cumulative volume. Standard points:
  `v10`, `v30`, `v60`.

**Grid layout** mirrors the whale-shock and
depositor-shock patterns exactly:

    fixtures/scenarios/<adapter-stem>/trade-size-volume-grid/
      manifest.json # grid-level metadata (not bootable)
      t100-v10/ # one subdir per (trade-size, volume) cell
        run-config.json
        policies.json
        manifest.json
      t100-v30/
        …
      t10000-v60/ # high-trade-size + high-volume corner
        run-config.json
        policies.json
        manifest.json

Cell naming: `t<trade_size>-v<tick_count>` using bare integer values
with no scale suffix. Each cell is a full bootable scenario triple
and must validate on its own via `riptide scenarios --validate <cell-dir>`.

**Cell contents.** Each cell's:

- `run-config.json` sets `"ticks": <v-value>`, `"scenario": "baseline"`
  (AMM has no oracle so `price-shock` does not apply), fixed seed
  42, `agents: 20`, `personas: [...]` list weighted toward the
  swapper persona (e.g. 16 swappers + 4 lp-providers for a 20-agent
  population).
- `policies.json` declares a `swapper` persona with
  `position_sizing.params.amount: <t-value>` and `action_weights:
  { "swap": 1.0 }`. Plus a baseline `lp-provider` persona with the
  standard add-liquidity weighting.
- `manifest.json` sets `failure_mode: "price_manipulation_via_swap"`
  and the one-sentence rationale cites the cell's coordinates — e.g.
  "Cell (trade-size 10000, volume 60 ticks) of the trade-size × volume
  grid — the corner where cumulative price impact from one-directional
  swap pressure is largest and adversarial price manipulation most
  visible."

**Materialize every cell.** Same discipline as the lending
`whale-shock-grid` — if the grid has 9 cells, all 9 must be
bootable sub-scenarios on disk. Midpoint-only grids are not
acceptable. The grid-level `manifest.json` at the slug root carries
axes + cell list + combined rationale and is NOT a bootable
scenario manifest (no `failure_mode` field there).

### Rule 12 — Impermanent-loss sweep (AMM adapters)

When classification flagged **`impermanent_loss_spike`**, emit an
`impermanent-loss-sweep` proposal — a 1D sweep varying the balance
of LP churn (add_liquidity:remove_liquidity weight ratio) in the
LP persona, under fixed heavy-swap traffic.

Axis: `lp_churn_ratio ∈ {0.2, 0.5, 0.8}` — the remove-liquidity
weight on the LP persona (add_liquidity weight is `1 - churn_ratio`).
Higher churn = LPs cycle in/out more, realizing impermanent loss
against the prevailing reserve ratio.

Write only the middle point (0.5) as the representative
`run-config.json` + `policies.json` + `manifest.json` triple. The
rationale notes the full sweep range and explains that churn rate
is the realized-vs-notional knob: 0.0 churn = theoretical-only loss
(no exit), high churn = frequent realization against volatile
reserves. `failure_mode: "impermanent_loss_spike"` in the manifest.

### Rule 13 — JIT liquidity sweep (AMM adapters)

When classification flagged **`jit_liquidity`**, emit a
`jit-liquidity-sweep` proposal — a 1D sweep varying the proportion
of JIT-shaped agents (high-churn, opportunistic LP) against a fixed
baseline of stable LP + swapper populations.

Axis: `jit_ratio ∈ {0.10, 0.25, 0.50}` — the proportion of agents
assigned the JIT / rug-puller-shaped persona. With 20 agents:
0.10 = 2 JIT agents, 0.25 = 5, 0.50 = 10.

Write only the middle point (0.25) as the representative
`run-config.json` + `policies.json` + `manifest.json` triple. The
rationale notes the full sweep range and explains that JIT
extraction scales non-linearly with attacker share: below some
threshold, baseline LPs absorb fees normally; above it, JIT agents
capture a disproportionate slice. `failure_mode: "jit_liquidity"`
in the manifest.

### Rule 14 — Reserve-depletion stress (AMM adapters)

When classification flagged **`reserve_depletion`**, emit a
`reserve-depletion-stress` proposal — a 1D sweep of one-directional
swap size under a fixed swapper population biased to a single
swap direction.

Axis: per-swap `amount_in ∈ {1000, 10000, 100000}` on a swapper
persona whose `persona_args.direction` is fixed (e.g. `0` = a→b)
and whose `action_weights` are `{ "swap": 1.0 }`. Fixed population
of 20 agents with 16 one-directional swappers + 4 LP providers.

Write only the middle point (10000) as the representative
`run-config.json` + `policies.json` + `manifest.json` triple. The
rationale notes the full sweep range and explains that sustained
one-sided pressure is the depletion shape: small amounts leave
reserves mostly intact; large amounts drain the thin side toward
zero where swap math degenerates. `failure_mode: "reserve_depletion"`
in the manifest.

### AMM manifest failure_mode values

For AMM proposals, `failure_mode` in `manifest.json` must be one
of: `price_manipulation_via_swap`, `impermanent_loss_spike`,
`jit_liquidity`, `reserve_depletion`. These are the AMM-specific
category names from `classify.md`.

## Liquid-staking-specific proposal rules

Four rules apply when classification flags one or more of the
liquid-staking-specific categories (`withdrawal_queue_run`,
`depeg_after_slash`, `reserve_buffer_exhaustion`,
`stale_oracle_redemption_gap`). These rules are additive — they do
not replace or modify Rules 1–7, perps Rules 8–10, or AMM Rules
11–14 above. The liquid-staking adapter exposes `stake` /
`request_unstake` / `claim_unstake` as runtime-dispatchable
actions; `apply_slash` is an admin-gated scheduled / replay
instruction, not a persona-fired action.

### Rule 15 — Slash-magnitude sweep (liquid-staking adapters)

When classification flagged **`depeg_after_slash`**, emit a
`slash-magnitude-sweep` proposal — a 1D sweep varying the slash
magnitude scheduled against the pool, under a fixed mixed
population that contains at least one panic-reactive persona.

Axis: slash magnitude in bps `{1000, 2000, 3000}` (10% / 20% /
30%). Slashes are NOT runtime-dispatchable — they are either
scheduled via `[[scheduled_actions]]` in a runtime adapter copy or
dispatched as a raw IDL instruction through a replay trajectory.
For this 1D sweep, emit only the midpoint (2000 bps = 20%) as the
representative `run-config.json` + `policies.json` + `manifest.json`
triple and note the full sweep range in the rationale.

Fixed population (20 agents): a mix that includes at least one
panic-reactive persona (e.g. 5 steady-staker + 5 yield-maxi +
7 panic-exiter + 3 arb-redeemer) so the rate-drop trigger has
a population to fire on. `policies.json` stays `[]` because
the liquid-staking adapter is `protocol = "generic"` and the
engine resolves personas from the adapter TOML's `[personas.*]`.

`failure_mode: "depeg_after_slash"` in the manifest. The rationale
must note: the proposal is a staging run — shipping `riptide run`
does not fire `apply_slash` by itself; the full depeg proof lives
in a replay fixture under `fixtures/replays/`, and this sweep is
the scenario-level companion that exercises the persona-mix side
of the failure.

### Rule 16 — Withdrawal-queue-run sweep (liquid-staking adapters)

When classification flagged **`withdrawal_queue_run`**, emit a
`withdrawal-queue-run-sweep` proposal — a 1D sweep varying the
share of redemption-heavy agents (panic-exiter + arb-redeemer)
under fixed total population, to stress the reserve-vs-queue
ratio organically without a scheduled slash.

Axis: redemption-share `{0.25, 0.50, 0.75}` — the proportion of
agents assigned to redemption-heavy personas. With 20 agents:
0.25 = 5 redemption-heavy, 0.50 = 10, 0.75 = 15. Write only the
midpoint (0.50) as the representative triple and note the full
sweep range in the rationale.

Scenario: `"baseline"` — the queue forms from persona pressure
alone, not from a price-shock oracle move.

`policies.json` stays `[]` because the liquid-staking adapter is
`protocol = "generic"` and the engine resolves personas from the
adapter TOML's `[personas.*]`. `run-config.personas` lists each
agent's persona id drawn from the adapter-declared set.

`failure_mode: "withdrawal_queue_run"` in the manifest. The
rationale must cite the `pool.pending_unstake_count` +
`pool.reserve_buffer` observations as the axes the experiment
measures against.

### Rule 17 — Reserve-exhaustion staging (liquid-staking adapters)

When classification flagged **`reserve_buffer_exhaustion`** AND
the `withdrawal_queue_run` rule already emitted a sweep, do NOT
emit a second 1D sweep on the same axis — the queue-run sweep
already stresses reserve depth as a downstream consequence.
Instead, cite `reserve_buffer_exhaustion` as a secondary failure
mode in the queue-run sweep's rationale and drop this category
from the top-3-to-5 count.

If `reserve_buffer_exhaustion` was flagged in isolation (without
`withdrawal_queue_run`), emit a `reserve-exhaustion-baseline`
proposal at persona-mix 0.50 redemption-share, same as Rule 16.
`failure_mode: "reserve_buffer_exhaustion"` in the manifest.

### Rule 18 — Stale-oracle staging (liquid-staking adapters)

When classification flagged **`stale_oracle_redemption_gap`**,
emit a `stale-oracle-staging` proposal — a baseline run that
holds oracle updates static while redemption pressure builds.
This is a *staging* proposal: today's engine does not expose a
per-tick oracle-lag knob on the generic path, so the rationale
must explicitly say so, mirroring the `oracle_lag` staging
convention on lending adapters.

Midpoint-only: fixed 20-agent population with a balanced
redemption mix, `scenario: "baseline"`, no oracle trajectory
overrides. Rationale cites the future engine knob that would
enable the real variant.

`failure_mode: "stale_oracle_redemption_gap"` in the manifest.

### Liquid-staking manifest failure_mode values

For liquid-staking proposals, `failure_mode` in `manifest.json`
must be one of: `withdrawal_queue_run`, `depeg_after_slash`,
`reserve_buffer_exhaustion`, `stale_oracle_redemption_gap`.
These are the liquid-staking-specific category names from
`classify.md`.

### Liquid-staking policies.json shape

Liquid-staking adapters are `protocol = "generic"`, so the
engine IGNORES the external `policies.json` and resolves the
persona catalog from the adapter TOML's `[personas.*]`.
`policies.json` MUST be `[]` for liquid-staking scenarios — any
non-empty array will surface an "ignoring N external policies"
warning at run time but is not treated as an error.

Action names in persona `action_weights` (on the adapter side)
must match the shipped adapter's `[actions]` keys: `stake`,
`request_unstake`, `claim_unstake`.

## Stablecoin-specific proposal rules

Three rules apply when classification flags one or more of the
stablecoin-specific categories (`collateral_ratio_spiral`,
`redemption_run`, `hedge_gap_depeg`). These rules are additive —
they do not replace or modify Rules 1–7, perps Rules 8–10, AMM
Rules 11–14, or liquid-staking Rules 15–18 above. The stablecoin
adapter exposes `deposit_collateral` / `mint_stable` /
`request_redeem` / `claim_redeem` as runtime-dispatchable actions;
`apply_hedge_loss` is an admin-gated scheduled / replay
instruction, not a persona-fired action. The shared-with-LST
`reserve_buffer_exhaustion` category reuses Rule 17.

### Rule 19 — Hedge-loss-magnitude sweep (stablecoin adapters)

When classification flagged **`hedge_gap_depeg`**, emit a
`hedge-loss-magnitude-sweep` proposal — a 1D sweep varying the
hedge-loss magnitude against the pool, under a deposit-heavy
population that the scheduled haircut has to push into panic.

Axis: hedge-loss magnitude in bps `{1000, 2500, 4000}` (10% /
25% / 40% of delegated collateral). Hedge-losses are NOT
runtime-dispatchable through a persona-fired action. For the
stablecoin `protocol = "generic"` adapter, hedge-losses are ALSO
not currently dispatchable via `[[scheduled_actions]]` — the
generic primitive's `on_scheduled_action` hook is a no-op, so a
scheduled-actions entry emits only a record-keeping event and
does NOT fire `apply_hedge_loss` on-chain. The shipping stablecoin
adapter's sweep therefore runs as a **staging cell**: the
run-config + persona mix are frozen as the pre-haircut population
the companion replay attacks, and the true failure axis
(haircut → backing drop → panic redemptions → queue formation) is
exercised by the named replay fixture under `fixtures/replays/`
via raw IDL dispatch on the replay trajectory.

For this 1D sweep, emit only the midpoint (2500 bps = 25%) as
the representative `run-config.json` + `policies.json` +
`manifest.json` triple and note the full sweep range in the
rationale.

Fixed population (20 agents) — **distinct from the
redemption-run-sweep population on purpose**: deposit-heavy with
only a minority of redemption-reactive agents. Example shape:
7 cautious-minter + 7 leverage-looper + 4 panic-redeemer +
2 arb-redeemer (30% redemption-heavy). Rationale for the split:
`hedge_gap_depeg` pressure comes primarily from the scheduled
haircut, not from organic redemption demand, so the population
models a pool the haircut must push into panic. Using the same
50/50 mix as the redemption-run-sweep would make the two cells
operationally identical at the scenario level, which is the
exact anti-pattern this rule is preventing. `policies.json`
stays `[]` because the stablecoin adapter is `protocol =
"generic"` and the engine resolves personas from the adapter
TOML's `[personas.*]`.

`failure_mode: "hedge_gap_depeg"` in the manifest. The rationale
must explicitly:

1. Cite the distinct deposit-heavy population and why it differs
   from the redemption-run-sweep's 50/50 mix.
2. Flag the staging scope: the generic `on_scheduled_action` hook
   is a no-op, so this cell exercises only the pre-haircut
   persona mix.
3. Point at the companion replay's anchored regression hash as
   the place where the true haircut axis is machine-checked.

### Rule 20 — Redemption-run sweep (stablecoin adapters)

When classification flagged **`redemption_run`**, emit a
`redemption-run-sweep` proposal — a 1D sweep varying the share of
redemption-heavy agents (panic-redeemer + arb-redeemer) under
fixed total population, to stress the reserve-vs-queue ratio
organically without a scheduled hedge-loss.

Axis: redemption-share `{0.25, 0.50, 0.75}` — the proportion of
agents assigned to redemption-heavy personas. With 20 agents:
0.25 = 5 redemption-heavy, 0.50 = 10, 0.75 = 15. Write only the
midpoint (0.50) as the representative triple and note the full
sweep range in the rationale.

Scenario: `"baseline"` — the queue forms from persona pressure
alone, not from an oracle shock or scheduled hedge-loss. A
sufficiently redemption-heavy population exhausts the 20%-reserve-
fraction buffer refill from deposit flow on its own.

`policies.json` stays `[]` because the stablecoin adapter is
`protocol = "generic"` and the engine resolves personas from the
adapter TOML's `[personas.*]`. `run-config.personas` lists each
agent's persona id drawn from the adapter-declared set.

`failure_mode: "redemption_run"` in the manifest. The rationale
must cite the `pool.pending_redemption_count` +
`pool.reserve_buffer_assets` observations as the axes the
experiment measures against.

### Rule 21 — Collateral-ratio-spiral staging (stablecoin adapters)

When classification flagged **`collateral_ratio_spiral`** AND the
`hedge_gap_depeg` rule already emitted a sweep, do NOT emit a
second 1D sweep on the same axis — the hedge-loss-magnitude sweep
already stresses the first leg of the spiral as a downstream
consequence, and the named UXD-style collateral-cascade proof
under `fixtures/replays/` captures the second leg (panic cohort
queueing collateral out of the numerator). Cite
`collateral_ratio_spiral` as a secondary failure mode in the
hedge-loss-magnitude sweep's rationale and drop this category
from the top-3-to-5 count.

If `collateral_ratio_spiral` was flagged in isolation (without
`hedge_gap_depeg` — rare, requires a non-hedge-loss backing-drop
path the current stablecoin does not ship), emit a
`collateral-ratio-spiral-staging` proposal at persona-mix 0.50
redemption-share, same shape as Rule 20.
`failure_mode: "collateral_ratio_spiral"` in the manifest. The
rationale must note that the current stablecoin only exposes
`apply_hedge_loss` as a backing-drop path, so this staging run is
a persona-mix companion for whatever out-of-band mutation drives
the first leg.

### Stablecoin manifest failure_mode values

For stablecoin proposals, `failure_mode` in `manifest.json` must be
one of: `collateral_ratio_spiral`, `redemption_run`,
`hedge_gap_depeg`, `reserve_buffer_exhaustion`. The first three are
stablecoin-specific category names from `classify.md`;
`reserve_buffer_exhaustion` is shared with liquid-staking and reuses
Rule 17's cross-link discipline (if the redemption-run sweep
already covers the drain, cite reserve-buffer-exhaustion as
secondary rather than emitting a duplicate sweep).

### Stablecoin policies.json shape

Stablecoin adapters are `protocol = "generic"`, so the engine
IGNORES the external `policies.json` and resolves the persona
catalog from the adapter TOML's `[personas.*]`. `policies.json`
MUST be `[]` for stablecoin scenarios — any non-empty array will
surface an "ignoring N external policies" warning at run time but
is not treated as an error.

Action names in persona `action_weights` (on the adapter side)
must match the shipped adapter's `[actions]` keys:
`deposit_collateral`, `mint_stable`, `request_redeem`,
`claim_redeem`. `apply_hedge_loss` is not persona-dispatchable and
must not appear in any persona's `action_weights`.

### AMM policies.json action names

For AMM experiments, action names in `action_weights` must match
the amm adapter's `[actions]` keys: `swap`, `add_liquidity`,
`remove_liquidity`. Persona-varying multi-arg fields (`direction`
for `swap`, `amount_b` for `add_liquidity`) live on the persona's
`persona_args` block in the same shape as the persona
library (`fixtures/personas/{lp-provider,arbitrageur,sandwich-attacker,swapper,rug-puller}.toml`).

## Self-check before writing files

- Does every proposal I am about to write cite an adapter-side
  hook from the classification step? If any proposal is generic
  ("stress test the program") — drop it.
- If I ran this same prompt set against a *different* adapter
  (say, an AMM or an NFT marketplace), would the proposals look
  different? If not, I am proposing from the prompt, not from the
  adapter. Iterate the classification.
- Is the whale persona appearing here because classification
  flagged whale concentration from an adapter hook, or because I
  read "whale" elsewhere in working memory and pattern-matched?
  Trace it back. If classification did not flag
  whale_concentration for the adapter in front of me, no whale
  proposal.

## After writing

In user repo mode, validate each written scenario with a one-seed run:

    riptide run <slug> --adapter <adapter> --harness .riptide/harness --seeds 1 --seed-root 1337

Omit `--harness .riptide/harness` only when the adapter is known to
boot without setup. If the scenario's run-config requests a larger
seed count, keep this validation override at `--seeds 1`.

In fixture mode, validate each scenario directory you just wrote with:

    riptide scenarios --validate <scenario-dir>

Exit 0 = ok (one-tick boot clean). Exit 1 = engine failed (fix the
run-config or policies and retry once). Exit 2 = schema mismatch
(read the reported field name, fix that one field, and retry).
Report the table of slug / failure_mode / rationale / exit-code
back to the user. Do not run the full experiment for them.

In fixture mode, for a `whale-shock-grid` proposal, validate **each cell
subdirectory individually** (e.g. `…/whale-shock-grid/w5-s20`,
`…/whale-shock-grid/w25-s40`, …) — not the parent
`whale-shock-grid/` directory, which is not a bootable scenario.
Every cell must come back exit 0; report the per-cell exit codes
alongside the other proposals in the summary table.

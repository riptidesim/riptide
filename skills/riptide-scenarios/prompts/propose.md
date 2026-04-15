# Propose: turn a classification into 3–5 ranked experiments

You have already run `classify.md` and produced a working-memory
table of `flagged` / `not-applicable` for the five failure-mode
categories. Now turn each *flagged* category into one concrete
experiment, rank them, and write the top 3–5 to disk.

## Rules

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
    The on-disk layout mirrors the shipping hero grid at
    `fixtures/scenarios/solend-fork/hero-grid/` — read that
    directory as the authoritative shape reference:

        fixtures/scenarios/<adapter-stem>/whale-shock-grid/
          manifest.json          # grid-level metadata (not a bootable scenario)
          w5-s20/                # one subdir per (whale%, shock%) cell
            run-config.json
            policies.json
            manifest.json        # per-cell scenario manifest
          w5-s30/
            …
          w25-s40/               # Solend June 2022 cell
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
    `output_path`, and share byte-identical `policies.json`. This
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
5. Each proposal writes exactly three files to
   `fixtures/scenarios/<adapter-stem>/<slug>/`: `run-config.json`,
   `policies.json`, and `manifest.json`. Nothing else. *Exception:*
   the `whale-shock-grid` proposal from Rule 2a writes a grid-level
   `manifest.json` at the slug root plus one standard triple per
   cell subdirectory — see Rule 2a for the full layout.
6. Slugs are kebab-case and describe the *experiment*, not the
   outcome. `whale-share-sweep` is a good slug;
   `solend-collapse` is not (that's a prediction, not an
   experiment).
7. Never overwrite anything under
   `fixtures/scenarios/solend-fork/hero-grid/`. Those are sealed.

## File shapes

### run-config.json

Matches `cli/src/compiler/schema.ts::RunConfigSchema`. Required
fields:

```
{
  "agents":         <positive int>,
  "ticks":          <positive int>,
  "scenario":       "<baseline | price-shock | custom>",
  "seed":           42,
  "personas":       ["<persona-id>", …],   // must match policies.json entries
  "validator_url":  "http://localhost:8899",
  "output_path":    "fixtures/scenarios/<adapter-stem>/<slug>"
}
```

`personas` is a list whose length equals `agents`, one entry per
agent, referencing a `persona_id` declared in `policies.json`. This
is how the engine knows how to populate the agent pool with the
mix.

`validator_url` is a stub — the engine runs LiteSVM in-process and
ignores this field, but the Zod schema requires a parseable URL, so
use `http://localhost:8899` verbatim.

### policies.json

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

If you need a whale persona, the hero-grid whale already lives at
`fixtures/personas/whale.toml`. You may either duplicate its shape
inline into `policies.json` (preferred — keeps each experiment
self-contained) or load it in-session. Do not write a new
`fixtures/personas/<name>.toml` file unless the persona is
genuinely new.

### manifest.json

```
{
  "adapter":       "fixtures/adapters/<adapter-stem>.toml",
  "slug":          "<same as directory name>",
  "failure_mode":  "<one of: whale_concentration | shock_cascades | utilization_stress | persona_mix_instability | oracle_lag>",
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

For each scenario directory you just wrote, shell out:

    riptide scenarios --validate <scenario-dir>

Exit 0 = ok (one-tick boot clean). Exit 1 = engine failed (fix the
run-config or policies and retry once). Exit 2 = schema mismatch
(read the reported field name, fix that one field, and retry).
Report the table of slug / failure_mode / rationale / exit-code
back to the user. Do not run the full experiment for them.

For a `whale-shock-grid` proposal, validate **each cell
subdirectory individually** (e.g. `…/whale-shock-grid/w5-s20`,
`…/whale-shock-grid/w25-s40`, …) — not the parent
`whale-shock-grid/` directory, which is not a bootable scenario.
Every cell must come back exit 0; report the per-cell exit codes
alongside the other proposals in the summary table.

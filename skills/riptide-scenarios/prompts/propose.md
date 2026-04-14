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
   `policies.json`, and `manifest.json`. Nothing else.
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

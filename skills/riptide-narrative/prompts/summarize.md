# Summarize: turn a Riptide run into a case-study-voice narrative

You are running inside a Claude Code session invoked via the
`riptide-narrative` skill. Your job right now is to read a
`simulation-result.json` + `report.md` pair that you already have
in working memory and synthesize a case-study-voice narrative
markdown file at `<same-dir>/report-narrative.md`.

The voice you are matching is **`docs/case-studies/solend-fork.md`**.
Re-skim that file before writing if you need a refresher on tone.
Its distinguishing features:

- **Mechanism, not metrics.** Every number the narrative cites is
  paired with a *why* — "bad debt is 3 600 because five whales
  with 720 shortfall each" rather than "bad debt is 3 600".
- **Tick-anchored.** Liquidation *first happens* at tick N; the
  oracle *drops* at tick M; the invariant *fires* at tick K. The
  reader should be able to point at the timeseries and see where
  each claim lives.
- **Modest about the claim.** The narrative says "the run lands
  inside the region where X" not "X proves Y is broken". The
  parameter point the run sampled is the thing the narrative
  speaks for — not the program.
- **Causal, not chronological.** The timeline section is
  chronological; the key-findings section is causal. Different
  jobs.

## Inputs you already have

- `simulation-result.json` — parsed JSON, structure:
  - `run_config.{agents, ticks, scenario, seed, personas[], output_path}`
  - `seed`, `total_ticks`
  - `timeseries[]` — one row per tick, keys vary by primitive but
    always include `tick` plus whatever observations the adapter
    declared (e.g. `tvl`, `utilization`, `oracle_price`,
    `cumulative_bad_debt`, `cumulative_liquidations`,
    `active_agents` for lending; `reserve_a`, `reserve_b`, `k`,
    `cumulative_volume` for AMM; `total_oi_long`,
    `total_oi_short`, `cumulative_socialized_loss` for perps).
  - `events[]` — every agent action (success, skipped, failed) and
    every engine-level event (invariant_violation:<name>). Keys:
    `tick`, `agent_id`, `persona_id`, `persona_label`, `action`,
    `outcome`, `params`.
  - `agents[]` — per-agent final state.
  - `summary` — flat key/value object with domain metrics
    (primitive-agnostic — iterate keys rather than hardcoding).
  - `simulation_boundaries[]` — string list the adapter declared
    (e.g. "No slippage or transaction fees modeled").
- `report.md` — the mechanical report text. You read its `Run
  metadata`, `Summary`, `Invariants`, `Notable events` sections
  as agreed facts you must not contradict.
- Optionally: the adapter TOML the run was executed against (if
  `report.md`'s `Run metadata` cited a resolvable path). Carries
  the declared invariants, the observation → TOML-field mapping,
  and simulation boundary notes.

## Output: `report-narrative.md` section structure

Match the Solend case-study file exactly. Five sections, in this
order:

### 1. Title + one-line frame

A level-1 heading naming the run (use a descriptive slug — e.g.
"Hero Grid Cell w25-s40 — Whale × Shock Corner" or "Perps Scratch
Determinism Replay" — drawn from `output_path` and the dominant
adapter / scenario), followed immediately by a bulleted metadata
block with exactly these five keys (copy the Solend case study's
line shape):

- **Artifact:** the path to `simulation-result.json` (use the
  `output_path` from `run_config` as the dir; append
  `simulation-result.json`).
- **Adapter:** the adapter path from `report.md`'s `Run metadata`.
- **Seed / Agents / Ticks / Scenario:** the four values from
  `run_config`.

### 2. Intro (one paragraph, 3–5 sentences)

Frame the run. Answer:

- What program / protocol shape is being simulated? (Pull from
  the adapter path — `solend-fork` = lending, `perps-fork` =
  perps-lite, `amm-fork` = constant-product AMM, `generic` /
  `resource-grinder` = generic.)
- What question is the run *asking*? (A hero-grid corner is
  asking "at this point in the danger region, how does the
  program's math hold up?". A scratch-determinism run is asking
  "does the engine produce byte-identical output across replays
  on this adapter?". A replay fixture is asking "when we rerun
  the literal historical tx sequence, does the mechanism we
  believe was the root cause fire at the tick we believe it
  did?". Do not use the word "scenario" for this — it's the
  run's *question*, not its engine-preset name.)
- What is the one-sentence load-bearing claim the run lands?
  (For most runs this is a descriptive, not normative, claim —
  "bad debt accrues when X; in this run, X happens at tick N".)

If the run is a single parameter point from a larger sweep (hero
grid cell, composite-grid cell, perps depositor-shock cell), cite
the parent grid + where this cell sits in it in the intro.

### 3. Key findings (2–4 numbered paragraphs)

This is the causal spine of the narrative. Each paragraph makes
*one* causal claim, supports it with evidence from the run, and
names the mechanism. **Not** a restatement of the summary table —
that's what `report.md` does.

Rules for this section:

- Each paragraph opens with the mechanism name in bold ("**The
  liquidation cascade.**", "**The reserve skew.**", "**The
  oracle-jam lag.**").
- Inside each paragraph, cite at least one tick number, one
  event count, and one numeric field from either the timeseries
  or the summary. Wire the evidence to the claim — if you say
  "the liquidator's single-call repay ran out of collateral
  headroom", you owe the reader the tick where the first
  liquidation succeeded, the tick where the first liquidation
  failed, and the quantitative gap that opened.
- Name agents by persona label when plural ("the five whales")
  and by persona label + agent id when singular ("whale
  agent-001"). Match how `docs/case-studies/solend-fork.md`
  phrases participant counts.
- If a summary metric is zero, *say why it's zero* — that's often
  more informative than why a nonzero metric is nonzero.
  (Example: "`final_utilization = 0` not because no one borrowed
  but because all five whales were liquidated on tick 10 and
  their borrows cleared from the pool.")
- If an invariant fired, the paragraph naming it must cite the
  *first* firing tick + the total firing count, and must name the
  observation field + threshold the invariant is checking
  (readable from the adapter TOML when available). If no
  invariant fired, one paragraph should note which invariants
  *were declared* and why the run stayed inside them.

If the run is *uneventful* (no liquidations, no invariant firings,
no cascades — the s20 shock cells, the baseline determinism
runs), the key-findings section says so plainly and names the
specific reason the run stayed quiet. "Why s20 is quiet" from the
Solend case study is the canonical shape.

### 4. Timeline (bulleted, tick-keyed)

Chronological, terse, tick-by-tick for the ticks that *matter*.
Rules:

- Emit at most ~8–12 timeline bullets. This is not a transcript
  of every tick — skip the ticks where nothing notable happened.
- Each bullet starts with `**T<n>**` or `**T<start>–T<end>**` for
  ranges.
- A bullet is notable if any of these is true at that tick:
  (a) the first occurrence of an action type in the run, (b) an
  oracle / price / reserve value crosses a round threshold,
  (c) a liquidation, (d) a failed-action cluster (≥3 of the same
  action fail in the same tick), (e) an invariant firing, (f) a
  persona lifecycle event (agent liquidated, agent depleted, all
  agents of a persona type exit).
- Include the action → outcome shape ("15 `liquidate` attempts
  fail", "5 `liquidate` succeed and 10 `liquidate` skipped"), not
  the raw event objects.
- The first tick and the last tick get bullets regardless — the
  reader should be able to anchor the run's shape at both ends
  without scrolling back.

### 5. Invariant summary (terse)

A short block — one paragraph, or a mini-table — listing:

- Which invariants the adapter declared (read from the adapter
  TOML if available; if not, read invariant names off of
  `events[]` where `agent_id == "__engine__"` and `action`
  starts with `invariant_violation:`).
- For each: whether it fired (yes / no), how many times, and the
  first firing tick.
- One sentence interpreting the pattern. ("Both `reserve_a_positive`
  and `reserve_b_positive` held through the run; the pool did not
  degenerate.")

If the adapter has *no* declared invariants, say so plainly — do
not pad the section. The mechanical report already notes "No
invariant violations detected"; the narrative's job here is to
note what *was declared* versus what fired, which the mechanical
report does not surface explicitly.

### 6. Conclusion (one paragraph, 3–5 sentences)

Land the run. Close the narrative by restating:

1. The load-bearing claim from the intro, now in present-tense
   ("The run lands one claim on disk: …").
2. The mechanism the key-findings section identified, in one
   clause.
3. The modest caveat — Riptide is a lab, not an oracle. The run
   is a parameter point; it is not a verdict on the program. Match
   the Solend case study's "Caveat — lab, not oracle" voice
   without copy-pasting it (no need to duplicate the canonical
   wording — the mechanical report and README already carry that).
4. One sentence pointing the reader at what the next useful
   experiment would be. (A narrower parameter sweep? A different
   persona mix? A longer run to see if the shape persists past
   the final tick?)

## Evidence-citation rules (hard)

1. **Every number in the narrative must be traceable.** Every tick
   number, every event count, every persona count, every summary
   value must either appear in `simulation-result.json` / the
   declared adapter / the mechanical report — or be a computation
   obviously derivable from those (e.g. "5 whales × 720 shortfall
   each = 3 600 total bad debt"). If you write a number you cannot
   cite, drop it.
2. **No mainnet/historical claims unless they are in the run.** If
   the adapter is `solend-fork`, the narrative may say *"the
   Solend June 2022 incident lived at roughly w25-s40 in this
   parameter plane"* — but only if the run being narrated *is*
   the w25-s40 cell. Do not reach for external context the run
   itself does not stand on.
3. **No "this shows the program is safe/broken" claims.** The
   narrative describes the run. The reader draws the verdict.
   "The run lands inside the non-zero bad-debt region" is fine;
   "This proves Solend was unsafe" is not.
4. **Primitive-agnostic — iterate the summary object, don't
   hardcode fields.** The summary's keys depend on the adapter.
   For lending, expect keys like `final_tvl`, `total_bad_debt`,
   `total_liquidations`, `final_utilization`. For AMM, expect
   `final_reserve_a`, `final_reserve_b`, `final_k`,
   `cumulative_volume`. For perps, expect `final_oi_long`,
   `final_oi_short`, `cumulative_socialized_loss`, `total_liquidations`.
   The narrative picks the 2–4 most informative metrics for the
   shape at hand and explains *why* each landed where it did.
5. **Invariant names come from the run, not from the taxonomy
   names.** If the adapter declared an invariant called
   `no_bad_debt` and the run fired `invariant_violation:no_bad_debt`,
   cite it as `no_bad_debt`. Do not rename it to "Bad Debt
   Invariant" or paraphrase it — the exact declared name is the
   handle the reader uses to find it in the adapter TOML.

## Self-check before writing

Before you call `Write`, re-read your draft and answer:

1. **Could this narrative be written for a *different* run — one
   with a different adapter, a different seed, a different
   scenario — and stay coherent?** If yes, the narrative is
   reading the prompt, not the run. Cite more specifics.
2. **Does the key-findings section say *why* the summary numbers
   are what they are, or does it say *what* they are?** If the
   latter, the mechanical report already did that job — rewrite
   the section around causal mechanisms.
3. **If I strip the numbers out, does anything remain?** If the
   whole narrative is just numbers restated, the voice is wrong.
   Mechanism + modest framing is what carries the Solend case
   study; copy that.
4. **Is there any claim a reader could push back on with "how do
   you know?"** If yes, either cite the tick or drop the claim.

If any answer is bad, revise once in place. If the second pass
still fails, stop and tell the user the narrative cannot be
reliably synthesized — better to ship nothing than a
mechanical-report rehash.

## What the narrative MUST NOT contain

- Executive-summary preamble ("In this report we examine…").
  Start with the case-study title + metadata block and go.
- The mechanical report's summary table, verbatim or paraphrased.
  Reference metrics in prose; do not reproduce the table.
- Marketing voice. No "impressive", "comprehensive",
  "demonstrates", "showcases". The Solend case study is written
  flat — match that register.
- Caveats that the mechanical report already carries. The
  `simulation_boundaries` list lives in `report.md` and is
  re-rendered by the dashboard; the narrative does not need to
  repeat it.
- Instructions to rerun the simulation. `report.md` has the
  "How to reproduce" block; the narrative is the story, not the
  runbook.

---
name: riptide-narrative
description: Synthesize a case-study-voice narrative markdown report for a Riptide simulation run using the current agent session. Use when the user says "narrative report", "riptide narrative", "turn this run into prose", "write up this simulation", or is standing in a directory with a `simulation-result.json` + `report.md` pair and wants a richer, causal retelling that cites specific ticks, events, and invariant firings. The skill reads both artifacts, drafts the narrative in-session, and writes `report-narrative.md` alongside the existing `report.md`. Zero setup, no API keys, no endpoint config.
---

# riptide-narrative

This skill turns a Riptide simulation's mechanical artifacts
(`simulation-result.json` + `report.md`) into a case-study-voice
narrative markdown file **using the current Claude Code session's
own model**. There is no second LLM call, no HTTP endpoint, no API
key, no provider config, no shell wrapper. The session you are
already running in is the synthesizer.

The output is a sibling file — `report-narrative.md` — written next
to the existing `report.md`. The mechanical report is left
untouched; the narrative is additive.

## Framing — narrative, not verdict

Riptide is a lab, not an oracle. This narrative retells *what
happened in this specific run against this specific adapter and
this specific seed*, grounded in the events, ticks, and invariant
firings that live in the result JSON. It does **not** claim the
program is safe, broken, or even interesting outside the parameter
point the run sampled. The narrative names mechanism and cites
evidence; the reader draws the conclusion.

Copy the voice of `docs/case-studies/lending.md`. That file is
the canonical tone reference: causal, mechanical, modest about
what the run proves, specific about what it observed. Do **not**
restate the mechanical report's summary table in prose — the point
of the narrative is to explain *why the numbers in the table are
what they are*, tick by tick.

## Inputs

- **Required:** a `simulation-result.json` file (the engine's native
  output — see `engine/src/types.rs::SimulationResult` for the
  authoritative shape). Required top-level keys the skill reads:
  `run_config`, `seed`, `total_ticks`, `timeseries`, `events`,
  `agents`, `summary`, `simulation_boundaries`.
- **Required:** a `report.md` file in the same directory (the
   mechanical report — see
  `cli/src/report/narrative.ts::renderNarrative` for how it is
  rendered). The skill reads it as context, not as a template to
  rewrite; the sections the mechanical report carries (`Run
  metadata`, `Summary`, `Invariants`, `Notable events`,
  `Simulation boundaries`, `How to reproduce`) are the agreed
  facts — the narrative must not contradict them.
- **Optional:** the adapter TOML the run was executed against. If
  the mechanical report's `Run metadata` block cites an adapter
  path, load that TOML to see which invariants were *declared*
  (even the ones that did not fire) and which observations the
  timeseries columns map to. If the file is not resolvable, skip
  this — the narrative must still work from the JSON + mechanical
  report alone.

## Output

Write exactly one file:

    <same-dir>/report-narrative.md

Where `<same-dir>` is the directory that contained the
`simulation-result.json`. If `report-narrative.md` already exists,
overwrite it — this skill is idempotent and reruns should produce
the same narrative shape.

Do **not** modify `simulation-result.json` or `report.md`. Those
are read-only inputs.

Do **not** write to any other path (no STATE.md edits, no session
transcripts, no sibling artifacts). One file in, one file out.

## Flow

When the user invokes this skill, follow these steps yourself —
you are both the reader and the writer.

### 1. Locate the inputs

- If the user passed a directory or a path to a
  `simulation-result.json` as an argument, use it. The target
  directory is the one containing that JSON.
- Otherwise auto-detect: look for `./simulation-result.json`,
  then `./riptide-output/*/simulation-result.json`, then
  `./fixtures/scenarios/**/simulation-result.json` (in that
  order). If zero or multiple candidates, ask the user. Do not
  guess.
- Confirm `report.md` sits alongside the chosen
  `simulation-result.json`. If it does not, stop and tell the user
  to run the simulation with artifact generation enabled (or point
  them at the `--output` flag on `riptide simulate` / `riptide
  run`) — the narrative depends on the mechanical report as a
  co-signed fact set.

### 2. Load both files into working memory

- Parse `simulation-result.json` as JSON.
- Read `report.md` as text.
- If the mechanical report cites an adapter path under `Run
  metadata`, try to load that adapter TOML for invariant + observation
  context. If it fails, continue without it.

### 3. Read the synthesis prompt

Read the prompt file from this skill's own `prompts/` directory:

- `skills/riptide-narrative/prompts/summarize.md`

This is an instruction for *you*, the in-session agent — not a
template to be sent over HTTP. It describes the section structure
the narrative must follow, the voice the narrative must carry, and
the evidence-citation rules the narrative must honor.

### 4. Synthesize the narrative

Apply `summarize.md`. Write the narrative directly in working
memory. Do not draft a plan-of-the-narrative before writing the
narrative — the prompt is the plan.

**Cold-read gate.** Before writing to disk, re-read your own
draft as if you had no prior context for the run. Answer:

1. Does a tick number appear in at least three places in the
   narrative body (outside the timeline section)?
2. Does the narrative name the *mechanism* that drove the summary
   numbers (e.g. "the liquidator's single-call repay was 6 500 but
   the whale's collateral at 40 % shock needed ~112 of 100 to
   exhaust, so per-whale shortfall became 720"), or is it just
   restating the summary numbers in different words?
3. If a non-technical reader read only this narrative, could they
   describe what happened in one sentence? ("Bad debt appeared at
   tick 10 because shock severity passed the liquidator's
   headroom.")

If the answer to any of those is no, revise once in place before
writing. If the second revision still fails the cold-read, stop
and tell the user the narrative cannot be reliably synthesized for
this run — do not ship a mechanical-report rehash under a
different filename.

### 5. Write the file

Write the synthesized narrative to
`<same-dir>/report-narrative.md` using the `Write` tool directly.

### 6. Report back

Tell the user:

- the path to the written `report-narrative.md`
- a one-line summary of the run's dominant mechanism (e.g.
  "liquidation cascade starting tick 4, invariant fired tick 4")
- any invariant firings that the narrative flagged, with their
  tick numbers

Do not summarize the narrative itself back at the user — the
whole point of the skill is that they read the file. Pointing them
at the file is enough.

## Preconditions

- A `simulation-result.json` and a `report.md` sit in the same
  directory. If either is missing, stop and ask the user to
  regenerate the run artifacts.
- You, the in-session agent, have read access to that directory.
- The run JSON schema has not been modified since this skill was
  written. The authoritative schema lives in `engine/src/types.rs`
  (serde) and `cli/src/compiler/schema.ts` (Zod). If the skill
  errors on a missing field, the schema has drifted — fix the
  prompt, not the run output.

## What this skill does NOT do

- Make any HTTP calls. The synthesizer is you, in-session.
- Require any API key or provider config.
- Modify `simulation-result.json` or `report.md`. Both are
  read-only inputs.
- Write anywhere other than `<same-dir>/report-narrative.md`.
  Don't touch STATE.md, session docs, or the dashboard.
- Claim the run *proves* anything beyond the parameter point it
  sampled. The narrative names mechanism and cites tick numbers;
  the reader decides what to take from it. Match the "lab, not
  oracle" framing the Solend case study uses in its caveat.
- Invent data. Every tick number, every event count, every
  invariant firing must be traceable to a concrete field in the
  run JSON. If a claim cannot be cited, drop it.
- Duplicate the mechanical report. The narrative supplements; it
  does not replace. The reader still has `report.md` for the
  summary table.

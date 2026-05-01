---
name: riptide-scenarios
description: Propose a starter catalog of Riptide experiments for a Solana program adapter using the current agent session. Use when the user says "what should I test", "riptide scenarios", "propose experiments", "I don't know what to simulate", or is standing in a repo with `.riptide/adapters/*.toml` or a fixtures adapter and wants Riptide to suggest starter runs. The skill reads the adapter + IDL, classifies plausible failure modes from the program shape, proposes 3–5 ranked experiments, writes user-repo runs under `.riptide/scenarios/**` or monorepo fixtures under `fixtures/scenarios/**`, and smoke-validates with the appropriate CLI path.
---

# riptide-scenarios

This skill proposes a *starter catalog* of Riptide experiments for a
Solana program adapter **using the current Claude Code session's own
model**. There is no second LLM call, no HTTP endpoint, no API key,
no provider config. The session you are already running in is the
classifier and the proposer.

For monorepo fixture output, `riptide scenarios --validate` is a pure
boot-test harness. For user repos scaffolded by `riptide init`, use
the normal runner with a short override such as
`riptide run <slug> --adapter <adapter> --harness .riptide/harness
--seeds 1 --seed-root 1337`. Neither path calls an external service.

## Framing — starter catalog, not bug oracle

Riptide is a lab, not an oracle. This skill proposes experiments by
looking at the *shape* of your program and flagging which classes of
failure mode are plausible. It does **not** tell you what will happen
on mainnet, and it does **not** certify anything as safe. The
proposals are a starting point — the developer owns the run and owns
the conclusion. A proposal that passes validation is a proposal that
*boots*, not a proposal that *holds up*.

Keep this framing intact when surfacing results to the user. Do not
promote the skill's proposals to "findings" or "bugs". They are
experiments worth running.

## What you actually configure for a Riptide scenario

Choose the output mode from the repo shape:

- **User repo mode:** if `.riptide/adapters/*.toml` exists, write
  `.riptide/scenarios/<experiment-slug>/run-config.json`. Do not
  write fixture `manifest.json` or `policies.json`; generic personas
  live inline in the adapter. Include `"adapter":
  "../../adapters/<adapter-stem>.toml"` in each run-config when it
  helps disambiguate.
- **Monorepo fixture mode:** if the user is working under the Riptide
  monorepo `fixtures/` layout, write the existing three-file fixture
  shape under `fixtures/scenarios/<adapter-name>/<experiment-slug>/`.

A scenario today is composed from:

- **Run config + scenario parameters** — `run-config.json`: seed,
  ticks, agent counts, the scenario's named shock or sweep
  dimension, the personas it activates.
- **Personas / policies** — for lending primitive scenarios,
  `policies.json` declares the persona catalog referenced by
  `run-config.personas`. For generic-runtime scenarios,
  `policies.json` is usually `[]`; the engine resolves personas from
  inline `[personas.*]` tables in the adapter TOML.
- **Manifest** — `manifest.json` indexing adapter, slug, failure-mode
  category, rationale.
- **Replay surface (optional, separate path)** — when reproducing
  recorded state, scenarios swap the synthetic shock surface for
  explicit `initial-state.json`, `trajectory.json`, and
  `oracle-trajectory.json` files, with an optional replay-scoped
  adapter override. Replays are not what this skill proposes; this
  skill writes synthetic stress scenarios. If the user wants a
  replay, point them at the existing `fixtures/replays/` examples.

This skill proposes synthetic stress scenarios — not replays.

## Semantic-aware scenario hints

`[semantics]` is real for `lending.v1` adapters. Use it as additional
context when it is present, but still ground every proposal in
adapter-visible actions, observations, and invariants. Other class
strings from the design doc (`perps-margin.v1`, `amm.v1`, `lst.v1`,
`stablecoin.v1`) are reserved until their loaders land; do not invent
semantic concepts the engine does not yet evaluate.

## Inputs

- **Required:** a Riptide adapter TOML (e.g.
  `fixtures/adapters/<program>.toml`) that has already been generated
  by `riptide-adapt` or written by hand, and that passes
  `riptide adapt --adapter <path>`.
- **Required when setup is non-trivial:** a working harness from the
  `riptide-harness` skill. If the adapter needs SPL mints/vaults,
  PDAs, sibling programs, oracle accounts, or other concrete account
  bytes before tick 0, get `riptide run --adapter <path> --harness
  .riptide/harness --seeds 1` passing before proposing larger
  scenarios.
- **Required:** the program IDL the adapter references (either via
  `idl_path` in the adapter for generic programs, or
  auto-detected under `./target/idl/`, `./idls/`,
  `./fixtures/idls/`).
- **Optional:** a source-tree path. Use it to disambiguate
  classification when the IDL alone is ambiguous.

## Outputs

In user repo mode, write one file per proposed experiment:

    .riptide/scenarios/<experiment-slug>/run-config.json

Use the same schema that `riptide init` writes: `agents`, `ticks`,
`scenario`, `personas`, `output_path`, plus either `seed` or `seeds`.
For generic adapters, `personas` must reference inline
`[personas.*]` IDs from the adapter. Do not add `policies.json`.

In monorepo fixture mode, write three files per proposed experiment to

    fixtures/scenarios/<adapter-name>/<experiment-slug>/

- `run-config.json` — engine run-config, matches
  `cli/src/compiler/schema.ts::RunConfigSchema`. For this
  fixture-validator path, include
  `"validator_url": "http://localhost:8899"` because that shared
  schema still requires a non-empty string; init-scaffolded
  `.riptide/scenarios/**/run-config.json` files intentionally omit it.
- `policies.json` — an array of `Policy` objects, one per
  `persona_id` referenced by `run-config.personas`.
- `manifest.json` — metadata the validator needs:
  `{ "adapter": "<relative-path-from-monorepo-root>", "slug": "…",
    "failure_mode": "…", "rationale": "…" }`.

`<adapter-name>` is the adapter TOML's filename stem
(`lending.toml` → `lending`). `<experiment-slug>` is a
kebab-case identifier the skill picks that captures the failure mode
under test (e.g. `whale-share-sweep`, `shock-magnitude-sweep`,
`botter-mix-stress`).

**Do not** autorun any of these. The skill proposes and validates
that proposals boot; the developer runs the full experiment.

**Do not** overwrite directories under
`fixtures/scenarios/lending/hero-grid/`. Those are sealed
case-study artifacts. Write new sibling directories.

## Flow

When the user invokes this skill, follow these steps yourself — you
are both the classifier and the proposer.

### 1. Locate the adapter and IDL

- If the user passed an adapter path as an argument, use it.
- Otherwise auto-detect: check `./.riptide/adapters/*.toml`,
  `./fixtures/adapters/*.toml`, and `./adapter.toml`. If zero or
  multiple candidates remain ambiguous, ask the user.
- Set output mode to user repo mode when the adapter is under
  `.riptide/adapters/`; otherwise use monorepo fixture mode.
- Load the adapter TOML into working memory. Note:
  - `protocol` (`lending` vs `generic`) — this is the primary
    classification hook
  - `instructions` table — the set of write actions the program
    exposes
  - `state_mapping` table — the set of observations the engine can
    watch
  - `actions`, `observations`, `personas` tables (generic only)
- Resolve the IDL: prefer `idl_path` from the adapter, then the
  auto-detection ladder. Read its `instructions` and `accounts`
  arrays into working memory.
- If source tree is available, skim it for anything that
  disambiguates classification (e.g. the pool struct declares a
  single shared reserve → concentration risk is plausible).

### 2. Read the classification prompts

Read both prompt files from this skill's own `prompts/` directory:

- `skills/riptide-scenarios/prompts/classify.md`
- `skills/riptide-scenarios/prompts/propose.md`

These are instructions for *you*, the in-session agent — not
templates to be sent over HTTP.

### 3. Classify

Apply `classify.md`. Read the adapter + IDL *you already have in
working memory*, and — without looking at the propose prompt yet —
mark which of the five failure-mode categories are *plausible* given
the shape of this specific program. The classifier must justify each
flagged category with a concrete hook ("the adapter has X, therefore
Y class of failure is plausible"). A category that cannot be
justified from the adapter surface does not get flagged.

If every category comes up plausible on every program, the
classification is doing no work — iterate the prompt, not the output.

### 4. Propose

Apply `propose.md`. For each *flagged* failure mode, draft one
experiment that would stress it, rank them, and keep the top 3–5.
Each proposal must include:

- a kebab-case slug
- a one-line rationale that ties back to the classification step
  (so the reviewer can see *why* this experiment was picked)
- a concrete `run-config.json` body
- a concrete `policies.json` body consistent with
  `run-config.personas`
- a concrete `manifest.json`

If you find yourself proposing the same experiment regardless of
adapter, stop — re-read `classify.md` and check whether the
classification step actually looked at the adapter.

### 5. Write the files

In user repo mode, write each proposal to
`.riptide/scenarios/<experiment-slug>/run-config.json`. Keep existing
scaffolded `baseline` unless you are intentionally repairing it; new
proposals should be siblings such as `swap-pressure` or
`persona-mix-stress`.

In monorepo fixture mode, write the three files per proposal to
`fixtures/scenarios/<adapter-name>/<experiment-slug>/`. Do not touch
`hero-grid/`.

### 6. Validate each proposal

In user repo mode, validate each written scenario with a short run:

    riptide run <experiment-slug> --adapter <adapter> --seeds 1 --seed-root 1337

Add `--harness .riptide/harness` when the adapter needed harness
setup to pass its smoke. If the user repo scenario itself requests a
larger `seeds` count, keep the validation override at `--seeds 1`.

In monorepo fixture mode, validate every written scenario directory:

    riptide scenarios --validate <scenario-dir>

The CLI will:

- load `<scenario-dir>/run-config.json`, `policies.json`, and
  `manifest.json` (exit 2 on file missing, parse error, or schema
  mismatch)
- resolve the adapter path from the manifest (relative paths
  resolved from the monorepo root)
- resolve the local `riptide-engine` binary (built by
  `cargo build --release -p riptide-engine`)
- boot the engine for *exactly one tick* using the scenario's
  run-config, policies, and adapter (exit 1 on engine failure,
  exit 0 on a clean one-tick boot)

No LLM call. No full run. Pure engine validation.

### 7. Report back

Present the user with a table of:

- slug
- failure-mode category it came from
- one-line rationale
- validation command and exit code

If any proposal failed validation, show the engine stderr tail and
offer to iterate. If all pass, tell the user they can now run any of
them for real via the orchestrator, and remind them of the "lab, not
oracle" framing — proposals that boot are not proposals that hold up.

## Preconditions

- The `riptide` CLI is on PATH. If it isn't, stop and ask the user
  to build it.
- The `riptide-engine` release binary has been built at
  `<repo>/target/release/riptide-engine`. If it isn't, point the
  user at `cargo build --release -p riptide-engine`.
- The adapter TOML the user points you at has already passed
  `riptide lint`. If adapter-only `riptide adapt` cannot boot because
  setup is required, a one-seed `riptide run --harness` smoke is the
  required precondition instead.
- If the adapter depends on project-specific setup, the harness has
  already been smoke-tested with a one-seed `riptide run --harness`.
  If not, use `riptide-harness` first; scenario proposals should not
  paper over setup failures.

## What this skill does NOT do

- Make any HTTP calls. The classifier and proposer are you,
  in-session.
- Require any API key or provider config.
- Autorun full proposed sweeps. Validation is bounded to
  fixture one-tick boot or user-repo `--seeds 1`; the developer owns
  every real run.
- Claim that a proposed experiment reveals a bug. The skill
  proposes *plausible* failure modes based on program shape; the
  experiment outcome is the developer's call.
- Modify sealed artifacts under `fixtures/scenarios/lending/
  hero-grid/`.
- Duplicate the run-config or policy schemas. The authoritative
  schemas live in `engine/src/types.rs` (serde) and
  `cli/src/compiler/schema.ts` (Zod). The prompts document shape;
  the validator enforces it.

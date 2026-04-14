---
name: riptide-scenarios
description: Propose a starter catalog of Riptide experiments for a Solana program adapter using the current agent session. Use when the user says "what should I test", "riptide scenarios", "propose experiments", "I don't know what to simulate", or is standing in a repo with an adapter TOML + IDL and wants Riptide to suggest starter runs. The skill reads the adapter + IDL, classifies plausible failure modes from the program shape, proposes 3–5 ranked experiments, writes each as a run-config + persona file, then smoke-validates every generated config via `riptide scenarios --validate`. Proposes only — does not autorun.
---

# riptide-scenarios

This skill proposes a *starter catalog* of Riptide experiments for a
Solana program adapter **using the current Claude Code session's own
model**. There is no second LLM call, no HTTP endpoint, no API key,
no provider config. The session you are already running in is the
classifier and the proposer.

The CLI command `riptide scenarios --validate` is a pure boot-test
harness. It loads one generated scenario directory, runs the engine
for a single tick against the adapter declared in the manifest, and
exits 0/1/2 — the same convention as `riptide adapt`. It does not
call any external service and it does not run the full experiment.

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

## Inputs

- **Required:** a Riptide adapter TOML (e.g.
  `fixtures/adapters/<program>.toml`) that has already been generated
  by `riptide-adapt` or written by hand, and that passes
  `riptide adapt --adapter <path>`.
- **Required:** the program IDL the adapter references (either via
  `idl_path` in the adapter for generic programs, or
  auto-detected under `./target/idl/`, `./idls/`,
  `./fixtures/idls/`).
- **Optional:** a source-tree path. Use it to disambiguate
  classification when the IDL alone is ambiguous.

## Outputs

For each proposed experiment, write three files to

    fixtures/scenarios/<adapter-name>/<experiment-slug>/

- `run-config.json` — engine run-config, matches
  `cli/src/compiler/schema.ts::RunConfigSchema`. Use
  `"validator_url": "http://localhost:8899"` (the engine runs
  LiteSVM in-process — this field is a stub).
- `policies.json` — an array of `Policy` objects, one per
  `persona_id` referenced by `run-config.personas`.
- `manifest.json` — metadata the validator needs:
  `{ "adapter": "<relative-path-from-monorepo-root>", "slug": "…",
    "failure_mode": "…", "rationale": "…" }`.

`<adapter-name>` is the adapter TOML's filename stem
(`solend-fork.toml` → `solend-fork`). `<experiment-slug>` is a
kebab-case identifier the skill picks that captures the failure mode
under test (e.g. `whale-share-sweep`, `shock-magnitude-sweep`,
`botter-mix-stress`).

**Do not** autorun any of these. The skill proposes and validates
that proposals boot; the developer runs the full experiment.

**Do not** overwrite directories under
`fixtures/scenarios/solend-fork/hero-grid/`. Those are sealed Phase 0
/ Phase 1 artifacts. Write new sibling directories.

## Flow

When the user invokes this skill, follow these steps yourself — you
are both the classifier and the proposer.

### 1. Locate the adapter and IDL

- If the user passed an adapter path as an argument, use it.
- Otherwise auto-detect: check `./fixtures/adapters/*.toml` and
  `./adapter.toml`. If zero or multiple candidates, ask the user.
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

Write the three files per proposal to
`fixtures/scenarios/<adapter-name>/<experiment-slug>/`. Use the
`Write` tool directly. Do not touch `hero-grid/`.

### 6. Validate each proposal

For every written scenario directory, shell out:

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
- validate exit code

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
- The adapter TOML the user points you at has already been
  smoke-tested via `riptide adapt`. If it hasn't, do that first —
  this skill does not re-validate adapters.

## What this skill does NOT do

- Make any HTTP calls. The classifier and proposer are you,
  in-session.
- Require any API key or provider config.
- Autorun the proposed experiments. Validation is one-tick-boot
  only; the developer owns every real run.
- Claim that a proposed experiment reveals a bug. The skill
  proposes *plausible* failure modes based on program shape; the
  experiment outcome is the developer's call.
- Modify sealed artifacts under `fixtures/scenarios/solend-fork/
  hero-grid/`.
- Duplicate the run-config or policy schemas. The authoritative
  schemas live in `engine/src/types.rs` (serde) and
  `cli/src/compiler/schema.ts` (Zod). The prompts document shape;
  the validator enforces it.

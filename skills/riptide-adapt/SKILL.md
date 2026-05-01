---
name: riptide-adapt
description: Generate or repair a Riptide adapter TOML for a Solana program IDL using the current agent session. Use when the user says "generate an adapter", "riptide adapt", "wire a program into Riptide", "adapter for this IDL", or is standing in a repo with an IDL JSON they want to simulate with Riptide. The skill reads the IDL (and any existing `.riptide/adapters/*.toml` stub the wizard scaffolded), generates or fills in the adapter TOML using this session's model, writes it, and runs a smoke test against the local engine. Zero setup, no API keys, no endpoint config.
---

# riptide-adapt

This skill generates or fills in a Riptide adapter TOML from a Solana
program IDL **using the current Claude Code session's own model**.
There is no second LLM call, no HTTP endpoint, no API key, no provider
config. The session you are already running in is the generator.

The CLI command `riptide adapt` is a pure smoke-test harness. It takes
a TOML adapter you just wrote, loads it, validates it against the Zod
schema, and invokes the local `riptide-engine` binary to confirm a
single write-action mutates observable state. It does not call any
external service.

## Where this skill fits in the flow

The recommended onboarding is `riptide init` first, then this skill,
then `riptide harness generate` when setup code is needed, then
`riptide-scenarios`:

1. `riptide init` scaffolds `.riptide/` in the program repo: an
   adapter stub at `.riptide/adapters/<program-name>.toml` (with TODO
   markers naming every block), inline `[personas.*]` blocks in the
   adapter, a baseline run-config under `.riptide/scenarios/baseline/`,
   and a `.riptide/GETTING-STARTED.md`.
   It now also scaffolds a starter invariant set and, for lending,
   a `[semantics]` block, so this skill's job is filling in TODO
   bindings rather than authoring invariants from scratch.
   For lending the wizard already inlines `[personas.*]` from the
   user's selection.
2. **This skill** fills in the TODO blocks of the scaffolded adapter
   (or generates one from scratch when no `.riptide/` workspace
   exists) and runs `riptide adapt` to smoke it.
3. `riptide harness generate --adapter <adapter>` creates the Rust
   setup crate for account bytes, PDAs, SPL accounts, state packs, and
   sibling CPI programs the adapter needs before tick 0. Prefer harness
   code over adding protocol-specific setup to Riptide core.
4. `riptide-scenarios` adds further fixture-style scenario
   directories on top. Generic-runtime personas stay inline in the
   adapter's `[personas.*]` tables; lending fixture scenarios may
   carry a local `policies.json`.

**On a `.riptide/`-scaffolded repo, prefer to *edit* the existing
`.riptide/adapters/<program-name>.toml` rather than overwrite it.**
The wizard's `[personas.*]` selection is the user's intent — keep it
and refine the other blocks. Only write a fresh adapter when no
`.riptide/adapters/*.toml` exists yet.

## What the adapter actually carries today

Authoritative schemas live in `engine/src/adapter/schema.rs` (serde)
and `cli/src/schemas/adapter.ts` (Zod). The shipping adapter shape is:

- `protocol` — `"lending"` or `"generic"` hint. When `program_so` +
  `idl_path` are both present, the **runtime is always generic** (the
  SBF/IDL path); `protocol = "lending"` is just a classification hint
  consumed by tooling.
- `program_so`, `idl_path` — paths relative to the adapter file.
  Required for adapters that dispatch a user program through the
  generic SBF/IDL runtime. Omitted only for adapters intentionally
  targeting a bundled primitive, such as the fresh `riptide init
  --protocol lending` stub and the canonical lending fixture.
- `[accounts.<name>]` — one block per account the bootstrap needs to
  create. `kind = "agent" | "shared"`, `space = <bytes>`, plus
  optional `address` (well-known alias or base58 literal), `pda`
  (`{ seeds = [...] }` with the `literal:` / `account:` /
  `signer:agent` / `signer:admin` / `program:` / `pubkey:` prefix
  DSL), and `owner` (`{ program_so = "..." }` or
  `{ pubkey = "<base58>" }`, mutually exclusive, shared-only).
- `[instructions]` — `<ix> = { action = "...", amount = "<arg>",
  args = { <other_arg> = <literal>, ... } }`. The runtime `amount` is
  optional. `args` is for literal-bound non-runtime args of multi-arg
  Borsh instructions; `@persona.<key>` references resolve against
  `persona_args` at dispatch.
- `[state_mapping]` — `"<account>.<field>" = "<observation>"`.
- `[actions.<name>]` — `label`, `takes = [<ordered_arg_names>]`. The
  `takes` list now supports any number of args; each name must bind
  via `amount` or `args`/`persona_args` somewhere.
- `[observations]` — `"<name>" = "uint" | "int" | "bool" | "pubkey" | "map"`.
- `[personas.<name>]` — `label`, `action_rate_multiplier`,
  `action_weights = { ... }`, `triggers = [{ if, then, weight_boost }]`,
  optional `persona_args = { <key> = <literal>, ... }`.
- `[[invariants]]` — flat list of `{ name?, field, op, value }` where
  `op ∈ { "==", "!=", ">=", "<=", ">", "<" }` and `field` is an
  observation name (or one of the engine-emitted snapshot metrics for
  lending: `utilization`, `oracle_price`, `cumulative_bad_debt`,
  `cumulative_liquidations`, `active_agents`, `tick`).
- `[[oracles]]` — `{ name, kind = "admin-mock", account?, base_price?,
  exponent?, confidence? }`. Optional. Loader currently caps to a
  single entry per adapter; declaring more is rejected. Protocol-specific
  oracle layouts belong in a project harness/helper, not generated
  adapter TOML.
- `[[scheduled_actions]]` — engine-fired between persona ticks at
  `interval_ticks` cadence. Optional. Generic-runtime scheduled
  actions dispatch the underlying IDL instruction, so lending adapters
  can schedule zero-arg refresh paths such as `refresh_reserve`
  after oracle writes and before persona actions.
- `[semantics]` — **now real and shipping.** Declarative economic
  semantics block. Currently the only supported class is
  `lending.v1`, which requires roles `position`, `reserve`, `oracle`,
  `liquidation_config`. Emit a `[semantics]` block when the program
  is a collateralized lending protocol; skip for everything else
  until the matching class lands. See "When to emit `[semantics]`"
  below.
- `[lineage]` — reviewer metadata. `idl_source`, `generator`
  (default `hand-authored` or `riptide-adapt@<git-sha>` when known),
  `inferred_assumptions`, `unsupported_fields`. Always emit a
  `[lineage]` block — it is what `riptide lint` and `riptide lineage`
  read.

## Other authoring surfaces this skill does NOT touch

- **Personas / policies** — inline `[personas.*]` blocks in
  `.riptide/adapters/<program>.toml` are populated by `riptide init`;
  for generic adapters the skill emits at least one `[personas.*]`
  block inline. Heavier persona work is the `riptide-scenarios` skill.
- **Run config + scenario parameters** — `.riptide/scenarios/**/run-config.json`
  for synthetic stress, with seed, ticks, agent counts, shock paths.
- **Rust harness setup** — `.riptide/harness/src/main.rs` generated by
  `riptide harness generate`. Use it for protocol-specific account
  bytes and external programs; do not encode those layouts into
  adapter TOML unless they are generic account declarations.
- **Replay artifacts** — `initial-state.json`, `trajectory.json`,
  `oracle-trajectory.json`, plus an optional replay-scoped adapter
  override when a recorded program shape diverges from current.

Tell the user that personas + run config + further scenarios are
separate authoring steps (the `riptide-scenarios` skill or
hand-authoring) before a realistic stress run.

## When to emit `[semantics]`

- The program classifies as `lending` (per `prompts/classify.md`):
  emit `[semantics]` with `class = "lending.v1"` and the four required
  roles (`position`, `reserve`, `oracle`, `liquidation_config`).
  Mark every uncertain field source with a trailing `# TODO:` comment
  the same way you do everywhere else.
- The program classifies as `generic`: do **not** emit a
  `[semantics]` block. Other class strings (`perps-margin.v1`,
  `amm.v1`, `lst.v1`, `stablecoin.v1`) are reserved by the design
  doc but not accepted by the loader yet (see
  `SUPPORTED_SEMANTIC_CLASSES` in `engine/src/adapter/schema.rs`).

## External oracle detection rules

When the source tree or IDL shows a protocol-specific oracle
integration, do not invent a built-in oracle kind. Emit `admin-mock`
only if the program can read that simple account layout. Otherwise,
record the dependency in `[lineage].unsupported_fields` and call out
that the project needs harness setup code, a real loaded oracle program,
or a custom mock.

For the lending case-study repo shape, inspect both
`tests/constants.ts` and `app/src/lib/constants.ts`: the former carries
well-known `*_PRICE_UPDATE_V2` account addresses, while the latter
carries fixed `*_FEED_ID` values such as USDC/USD. Bind those together
instead of inventing a feed id.

## Flow

When the user invokes this skill, follow these steps yourself — you
are both the classifier and the generator.

### 1. Locate the program IDL

- If the user passed a path as an argument, use it.
- Otherwise auto-detect, in order: `./target/idl/*.json`,
  `./.riptide/adapters/*.toml` (read the `idl_path` and resolve it),
  `./idls/*.json`, `./fixtures/idls/*.json`.
- If zero or multiple candidates remain ambiguous, ask the user
  which IDL to use. Do not guess.

### 2. Detect existing scaffold

Check whether `.riptide/adapters/<program-name>.toml` already exists.
If it does, **read it**, treat it as the seed, and plan to fill in
its TODO blocks rather than overwrite it. The wizard's choices for
`protocol`, `[personas.*]`, persona action_weights, and any existing
`program_so` / `idl_path` values are the user's intent and should be
preserved unless they're literally the placeholder "TODO" form. If a
lending stub intentionally omits `program_so` / `idl_path`, do not add
them unless the user is wiring their own compiled program rather than
the bundled lending primitive.

### 3. Read the generation prompts

Read all three prompt files from this skill's own `prompts/`
directory:

- `skills/riptide-adapt/prompts/classify.md`
- `skills/riptide-adapt/prompts/generate-lending.md`
- `skills/riptide-adapt/prompts/generate-generic.md`

These are instructions for you, the in-session agent — not templates
to be sent over HTTP. They define the schema shape you must emit.

### 4. Classify

Apply `classify.md`: read the user's IDL and decide `lending` or
`generic`. Record your decision and the one-sentence reason in
working memory.

### 5. Generate or fill in

Apply the matching generation prompt:

- `generate-lending.md` if you classified as `lending`
- `generate-generic.md` if you classified as `generic`

The output MUST include all required keys for the chosen class
(see the prompts) and carry a trailing `# TODO: <what to verify>`
comment on every uncertain field. When filling in an existing
scaffold, only modify blocks you are actually adding to or
correcting; preserve the wizard-authored ones.

### 6. Write the TOML

Default path priority:

1. `.riptide/adapters/<program-name>.toml` if `.riptide/` exists.
2. `./fixtures/adapters/<program-name>.toml` if the user is clearly
   working under a fixtures directory.
3. `./adapter.toml` only if neither of the above applies.

If still ambiguous, ask.

### 7. Invoke `riptide adapt`

Shell out:

    riptide adapt --adapter <written-path>

The CLI will:

- load and parse the TOML (exit 2 on file missing / parse error)
- validate it against the Zod schema that matches the engine's serde
  schema (exit 2 on validation error, with the offending field)
- resolve the local `riptide-engine` binary (built by
  `cargo build --release -p riptide-engine`)
- run a minimal smoke simulation with one write-action from the
  adapter and assert at least one observation delta shows up in the
  engine output (exit 1 on no delta / engine failure, exit 0 on pass)

### 8. Report back

- **exit 0** → smoke test PASS. Show the user the adapter path, call
  out any `# TODO:` markers still inside the file, and tell them
  they can now `riptide lint <name>` and `riptide run` against it.
- **exit 1** → smoke test FAIL. Show the engine stderr tail that
  `riptide adapt` prints and offer to iterate on the `# TODO:`
  markers or regenerate.
- **exit 2** → the TOML you just wrote failed to parse or failed the
  Zod validator. Read the specific error, fix the one field it
  complained about, rewrite the file, and re-invoke. Do NOT loop
  blindly.

## Preconditions

- Recommended: `riptide init` has already been run in the repo so
  there is a `.riptide/` workspace to fill in. If not, this skill can
  still produce a fresh adapter at `./adapter.toml` or the chosen
  fixtures path.
- The `riptide` CLI is on PATH (e.g. via `node <repo>/cli/dist/src/index.js`
  with a shim, or an install step the user did). If it isn't, stop
  and ask the user to build it.
- The `riptide-engine` release binary has been built at
  `<repo>/target/release/riptide-engine`. If it isn't, point the
  user at `cargo build --release -p riptide-engine`.

## What this skill does NOT do

- Make any HTTP calls. The generator is you, in-session.
- Require any API key or provider config.
- Duplicate the adapter schema. The only authoritative schemas live
  in `engine/src/adapter/schema.rs` (serde) and
  `cli/src/schemas/adapter.ts` (Zod). The prompts document the shape;
  the CLI enforces it.
- Retry generation automatically. If the first attempt fails
  validation, read the specific error and make a single targeted
  fix. If it keeps failing, stop and ask the user.

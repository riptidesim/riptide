---
name: riptide-adapt
description: Generate a Riptide adapter TOML for a Solana program IDL using the current agent session. Use when the user says "generate an adapter", "riptide adapt", "wire a program into Riptide", "adapter for this IDL", or is standing in a repo with an IDL JSON they want to simulate with Riptide. The skill reads the IDL, generates the adapter TOML using this session's model, writes it, and runs a smoke test against the local engine. Zero setup, no API keys, no endpoint config.
---

# riptide-adapt

This skill generates a Riptide adapter TOML from a Solana program IDL
**using the current Claude Code session's own model**. There is no
second LLM call, no HTTP endpoint, no API key, no provider config.
The session you are already running in is the generator.

The CLI command `riptide adapt` is a pure smoke-test harness. It
takes a TOML adapter you just wrote, loads it, validates it against
the Zod schema, and invokes the local `riptide-engine` binary to
confirm a single write-action mutates observable state. It does not
call any external service.

## Flow

When the user invokes this skill, follow these steps yourself — you
are both the classifier and the generator.

### 1. Locate the program IDL

- If the user passed a path as an argument, use it.
- Otherwise auto-detect: check `./target/idl/*.json`,
  `./idls/*.json`, `./fixtures/idls/*.json` in that order.
- If zero or multiple candidates, ask the user which IDL to use. Do
  not guess.

### 2. Read the generation prompts

Read all three prompt files from this skill's own `prompts/`
directory:

- `skills/riptide-adapt/prompts/classify.md`
- `skills/riptide-adapt/prompts/generate-lending.md`
- `skills/riptide-adapt/prompts/generate-generic.md`

These are instructions for you, the in-session agent — not templates
to be sent over HTTP. They define the schema shape you must emit.

### 3. Classify

Apply `classify.md`: read the user's IDL and decide `lending` or
`generic`. Record your decision and the one-sentence reason in
working memory.

### 4. Generate

Apply the matching generation prompt:

- `generate-lending.md` if you classified as `lending`
- `generate-generic.md` if you classified as `generic`

The output MUST include all required top-level keys (`protocol`, plus
`program_so` / `idl_path` / `[accounts]` for generic), the
`[instructions]` / `[state_mapping]` blocks, and the empty-or-
populated `[actions]` / `[observations]` / `[personas]` tables as
the prompt describes. Every uncertain field carries a trailing
`# TODO: <what to verify>` comment.

### 5. Write the TOML

Default path: `./adapter.toml`. If the user is clearly working under
a fixtures directory, `./fixtures/adapters/<program-name>.toml`
instead. If it's ambiguous, ask.

### 6. Invoke `riptide adapt`

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

### 7. Report back

- **exit 0** → smoke test PASS. Show the user the adapter path,
  call out any `# TODO:` markers still inside the file, and tell
  them they can now run a full simulation with that adapter.
- **exit 1** → smoke test FAIL. Show the engine stderr tail that
  `riptide adapt` prints and offer to iterate on the `# TODO:`
  markers or regenerate.
- **exit 2** → the TOML you just wrote failed to parse or failed the
  Zod validator. Read the specific error, fix the one field it
  complained about, rewrite the file, and re-invoke. Do NOT loop
  blindly.

## Preconditions

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

---
name: riptide-adapt
description: Generate a Riptide adapter TOML from a Solana program IDL using the `riptide adapt` CLI. Use when the user says "generate an adapter", "riptide adapt", "wire a program into Riptide", "adapter for this IDL", or is standing in a repo with an IDL JSON they want to simulate with Riptide. Shells out to the installed `riptide` CLI — same generator code path, no duplication.
---

# riptide-adapt

Thin wrapper that invokes the `riptide adapt` subcommand with the right
flags for the current Claude Code session. **Does not duplicate any
generator logic** — if the behavior needs to change, change
`cli/src/commands/adapt.ts` in the riptide-monorepo, not this file.

## When to invoke

- User is in a repo with a Solana program IDL (`*.json` under
  `idls/`, `fixtures/idls/`, or `target/idl/`) and wants to simulate
  the program with Riptide.
- User asks to "generate an adapter", "wire this into Riptide", or
  similar.
- User explicitly says `/riptide-adapt` or names this skill.

## Preconditions

Check before running:

1. `riptide` CLI is on PATH, OR the monorepo lives at a known location
   and can be invoked as `node <repo>/cli/dist/src/index.js`.
2. `OPENAI_API_KEY` (or the user's preferred provider equivalent) is
   exported. If not, stop and ask the user which env var to use.
3. An IDL path is known. If unknown, ask; do not guess.

## Invocation

```bash
# 1. Locate the IDL
IDL_PATH="${1:-$(find . -type f -name '*.json' -path '*/idl*' | head -1)}"

# 2. Pick an output path next to the IDL
OUT_PATH="${IDL_PATH%.json}.adapter.toml"

# 3. Shell out. Same args the manual CLI takes.
riptide adapt \
  --idl "$IDL_PATH" \
  --out "$OUT_PATH" \
  ${RIPTIDE_LLM_ENDPOINT:+--endpoint "$RIPTIDE_LLM_ENDPOINT"} \
  ${RIPTIDE_LLM_MODEL:+--model "$RIPTIDE_LLM_MODEL"}
```

## What to report back to the user

- Exit 0 → adapter written to `$OUT_PATH`, smoke test passed; point
  them at the file and the `# TODO:` markers inside.
- Exit 1 → adapter written but smoke test failed; surface the engine
  stderr tail and tell them to edit the `# TODO:` markers.
- Exit 2 → config problem (missing key / endpoint / IDL); relay the
  CLI's usage hint verbatim.

## Keep this file short

The skill is a distribution channel, not a second code path. If this
file starts growing prompt logic, IDL parsing, or config assembly,
move that logic back into `cli/src/commands/adapt.ts`.

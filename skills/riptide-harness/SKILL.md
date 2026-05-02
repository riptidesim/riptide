---
name: riptide-harness
description: Generate or repair a Riptide Rust harness for pre-tick-0 setup of a Solana program adapter using the current agent session. Use when the user says "create a harness", "riptide harness", "setup SPL mints/vaults", "PDA setup", "load a sibling program", "external accounts", "make this adapter run with --harness", or has a `.riptide/adapters/*.toml` adapter that needs concrete account bytes before simulation. The skill reads the adapter, IDL, and source/tests, edits `.riptide/harness/src/main.rs`, and validates with a short `riptide run --harness` smoke. Zero setup, no API keys, no endpoint config.
---

# riptide-harness

This skill creates or repairs the Rust setup crate that Riptide runs
before tick 0. The harness is where project-specific account bytes,
SPL mints/vaults, PDAs, sibling programs, oracle mocks, and other
local setup belong. Do not move that logic into Riptide core.

The session you are already running in is the generator. There is no
second LLM call, no HTTP endpoint, and no provider config.

## Where this skill fits

Recommended flow:

1. `riptide init` scaffolds `.riptide/`.
2. `riptide-adapt` fills `.riptide/adapters/<program>.toml`.
3. **This skill** creates or repairs `.riptide/harness/`.
4. `riptide-scenarios` proposes broader experiments after a harnessed
   smoke run can boot.
5. `riptide run --adapter <adapter> --harness .riptide/harness --seeds 1 --seed-root 1337` performs the first harnessed smoke; drop the seed override for the full scenario battery.

Use this skill when adapter validation succeeds but the program cannot
boot with zeroed accounts, or when external state must be observed
through generic decoders such as `spl_token_account`.

## Inputs

- A Riptide adapter TOML, usually `.riptide/adapters/<program>.toml`.
- The IDL referenced by `idl_path`, when the adapter uses the generic
  SBF/IDL runtime.
- Optional source/tests for setup facts: account sizes, PDA seeds,
  mint decimals, initial liquidity, oracle layouts, and sibling
  program paths.
- Optional existing `.riptide/harness/src/main.rs`. If present, edit
  it in place; preserve user code.

## Output

Write or update:

    .riptide/harness/Cargo.toml
    .riptide/harness/src/main.rs
    .riptide/harness/README.md

If the crate does not exist, create it by running:

    riptide harness generate --adapter <adapter>

Then edit the generated Rust. Do not hand-write the crate scaffold
from scratch unless the command is unavailable.

## Flow

### 1. Locate and load the adapter

- If the user passed an adapter path, use it.
- Otherwise auto-detect `.riptide/adapters/*.toml`. If multiple
  exist, ask the user which one to use.
- Read the adapter TOML and note:
  - `[accounts.*]`: kind, space, address, PDA, owner, decoder
  - `[state_mapping]` and `[observations]`: which bytes must move
  - `program_so`, `idl_path`, and any sibling `owner.program_so`
  - inline `[personas.*]` actions that will drive the run

If the adapter has unresolved TODOs in required accounts or
instructions, tell the user the adapter must be finished first or use
`riptide-adapt`.

### 2. Inspect source/tests for setup facts

Read only the files needed to answer concrete setup questions:

- Anchor account structs and constants for account sizes and PDA seeds.
- Integration tests for canonical setup order and initial balances.
- Token/mint constants for decimals and initial liquidity.
- Oracle or sibling-program setup code.

Record uncertainties as TODO comments in the harness rather than
guessing silently.

### 3. Plan account setup

For each adapter account, classify the setup:

- **Declared bootstrap is enough**: leave the generated
  `ctx.require_declared_account("<name>")?` check.
- **Raw bytes needed**: use `ctx.set_shared_account_data` or
  `ctx.set_agent_account_data`.
- **SPL mint/account needed**: use `ctx.spl_mint`,
  `ctx.spl_token_account`, or `ctx.agent_spl_token_account`.
- **PDA or fixed pubkey needed**: derive/bind it with
  `ctx.derive_pda`, `ctx.bind_shared_account`, or
  `ctx.bind_agent_accounts`.
- **Sibling program needed**: load it with `ctx.load_program_from_so`.

For examples and helper signatures, read
`references/harness-patterns.md` from this skill.

### 4. Generate or repair the harness crate

- If `.riptide/harness/Cargo.toml` does not exist, run
  `riptide harness generate --adapter <adapter>`.
- If it exists, edit in place. Do not overwrite user-authored setup.
- Keep the harness deterministic. Use fixed amounts, fixed decimals,
  fixed seed roots in validation commands, and no network calls.
- Prefer helper APIs from `riptide_engine::harness` over manual byte
  layouts when a helper exists.

### 5. Keep the adapter/harness boundary clean

- Adapter TOML declares account shape, instruction/action mappings,
  state mappings, observations, personas, invariants, and decoders.
- Harness Rust creates concrete pre-tick-0 account bytes and loads
  any sibling programs.
- Do not add protocol-native decoders to Riptide core. For external
  observations, use adapter decoders (`decoder = "spl_token_account"`
  or raw `[accounts.<name>.decoder]` layouts) and set the bytes in the
  harness.
- Do not require external-owner metadata just to decode bytes; the
  decoder layer observes account data.

### 6. Validate

Run short, bounded checks first:

    riptide lint <adapter-name-or-path>
    cargo build --release --quiet --manifest-path .riptide/harness/Cargo.toml
    riptide run --adapter <adapter> --harness .riptide/harness --seeds 1 --seed-root 1337

After the one-seed smoke, inspect the produced
`.riptide/runs/<scenario>/simulation-result.json` or sweep cell
result and confirm the harness achieved its purpose:

- mapped write actions that should succeed have `outcome = "success"`
- decoded observations named in `state_mapping` are nonzero or move
  when the scenario expects movement
- coverage is not blocked by `state_movement`

If the smoke passes and the user asked for user-like confidence, run
the scaffolded seed count or a larger explicit sweep. For expensive
programs, report the estimated event count before launching:

    agents * ticks * seeds

Do not jump straight to 1000 agents x 30 ticks x 50 seeds unless the
user asked for that scale.

### 7. Report back

Tell the user:

- which harness files changed
- which account setup facts were encoded
- which TODOs remain
- exact validation commands and results
- whether any observed state actually moved across ticks

## Hard rules

- Do not edit engine core to make one protocol boot.
- Do not erase user-authored harness code.
- Do not fake account bytes that contradict source/tests; mark TODOs.
- Do not leave validation at "it compiles" when a one-seed
  `riptide run --harness` is feasible.
- Do not run long sweeps without telling the user the expected scale.

# Generate: generic adapter TOML

You are running inside a Claude Code session invoked via the
`riptide-adapt` skill. You have already classified the target program
as `generic` (per `classify.md`). Now emit a single TOML document
describing how Riptide should drive this program through the generic
SBF/IDL runtime, then write it to disk and hand it off to
`riptide adapt` for smoke testing.

The TOML MUST match the shipped serde schema in
`engine/src/adapter/schema.rs` and the Zod schema in
`cli/src/schemas/adapter.ts`. Any deviation is a hard failure in the
downstream validator — `riptide adapt` will exit 2 on a bad shape.

## Existing scaffold takes precedence

If `.riptide/adapters/<program-name>.toml` already exists, **read it,
preserve the wizard's choices, and fill in TODO blocks** rather than
overwriting. Specifically preserve:

- `protocol = "generic"` (or the wizard's chosen value),
- `program_so` / `idl_path`,
- any populated `[personas.*]` blocks (the wizard inlines selected
  personas — those are the user's intent),
- any populated `[lineage]` block.

Only modify blocks where you have a concrete improvement to apply.

## Required top-level keys for a generic adapter

    protocol = "generic"
    program_so = "<path to compiled .so>" # relative to the adapter file
    idl_path = "<path to IDL json>" # relative to the adapter file

    [accounts.<name>]
    # One block per account type the simulator needs at bootstrap.
    kind = "agent" | "shared"
    space = "auto" # prefer when idl_path exposes IDL.accounts[name].size; use <positive integer> for dynamic/non-Anchor accounts

    # Optional, on top of kind/space:
    #   address = "system_program" | "spl_token"
    #           | "associated_token_program" | "clock_sysvar"
    #           | "<base58-pubkey>"
    #   pda = { seeds = ["literal:foo", "account:<name>",
    #                    "signer:agent" | "signer:admin",
    #                    "program:self" | "program:<alias>",
    #                    "pubkey:<base58>"],
    #           program = "self" }
    #   owner = { program_so = "../path/to/sibling.so" }
    #         | { pubkey = "<base58>" }   # external owners only
    # `address` and `pda` are mutually meaningful (use one). `owner`
    # is shared-only. Exactly one of `program_so` / `pubkey` must be
    # set inside `owner`. The PDA seed prefixes accept `literal:<bytes>`,
    # `account:<adapter-account-name>`, `signer:agent`, `signer:admin`,
    # `program:<alias-or-self>`, and `pubkey:<base58>`.

    [instructions]
    # <ix_name> = { action = "<declared action>", amount = "<runtime arg>",
    #               args = { <arg_name> = <literal>, ... } }
    # Both `amount` and `args` are optional.
    # - `amount` names the IDL arg the engine binds the runtime-computed
    #   amount into. Omit for zero-arg instructions.
    # - `args` declares literal constants or `@persona.<key>` references
    #   for any IDL arg that is NOT the runtime amount. Each value is
    #   either a TOML primitive (int, bool, base58 string for pubkey) or
    #   the literal string `"@persona.<key>"` to resolve from
    #   per-persona `persona_args` at dispatch time.
    <ix_name> = { action = "<action>", amount = "<arg>" }
    <multi_arg_ix> = { action = "<action>",
                      amount = "<runtime_arg>",
                      args = { <const_arg> = 0,
                               <pubkey_arg> = "<base58>",
                               <persona_bound_arg> = "@persona.<key>" } }

    [state_mapping]
    # Dotted-path key `<account>.<field>` → logical observation name
    # declared under [observations]. Both sides are arbitrary labels.
    # The LHS account part MUST match a declared `[accounts.<name>]`.
    "<account>.<field>" = "<observation>"

    [actions.<name>]
    # Every action referenced by an instruction MUST have a block here.
    label = "<human label>"
    takes = ["<arg_1>", "<arg_2>", ...] # 0..N args; multi-arg supported

    [observations]
    "<observation>" = "uint" | "int" | "bool" | "pubkey" | "map"
    # Detailed form also accepted:
    # "<observation>" = { type = "uint", label = "Human label" }

    [personas.<name>]
    # At least one persona is REQUIRED.
    label = "<human label>"
    action_rate_multiplier = <float> # 1.0 is neutral
    action_weights = { <action> = <float>, ... }
    triggers = [{ if = "<observation> <op> <const>",
                  then = "<action>",
                  weight_boost = <float> }]
    # Trigger operators in v0: < > ==
    # Optional per-persona named values resolved by `@persona.<key>`
    # references in `[instructions].<ix>.args`:
    persona_args = { <key> = <literal>, ... }

## Optional blocks (emit when relevant)

    [[invariants]]
    # Flat list. Tick loop checks each entry against post-action
    # observations. Field must be a declared observation name.
    name = "<optional readable name>"
    field = "<observation>"
    op = "==" | "!=" | ">=" | "<=" | ">" | "<"
    value = <number>

    [[oracles]]
    # Optional. Loader currently caps to ONE entry per adapter.
    name = "<logical id>"
    kind = "admin-mock"
    account = "<accounts.<name>>" # optional, generic-path only
    base_price = 100.0   # default 100.0
    exponent = 0         # default 0
    confidence = 0       # optional

    # Protocol-specific oracle layouts belong in harness code or a
    # custom helper, not generated MVP adapter TOML.

    [[scheduled_actions]]
    # Optional. Engine fires `instruction` every `interval_ticks` ticks
    # BEFORE persona actions for that tick. `instruction` must be a key
    # of [instructions]. `accounts` and `args` are passed through to
    # the primitive's scheduled-action hook. For generic SBF/IDL
    # adapters, the hook dispatches the underlying IDL instruction.
    name = "<optional readable name>"
    instruction = "<ix_name>"
    interval_ticks = <positive integer>
    accounts = ["<accounts.<name>>", ...]   # optional
    args = { <key> = <json-value>, ... }    # optional

    [lineage]
    # Always emit this block. Reviewer-facing metadata.
    idl_source = "<path or URL>"
    generator = "riptide-adapt@<git-sha-if-known> | hand-authored"
    inferred_assumptions = [
      "short string per non-trivial assumption you made that is not literally in the IDL",
    ]
    unsupported_fields = [
      "instruction `<name>` — reason it's intentionally not modeled",
      "account `<name>.<field>` — reason it's intentionally not modeled",
    ]

Do NOT emit a `[semantics]` block for generic adapters. The only
class the loader currently accepts is `lending.v1`; everything else
is reserved-but-rejected.

## External oracle detection

When scanning source files around oracle instructions and account
validation:

- If the program can read the simple admin-mock layout, emit
  `kind = "admin-mock"`.
- If the program expects a protocol-specific oracle account or CPI,
  record it in lineage as requiring harness setup, a loaded real
  program, or a custom mock. Do not emit non-existent built-in kinds.

## Hard rules

1. The file must be pure TOML. No prose, no markdown fences, no
   explanatory commentary outside `# comments`.
2. Every field you are uncertain about MUST carry a trailing
   `# TODO: <what to verify>` comment on that line. Examples:

       mine = { action = "mine", amount = "amount" } # TODO: verify arg name in IDL
       space = "auto" # TODO: confirm IDL account size is correct, or replace with explicit bytes

3. Declare at least one `[accounts.*]` block, at least one
   `[instructions]` mapping, at least one `[actions.*]` block, at
   least one `[observations]` entry, and at least one `[personas.*]`
   block. Empty required blocks are rejected by the validator.
4. Every `[instructions].<ix>.action` must match a declared
   `[actions].<name>`. Every `[personas].*.action_weights` key and
   every `triggers[].then` must also match a declared action.
5. Every `[state_mapping]` key must start with a declared
   `[accounts].*` name (e.g. `"player.gold"` requires `[accounts.player]`).
6. For every action, `takes` lists the IDL args **in declaration
   order**. Each argument must bind via the corresponding
   `[instructions].<ix>` entry — either as `amount = "<that_arg>"`
   (the single runtime-bound arg) or as `args.<that_arg> = <literal
   or @persona.key>`. An arg that appears in `takes` but is not
   bound anywhere is an adapter error.
7. For multi-arg instructions, only ONE arg may be runtime-bound via
   `amount`; the others are literal- or persona-bound via `args`.
8. `kind = "agent"` accounts get one bootstrap copy per simulated
   agent; `kind = "shared"` accounts get exactly one. PDA `seeds`
   referencing `signer:agent` only make sense on `kind = "agent"`
   accounts; `signer:admin` is for shared accounts owned by the
   admin signer.
9. `[[oracles]]` is capped at a single entry per adapter today.
   Declare more than one and the loader rejects the file.
10. Do not invent instruction names or argument names that are not
    present in the IDL. When a field is a guess, mark it `# TODO:`.
11. Keep persona triggers to the three supported operators (`<`,
    `>`, `==`) and the `<observation> <op> <constant>` shape.

## Inputs you have

You already have (from the current session):

  - the program IDL (required) — read `instructions[*]` + `accounts[*]`
    directly
  - an optional human hint from the user describing the program
  - optionally a compiled `.so` path. If present, copy it verbatim
    into the top-level `program_so` field. If absent, emit a
    best-guess path (relative to the adapter file) and mark it
    `# TODO:`.
  - optionally a source tree path — use it as a cross-reference
    when naming accounts / instructions; do not emit it into the TOML.
  - optionally an existing `.riptide/adapters/<name>.toml` from
    `riptide init`. Treat it as the seed and preserve its choices.

## After you generate

1. Write the TOML to disk. Default path priority:
   1. `.riptide/adapters/<program-name>.toml` if `.riptide/` exists.
   2. `./fixtures/adapters/<program-name>.toml` if the user is
      clearly working under a fixtures directory.
   3. `./adapter.toml` only if neither of the above applies.
   If still ambiguous, ask the user.
2. Invoke `riptide adapt --adapter <written-path>` as a bash command.
3. Report the result to the user:
   - exit 0 → PASS, show them the adapter path and any `# TODO:`
     markers still inside, and tell them they can now
     `riptide lint <name>` and `riptide run`.
   - exit 1 → smoke failed, show the engine stderr tail and offer to
     iterate on the `# TODO:` markers
   - exit 2 → TOML parse or Zod validation failed, fix and regenerate
4. If the first attempt's validation fails, do NOT retry blindly.
   Read the specific error from `riptide adapt`'s stderr, fix the
   one field it complained about, rewrite the file, and re-invoke.

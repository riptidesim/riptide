# Generate: generic adapter TOML

You are running inside a Claude Code session invoked via the
`riptide-adapt` skill. You have already classified the target program
as `generic` (per `classify.md`). Now emit a single TOML document
describing how Riptide should drive this program through the
`generic` primitive, then write it to disk and hand it off to
`riptide adapt` for smoke testing.

The TOML MUST match the shipped serde schema in
`engine/src/adapter/schema.rs` and the Zod schema in
`cli/src/schemas/adapter.ts`. Any deviation is a hard failure in the
downstream validator — `riptide adapt` will exit 2 on a bad shape.

## Required top-level keys for a generic adapter

    protocol = "generic"
    program_so = "<path to compiled.so>" # relative to the adapter file
    idl_path = "<path to IDL json>" # relative to the adapter file

    [accounts.<name>]
    # One block per account type the simulator needs at bootstrap.
    # `kind` is "agent" (one per simulated agent) or "shared"
    # (one globally for the run). `space` is the account size in bytes.
    kind = "agent" | "shared"
    space = <positive integer>

    [instructions]
    # <ix_name> → { action = <declared generic action>, amount? = <arg> }
    <ix_name> = { action = "<action>", amount = "<arg>" }

    [state_mapping]
    # Dotted-path key `<account>.<field>` → logical observation name
    # declared under [observations]. Both sides are arbitrary labels for
    # the generic primitive; lending canonical names do NOT apply.
    "<account>.<field>" = "<observation>"

    [actions.<name>]
    # Every action referenced by an instruction MUST have a block here.
    label = "<human label>"
    takes = ["<single_arg>"] | [] # v0 supports 0 or 1 arg, no more

    [observations]
    # Map of observation name → type. Compact form:
    "<observation>" = "uint" | "int" | "bool" | "pubkey" | "map"

    [personas.<name>]
    # At least one persona is REQUIRED.
    label = "<human label>"
    action_rate_multiplier = <float> # 1.0 is neutral
    action_weights = { <action> = <float>,... }
    triggers = [{ if = "<observation> <op> <const>", then = "<action>", weight_boost = <float> }]
    # Trigger operators supported in v0: < > ==

## Hard rules

1. The file must be pure TOML. No prose, no markdown fences, no
   explanatory commentary outside `# comments`.
2. Every field you are uncertain about MUST carry a trailing
   `# TODO: <what to verify>` comment on that line. Examples:

       mine = { action = "mine", amount = "amount" } # TODO: verify arg name
       space = 128 # TODO: confirm actual account size

3. Declare at least one `[accounts.*]` block, at least one
   `[instructions]` mapping, at least one `[actions.*]` block, at
   least one `[observations]` entry, and at least one `[personas.*]`
   block. Empty blocks are rejected by the validator.
4. Every `[instructions].<ix>.action` must match a declared
   `[actions].<name>`. Every `[personas].*.action_weights` key and
   every `triggers[].then` must also match a declared action.
5. Every `[state_mapping]` key must start with a declared
   `[accounts].*` name.
6. Do not invent instruction names or argument names that are not
   present in the IDL. When a field is a guess, mark it `# TODO:`.
7. Keep persona triggers to the three supported operators (`<`, `>`,
   `==`) and the `<observation> <op> <constant>` shape.

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

## After you generate

1. Write the TOML to disk. Default path: `./adapter.toml`, or
   `./fixtures/adapters/<program-name>.toml` if the user clearly
   wants it under a fixtures directory. If the intent is ambiguous,
   ask the user where to write it.
2. Invoke `riptide adapt --adapter <written-path>` as a bash command.
3. Report the result to the user:
   - exit 0 → PASS, show them the adapter path and any `# TODO:`
     markers still inside
   - exit 1 → smoke failed, show the engine stderr tail and offer to
     iterate on the `# TODO:` markers
   - exit 2 → TOML parse or Zod validation failed, fix and regenerate
4. If the first attempt's validation fails, do NOT retry blindly.
   Read the specific error from `riptide adapt`'s stderr, fix the one
   field it complained about, rewrite the file, and re-invoke.

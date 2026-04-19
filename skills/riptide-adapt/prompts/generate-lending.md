# Generate: lending adapter TOML

You are running inside a Claude Code session invoked via the
`riptide-adapt` skill. You have already classified the target program
as `lending` (per `classify.md`). Now emit a single TOML document
describing how Riptide should drive this lending program, then write
it to disk and hand it off to `riptide adapt` for smoke testing.

The TOML MUST match the shipped serde schema in
`engine/src/adapter/schema.rs` and the Zod schema in
`cli/src/schemas/adapter.ts`. Any deviation is a hard failure in the
downstream validator — `riptide adapt` will exit 2 on a bad shape.

## Required top-level keys for a lending adapter

    protocol = "lending"

    [instructions]
    # One entry per on-chain ix the simulator should be able to dispatch.
    # `action` must be one of the canonical labels:
    # deposit | borrow | repay | withdraw | liquidate
    # `amount` names the instruction argument that carries the amount
    # the engine will pass in when sizing the action. Omit `amount` only
    # for zero-argument instructions (rare for lending).
    <ix_name> = { action = "<canonical>", amount = "<arg_name>" }

    [state_mapping]
    # Dotted-path key `<account>.<field>` → logical observation name.
    # Logical observation name must be one of:
    # tvl | debt | bad_debt | collateral | liquidated
    "<account>.<field>" = "<logical>"

    [actions]
    # Empty table. Lending adapters carry no inline action definitions;
    # the primitive supplies the five canonical actions itself.

    [observations]
    # Empty table. Same reason.

    [personas]
    # Empty table. Lending adapters reuse the default DeFi persona library.

## Hard rules

1. The file must be pure TOML. No prose, no markdown fences, no
   explanatory commentary outside `# comments`.
2. Every field you are uncertain about MUST carry a trailing
   `# TODO: <what to verify>` comment on that line. Examples:

       borrow = { action = "borrow", amount = "liquidity_amount" } # TODO: verify arg name in IDL
       "reserve.total_liquidity" = "tvl" # TODO: confirm this is the pool TVL field

3. Map every canonical lending action at least once. If the IDL has
   no obvious match for one of the five actions, still emit the entry
   with the best-guess instruction name and a `# TODO:` marker.
4. Include at least one observation for each of `tvl`, `debt`, and
   `collateral`. Missing `tvl` or `collateral` is a hard failure in
   downstream validation.
5. Keep the empty `[actions]`, `[observations]`, `[personas]` tables
   present — they are required by the serde schema.
6. Do not invent fields or accounts that are not in the IDL. Use the
   literal account + field names from the provided IDL.
7. Do not include `program_so`, `idl_path`, or `[accounts]`. Those
   are only used by the generic primitive.

## Inputs you have

You already have (from the current session):

  - the program IDL (required) — read `instructions[*]` + `accounts[*]`
    directly
  - an optional human hint from the user
  - optionally a compiled `.so` path — IGNORE for lending adapters,
    they don't carry `program_so`
  - optionally a source tree path — use it as a cross-reference when
    picking canonical instruction / account field names, but do not
    emit it into the TOML

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

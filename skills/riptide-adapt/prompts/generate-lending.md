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

## Important: lending has two runtime shapes

An adapter with `program_so` + `idl_path` + populated `[accounts]`
uses the generic SBF/IDL runtime, even when `protocol = "lending"`.
That is the shape to produce when the user is wiring their own
compiled lending program.

A lending adapter may also intentionally omit `program_so` and
`idl_path` to target the bundled lending primitive. That is the shape
emitted by a fresh `riptide init --protocol lending` scaffold and by
the canonical lending fixture. Do not add generic-runtime fields to
that stub unless the user is actually wiring a compiled program IDL.

What `lending` actually changes for you:

- Use the canonical action labels in `[instructions].<ix>.action`
  (`deposit | borrow | repay | withdraw | liquidate`).
- Use the canonical logical observation names where the matching
  field exists (`tvl | debt | bad_debt | collateral | liquidated`).
- Emit a `[semantics]` block with `class = "lending.v1"` and the
  four required roles (`position`, `reserve`, `oracle`,
  `liquidation_config`). This is the only semantic class the loader
  currently accepts.

## Existing scaffold takes precedence

If `.riptide/adapters/<program-name>.toml` already exists, **read it,
preserve the wizard's choices, and fill in TODO blocks** rather than
overwriting. Specifically preserve:

- `protocol = "lending"`,
- existing `program_so` / `idl_path` values when present, or their
  intentional absence when the stub targets the bundled primitive,
- the wizard-inlined `[personas.*]` blocks (these are the user's
  selection from the init wizard — do not rewrite their
  `action_weights` unless an action there is literally not declared
  in `[actions]`),
- any populated `[lineage]` block.

## Required top-level keys for a lending adapter

    protocol = "lending"

For an IDL-backed adapter that dispatches the user's compiled program,
also include:

    program_so = "<path to compiled .so>" # relative to the adapter file
    idl_path = "<path to IDL json>" # relative to the adapter file

    [accounts.<name>]
    # One block per account the bootstrap needs to create. Typical
    # lending shape: at least one shared `pool` / `reserve` account
    # and one agent `position` / `obligation` account, plus the oracle
    # account if you map it.
    kind = "agent" | "shared"
    space = <positive integer>
    # Optional: address / pda / owner (same DSL as generic — see
    # generate-generic.md). Lending adapters typically declare PDAs
    # for the reserve and per-agent obligation accounts.

    [instructions]
    # One entry per on-chain ix the simulator should be able to
    # dispatch. `action` MUST be one of:
    # deposit | borrow | repay | withdraw | liquidate.
    # `amount` names the IDL argument carrying the runtime-computed
    # amount. Multi-arg lending instructions (e.g. liquidate with both
    # `repay_amount` and a target index) bind extras via `args`:
    deposit   = { action = "deposit",   amount = "amount" }
    borrow    = { action = "borrow",    amount = "amount" }
    repay     = { action = "repay",     amount = "amount" }
    withdraw  = { action = "withdraw",  amount = "amount" }
    liquidate = { action = "liquidate", amount = "repay_amount",
                  args = { liquidator = "@persona.liquidator_pubkey" } }

    [state_mapping]
    # Map account fields onto the canonical lending observation names
    # wherever a matching field exists. Other fields use generic
    # dotted-path observation names like the generic adapter form.
    # Canonical lending names: tvl | debt | bad_debt | collateral | liquidated.
    "pool.total_deposits"  = "tvl"
    "pool.total_borrows"   = "debt"
    "pool.bad_debt"        = "bad_debt"
    "position.collateral"  = "collateral"
    "position.debt"        = "debt"
    "position.liquidated"  = "liquidated"

    [actions.deposit]
    label = "Deposit"
    takes = ["amount"]

    [actions.borrow]
    label = "Borrow"
    takes = ["amount"]

    [actions.repay]
    label = "Repay"
    takes = ["amount"]

    [actions.withdraw]
    label = "Withdraw"
    takes = ["amount"]

    [actions.liquidate]
    label = "Liquidate"
    takes = ["repay_amount"]

    [observations]
    tvl        = "uint"
    debt       = "uint"
    bad_debt   = "uint"
    collateral = "uint"
    liquidated = "bool"

    [personas.<name>]
    # At least one persona is required. When the user has gone
    # through `riptide init`, the wizard has already inlined the
    # selected personas (e.g. `steady-lp`, `cautious-yield-farmer`,
    # `degen-borrower`, `aggressive-arb-bot`, `panic-whale`,
    # `whale`). PRESERVE those if they exist; only refine action
    # weights when the user picked an action key that is not declared
    # in `[actions]`.
    label = "<human label>"
    action_rate_multiplier = <float>   # 1.0 is neutral
    action_weights = { deposit = <f>, borrow = <f>, repay = <f>,
                       withdraw = <f>, liquidate = <f> }
    triggers = [{ if = "<observation> <op> <const>",
                  then = "<canonical action>",
                  weight_boost = <float> }]

## Required `[semantics]` block

    [semantics]
    class = "lending.v1"
    # All four roles below are REQUIRED for class = "lending.v1".
    # `source` names a key in [accounts] (or, for instruction-bound
    # roles, a key in [instructions]). Field types: u64 | u128 | i64 |
    # i128 | bool | pubkey.

    [semantics.roles.position]
    source = "position"   # the per-agent obligation/position account
    fields = { collateral = "u64", debt = "u64", liquidated = "bool" } # TODO: confirm IDL field types

    [semantics.roles.reserve]
    source = "pool"       # the shared pool/reserve account
    fields = { total_deposits = "u64", total_borrows = "u64", bad_debt = "u64" } # TODO: confirm IDL field types

    [semantics.roles.oracle]
    source = "<oracle account name>" # TODO: name an [accounts.<name>]
    fields = { price = "u64" }       # TODO: confirm field name + type

    [semantics.roles.liquidation_config]
    source = "<config account name>" # TODO: name an [accounts.<name>]
    fields = { ltv_bps = "u64", liquidation_threshold_bps = "u64",
               close_factor_bps = "u64" } # TODO: confirm field names

    # Optional derived observations expressed against the roles above.
    # [semantics.derived]
    # health_factor = "(position.collateral * liquidation_config.liquidation_threshold_bps) / (position.debt * 10000)"

    # Optional declarative invariants (lending-specific). Use the same
    # operators as the top-level `[[invariants]]`.
    # [[semantics.invariants]]
    # name = "no_bad_debt"
    # expr = "reserve.bad_debt == 0"
    # severity = "error"

If you cannot identify ALL four required roles from the IDL, mark
the missing pieces with `# TODO:` markers and proceed; the loader
will reject the file with an explicit "missing role" error and you
can iterate from there.

## Optional blocks (emit when relevant)

    [[invariants]]
    name = "<readable name>"
    field = "<observation or snapshot metric>"
    op = "==" | "!=" | ">=" | "<=" | ">" | "<"
    value = <number>
    # Lending snapshot metrics in addition to declared observations:
    # tvl, utilization, oracle_price, cumulative_bad_debt,
    # cumulative_liquidations, active_agents, tick.

    [[oracles]]
    # Optional. Loader currently caps to ONE entry per adapter.
    name = "<logical id>"
    kind = "admin-mock"
    account = "<accounts.<oracle-name>>"  # optional
    base_price = 100.0
    exponent = 0
    confidence = 0       # optional

    # Protocol-specific oracle layouts belong in harness code or a
    # custom helper, not generated MVP adapter TOML.

    [[scheduled_actions]]
    name = "<readable name>"
    instruction = "<ix_name>"   # must be a key of [instructions]
    interval_ticks = <positive integer>
    accounts = ["<accounts.<name>>", ...]   # optional
    args = { <key> = <json-value>, ... }    # optional
    # For IDL-backed lending adapters, use this for refresh paths such
    # as `refresh_reserve`: oracle write, scheduled refresh, then
    # persona deposit/borrow/repay/withdraw actions.

    [lineage]
    # Always emit this block.
    idl_source = "<path or URL>"
    generator = "riptide-adapt@<git-sha-if-known> | hand-authored"
    inferred_assumptions = [ "<short string>", ... ]
    unsupported_fields = [ "<short string>", ... ]

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

       borrow = { action = "borrow", amount = "liquidity_amount" } # TODO: verify arg name in IDL
       "reserve.total_liquidity" = "tvl" # TODO: confirm this is the pool TVL field

3. Map every canonical lending action at least once. If the IDL has
   no obvious match for one of the five actions, still emit the
   entry with the best-guess instruction name and a `# TODO:` marker.
4. Include at least one observation for each of `tvl`, `debt`, and
   `collateral`. Missing `tvl` or `collateral` is a hard failure in
   downstream validation.
5. Every `[instructions].<ix>.action` must be one of the canonical
   labels. Every `[actions].<name>` must match those canonical labels.
6. Every `[state_mapping]` key must start with a declared
   `[accounts].*` name.
7. For IDL-backed lending adapters, emit the `[semantics]` block and
   declare all four roles (`position`, `reserve`, `oracle`,
   `liquidation_config`). The loader rejects `lending.v1` adapters
   missing any required role. If you are deliberately preserving a
   bundled-primitive stub that omits `program_so` / `idl_path`, leave
   its existing semantics shape alone.
8. Do not invent fields or accounts that are not in the IDL. Use the
   literal account + field names from the provided IDL.
9. Persona triggers use `<`, `>`, `==` and the
   `<observation> <op> <constant>` shape.

## Inputs you have

You already have (from the current session):

  - the program IDL (required) — read `instructions[*]` + `accounts[*]`
    directly
  - an optional human hint from the user
  - optionally a compiled `.so` path. If present and the user is
    wiring an IDL-backed adapter, copy it verbatim into the top-level
    `program_so` field. If absent for an IDL-backed adapter, emit a
    best-guess path (relative to the adapter file) and mark it
    `# TODO:`. If the existing lending stub is intentionally using the
    bundled primitive, preserve the absence of `program_so`.
  - optionally a source tree path — use it as a cross-reference when
    picking canonical instruction / account field names, but do not
    emit it into the TOML.
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

# Classify: lending vs generic

You are running inside a Claude Code session invoked via the
`riptide-adapt` skill. Your job right now is to read the user's
Solana program IDL and decide whether Riptide should model it with
the `lending` semantic class or the `generic` runtime.

## Rule

Pick `lending` if and only if the program is unambiguously a
collateralized lending / borrowing protocol in the Solend / Save /
MarginFi / Kamino family. Concretely, it must expose *all five* of
these logical actions somewhere in its instruction set, by name or
by clear semantics:

  - `deposit` (supply collateral)
  - `borrow` (open or increase debt)
  - `repay` (reduce outstanding debt)
  - `withdraw` (reduce supplied collateral)
  - `liquidate` (seize under-collateralized positions)

And it must expose all of these via account state:

  - pool-wide reserves (total deposits + total borrows + bad debt)
  - per-position collateral + debt
  - an oracle account or oracle-equivalent price input
  - a liquidation-config / risk-parameter source
    (LTV / liquidation threshold / close factor)

Anything else is `generic`. AMMs, order books, perps, staking, NFT
marketplaces, games, resource sims, and anything domain-specific all
fall into `generic`. When in doubt, pick `generic` — the only
semantic class the loader currently accepts is `lending.v1`
(`SUPPORTED_SEMANTIC_CLASSES` in `engine/src/adapter/schema.rs`).
The other class strings reserved by the design doc
(`perps-margin.v1`, `amm.v1`, `lst.v1`, `stablecoin.v1`) are NOT yet
accepted; programs in those families classify as `generic`.

## Note on runtime vs. classification

Both classes use the **generic SBF/IDL runtime** when `program_so`
and `idl_path` are present. A lending adapter may intentionally omit
those fields when it targets the bundled lending primitive, as the
fresh `riptide init --protocol lending` stub does. The classification
only changes:

  - which generation prompt you apply (`generate-lending.md` vs
    `generate-generic.md`),
  - whether you emit a `[semantics] class = "lending.v1"` block,
  - what canonical action labels you use in `[instructions].<ix>.action`
    (lending: `deposit | borrow | repay | withdraw | liquidate`;
    generic: any string the adapter declares under `[actions]`),
  - whether you map `[state_mapping]` values onto the canonical
    lending observation names (`tvl | debt | bad_debt | collateral
    | liquidated`) when the matching field exists.

## Inputs you have

You already have the user's program IDL in the session (either the
path was passed when the skill was invoked, or you auto-detected it
under `./target/idl/`, `./idls/`, or `./fixtures/idls/`, or read it
out of an existing `.riptide/adapters/<name>.toml`'s `idl_path`).
You may also have:

  - an optional human hint from the user describing the program
  - an optional compiled `.so` path
  - an optional source-tree path
  - an existing `.riptide/adapters/<name>.toml` stub from
    `riptide init`. Its `protocol = "..."` line is the wizard's hint
    and should be respected unless the IDL clearly contradicts it.

Read the IDL's `instructions` array and `accounts` array directly
from the session — do not ask the user to paste it back to you.

## Output

Record your decision as a single line of working memory of the form:

    classification = lending # or: generic
    reason = <one short sentence explaining why>

Then proceed directly to the matching generation prompt:

  - if `classification = lending`, read and apply
    `skills/riptide-adapt/prompts/generate-lending.md`
  - if `classification = generic`, read and apply
    `skills/riptide-adapt/prompts/generate-generic.md`

You do not need to emit machine-readable JSON. The classifier step
and the generator step are both happening inside the same session;
your own working memory is the channel.

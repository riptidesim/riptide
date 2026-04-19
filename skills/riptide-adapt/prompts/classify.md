# Classify: lending vs generic

You are running inside a Claude Code session invoked via the
`riptide-adapt` skill. Your job right now is to read the user's
Solana program IDL and decide whether Riptide should model it with
the `lending` primitive or the `generic` primitive.

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

And it must expose both of these observations via account state:

  - pool-wide reserves (total deposits + total borrows + bad debt)
  - per-position collateral + debt

Anything else is `generic`. AMMs, order books, perps, staking, NFT
marketplaces, games, resource sims, and anything domain-specific all
fall into `generic`. When in doubt, pick `generic`.

## Inputs you have

You already have the user's program IDL in the session (either the
path was passed when the skill was invoked, or you auto-detected it
under `./target/idl/` or `./fixtures/idls/`). You may also have:

  - an optional human hint from the user describing the program
  - an optional compiled `.so` path
  - an optional source-tree path

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

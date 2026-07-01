# Detect & Scope

The first two steps of the flow: establish the protocol family from real
evidence, then classify what authoring complexity the guided sim must handle so
the sim crate lands the flows right the first time.

## 1. Detect

1. Establish the repo root from `.riptide/`, `Anchor.toml`, `Cargo.toml`,
   `target/idl`, or the current directory.
2. Read existing artifacts before asking the user: `.riptide/adapters/*.toml`
   (especially `[semantics].class`), `target/idl/*.json`, `app/src/idl/*.json`,
   source, tests, any existing `.riptide/sim/`, and `target/deploy/*.so`.
3. Optionally classify with the read-only check: `riptide readiness . --json`.
4. Classify the protocol family from semantics first, else source/IDL evidence:
   - **lending** — `borrow`, `repay`, `deposit`, `withdraw`, `liquidate`,
     collateral, debt, reserve, oracle.
   - **amm** — `swap`, `add_liquidity`, `remove_liquidity`, pool, reserve, LP
     mint, fee, tick/price.
   - **perps** — `open_position`, `close_position`, margin, leverage, funding,
     oracle, insurance fund.
   - **lst** — stake, unstake, exchange rate, validator, reserve, withdrawal
     queue, slash.
   - **stablecoin** — mint, redeem, collateral, liability, peg, PSM, reserve,
     hedge.
5. Record a one-screen detection note: family, semantic class, confidence
   (`high`/`medium`/`low`), evidence paths, competing interpretations. If
   confidence is low between two families, ask one classification question
   (counts toward the three-question limit).

Read the P0/P1 state-changing instructions: for each, read the IDL `args` and
`accounts` entries plus the handler source. This feeds the next step.

## 2. Scope — classify what the guided sim must handle (A–F)

There is ONE execution path (the guided sim). This step is not "which path" —
it is "**what authoring complexity** does this protocol need", so the sim crate
lands the flows right the first time. For every P0/P1 instruction, check the six
triggers below. Each trigger that fires names a concrete authoring pattern.

**Trigger A — non-primitive or enum instruction arguments.** The instruction
takes an enum, struct, `String`, or `Vec` argument, which raw scalar dispatch
cannot encode. Detect: IDL argument types other than integers, bools, and
pubkeys — `"defined"`, `"string"`, or `"vec"` entries in the IDL, or enum/struct
parameters in the handler signature. Worked example: a `swap` taking a
`SwapDirection` enum, or order placement taking side/kind enums — both need
typed argument builders in a generated sim crate.

**Trigger B — external oracle accounts needing byte-construction.** The program
reads price or attestation bytes from an account owned by an external program
(Pyth receiver, Switchboard, a custom attestor), and the stress axis is that
account's contents, so the sim must construct and mutate those bytes
deterministically. Detect: external SDK account types in the handler (for
example `pyth_solana_receiver_sdk::price_update::PriceUpdateV2`), calls like
`get_price_no_older_than`, or freshness windows checked against the clock.
Worked example: a liquidation reads a Pyth `PriceUpdateV2`, so the sim builds the
account bytes and crashes the price; a withdrawal checks a NAV-attestation
account inside a freshness window.

**Trigger C — third-party / target-vs-agent actions.** An actor signs an
instruction that operates on another actor's position or order — liquidator,
keeper, matcher, settler. A self-signed persona action only expresses an agent
acting on its own accounts. Detect: instruction account sets that contain both a
signer and a different user's position/order PDA — `liquidate`, `settle`,
`slash`, keeper cranks. Worked example: a liquidation that lets any third party
repay a borrower's debt and seize collateral; a keeper that settles a buyer and
a seller it does not own.

**Trigger D — multi-instruction sequences.** A flow only completes across an
ordered multi-instruction transaction or a multi-transaction sequence (request,
then execute, then claim). Detect: request/execute instruction pairs,
pending-state accounts, or instruction-introspection requirements such as a
required ed25519 verification instruction. Worked example: a withdrawal that is
a multi-transaction sequence whose execute step must land inside the attestation
window; a flow requiring an ed25519 signature verification instruction ahead of
the consuming instruction in the same transaction.

**Trigger E — dynamic `remaining_accounts`.** The instruction's account set
varies per call with protocol state, so no static account mapping exists.
Detect: `ctx.remaining_accounts` in handlers, or loops over member/position
lists. Worked example: a slash redistribution that iterates every remaining
member's account; an integration that passes a dependency account set changing
per call.

**Trigger F — custom CPI bootstrapping.** Reaching a runnable tick-0 state needs
CPIs into external programs, or manual deployment and configuration of sibling
programs. Detect: init handlers that CPI into a dependency program, multi-program
genesis in `Anchor.toml` test config, or registration steps in the test suite.
Worked example: a program that must bootstrap its dependency programs and
register its signature oracle before any flow can run.

**Verdict:**

- **No trigger on any P0/P1 flow → `baseline-sim`.** Low-touch: primitive
  arguments, self-signed instructions, no externally owned account bytes to
  evolve mid-run. Confirm by running, not reading — a one-seed smoke. Borderline
  calls (a keeper-reward liquidation that might still be self-service; a mock
  oracle passed as a primitive argument a real deployment would replace with an
  oracle account) flip on real evidence — record the fragility.
- **One or more triggers on a P0 flow → `guided-sim-authored`** for those flows:
  the sim hand-authors the patterns the triggers named. Trigger-free flows stay
  low-touch within the same crate.
- **FHE/MPC/ZK, external-venue execution, or off-chain matching the sim cannot
  model → `unsupported`** for those surfaces. Name them as scope boundaries
  instead of silently skipping them.

Record the classification note and carry it into the final report:

```text
program: <name>
archetype: <amm | lending | perps | lst | stablecoin | irs | nav-vault | orderbook | other>
triggers: <none | subset of A-F, with one line of evidence each>
authoring patterns: <per trigger — A typed-argument builders; B oracle-account
  construction; C third-party-actor dispatch; D multi-instruction flow;
  E dynamic account resolution; F bootstrap services>
verdict: <baseline-sim | guided-sim-authored | unsupported>
```

When any trigger fires, read [worst-case-playbook.md](./worst-case-playbook.md)
for the archetype's worst case to hunt, the axis to sweep, and the deciding
invariant/metric — **before** asking any scoping question.

Then ask **no more than three questions total**, one at a time, never for facts
already visible in source/IDL/tests/`.riptide`:

1. **Primary risk objective** — two to four options derived from the family and
   actual surfaces; recommend the archetype default unless evidence points
   elsewhere.
2. **Flow emphasis** — stress-flow families or program-specific flows matching
   real instructions/accounts; include one "balanced default".
3. **Missing assumption** — only when a material fact is not derivable (oracle
   account layout, authority policy, dependency fixture source, intended fee
   cap, accepted scope exclusion).

If the user says "use defaults", proceed with archetype defaults narrowed to the
program, and still show the choices before running.

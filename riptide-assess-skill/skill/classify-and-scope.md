# Classify & Scope

The first two stages. Classify decides whether the target is an Economic
Protocol and which family it belongs to. Scope decides what the guided sim must
handle, which worst case to hunt, and which assumptions go into the Scope
Declaration.

## 1. Classify

1. Establish the repo root from `.riptide/`, `Anchor.toml`, `Cargo.toml`,
   `target/idl`, or the current directory. If the Steering Hint names a
   program or path, that is the target.
2. Read the existing evidence first: `.riptide/adapters/*.toml` (especially
   `[semantics].class`), `target/idl/*.json`, `app/src/idl/*.json`, source,
   tests, any existing `.riptide/sim/`, and `target/deploy/*.so`.
3. Collect the Engine's read-only classification evidence:
   `riptide readiness . --json`.
4. Decide whether the target is an **Economic Protocol**: it holds or moves
   value through pooled assets, prices, collateral, debt, reserves or
   solvency. Apply the evidence rules in
   [The Economic Protocol verdict](#the-economic-protocol-verdict) below.
   - Not an Economic Protocol: stop and deliver an **Out-of-Scope Note**
     (see [report.md](./report.md)). No Scope, Setup or Run stage starts.
   - An Economic Protocol that matches no family below: continue with the
     generic Economic Protocol fallback in
     [family-library.md](./family-library.md). Novelty is never a reason to
     stop.
5. Name the family from semantics first, then source and IDL evidence:
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
6. Record a one-screen classification note: Economic Protocol verdict with its
   evidence, family, semantic class, confidence (`high`/`medium`/`low`),
   evidence paths and competing interpretations. When two families are close,
   take the one with more instruction-level evidence and add the other as an
   assumption in the Scope Declaration, with the Steering Hint that selects it.

Read the P0 and P1 state-changing instructions: for each, the IDL `args` and
`accounts` entries plus the handler source. Scope builds on this.

### The Economic Protocol verdict

The verdict is a judgment the Skill makes from the program's own IDL and
source; the Engine only checks the shape of what the Skill delivers. Family
matching never decides it: a program that fits no family is judged on its
signals like any other.

**Economic signals.** One signal, cited from the IDL or a handler, makes the
target an Economic Protocol:

- **Pooled value** — a program-owned vault, pool, reserve, treasury or
  insurance fund that user deposits enter and withdrawals leave (token
  `transfer`, `mint_to` or `burn` CPIs against a program PDA, or lamports
  held for users).
- **Claims on pooled value** — shares, LP tokens, receipts, deposits,
  collateral, debt, positions or margin that entitle a user to part of a pool.
- **Prices and rates** — an oracle account (Pyth, Switchboard, a custom
  attestor), a swap curve, an exchange rate, an interest or funding rate, or a
  fee charged on a value flow.
- **Solvency conditions** — a health factor, collateral ratio, liquidation,
  peg, redemption or withdrawal-queue rule.

**Out-of-scope shapes.** An NFT or collection mint with supply 1 per mint, a
metadata or name registry, a governance vote that holds no assets itself, an
identity or attestation registry, a game with no pooled value. These are out
of scope only when the IDL and handlers show no economic signal at all.

**Rules.**

1. Read every instruction in the IDL and the handlers of any instruction that
   touches a token or lamport balance before deciding. Instruction and
   account names alone are not evidence.
2. An Out-of-Scope Note needs positive evidence: at least one line per claim,
   each naming the file or IDL entry it comes from, that together show no
   economic signal. A missing IDL or unreadable source is not that evidence;
   it is a Gap, and the run continues or ends with a Blocker Report.
3. When a signal is present but weak (a mint price paid into a treasury, a fee
   on a registry), the target is an Economic Protocol. Record the reading as a
   Scope Declaration assumption with its reason and the Steering Hint that
   narrows it, and continue.
4. In a repo with several programs, classify each one. The run ends with an
   Out-of-Scope Note only when no program carries an economic signal;
   otherwise the economic programs are the target and the others are Scope
   Declaration assumptions.
5. An Economic Protocol whose shape matches no family is in scope. Record
   "no known family; generic Economic Protocol fallback" as an assumption,
   with the Steering Hint that selects a family as its override.
6. A Steering Hint that states the target holds pooled value overrides an
   out-of-scope verdict. Every Out-of-Scope Note names that override.

**Budget.** Classify reads only the IDL, source, tests and
`riptide readiness . --json`. It builds nothing, runs no `riptide init` and
generates no sim crate, so an Out-of-Scope Note is delivered about a minute
after the command starts.

## 2. Scope — what the guided sim must handle (A–F)

There is one execution path, the guided sim. Scope is not "which path"; it is
"**what authoring complexity** this protocol needs", so the sim crate lands the
flows right the first time. For every P0/P1 instruction, check the six
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
  model → `unsupported`** for those surfaces. Each one is a Gap in the
  Assessment, never a silent skip.

Record the classification note and carry it into the Assessment Context:

```text
program: <name>
archetype: <amm | lending | perps | lst | stablecoin | irs | nav-vault | orderbook | other>
triggers: <none | subset of A-F, with one line of evidence each>
authoring patterns: <per trigger — A typed-argument builders; B oracle-account
  construction; C third-party-actor dispatch; D multi-instruction flow;
  E dynamic account resolution; F bootstrap services>
verdict: <baseline-sim | guided-sim-authored | unsupported>
```

## 3. Choose the region

Pair two references for the archetype:
[family-library.md](./family-library.md) for the personas, Floor Invariants and
stress scenarios to start from, and
[worst-case-playbook.md](./worst-case-playbook.md) for the worst case to hunt,
the axis to sweep, and the deciding invariant or metric. The library seeds the
simulation; the playbook sharpens it to the worst case.

Then settle the three choices that shape the region. Each becomes a Scope
Declaration entry with its reason and overriding Steering Hint:

1. **Risk objective** — the archetype default unless the Steering Hint or the
   evidence points elsewhere (a focus area in the Steering Hint wins).
2. **Flow emphasis** — the stress flows matching real instructions and
   accounts; the balanced default when nothing points elsewhere.
3. **Assumptions for facts the repo does not carry** — oracle account layout,
   authority policy, dependency fixture source, intended fee cap, scope
   exclusions. Take the conservative reading and name it. If no reading can
   be defended from local evidence, the dependent surface is a Gap.

Never assume a fact already visible in source, IDL, tests or `.riptide/`; read
it.

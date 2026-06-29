---
name: riptide-assess
description: >-
  One front door for Riptide protocol assessments. Use when the user says
  "riptide-assess", "assess my protocol", "is my protocol safe", "run Riptide
  on this", "give me a risk assessment", or wants one agent-led flow from a
  Solana program repo to an assessment report. This skill detects the protocol
  family, scopes the risk, asks up to three scoped questions, delegates the
  guided-sim setup to riptide-config, runs the guided-sim evidence flow
  (sim generate, sim run, sim surface), and returns assessment evidence with
  exact rerun commands. For deeper guided-sim authoring without a final
  assessment, use riptide-config instead.
metadata:
  short-description: Run one Riptide assessment front door
---

# riptide-assess

You are the assessment practitioner. The user should point you at a Solana
program repo, answer at most three questions, and receive a generated
assessment report. The user does not author the adapter, guided-sim crate,
personas, flows, or invariants by hand.

This skill is an orchestration wrapper over existing Riptide machinery. It
does not replace `riptide-config`, and it does not introduce new engine or CLI
behavior.

## Contract

- Work in one continuous session: detect, scope, author, run, and deliver.
- Load and follow `skills/riptide-config/SKILL.md` for adapter, guided-sim
  setup, persona, flow, sweep, and invariant creation or repair. Do not
  reimplement that authoring contract inside this skill.
- Use existing CLI surfaces only. If command drift is possible, inspect the
  local command source or help before citing a flag.
- Keep the agent's choices visible: detected family, semantic class,
  guided-sim authoring needs (triggers found), risk objective,
  selected flow families, persona mix, invariants or metrics, confidence,
  and assumptions.
- Preserve rerunnability: every completed assessment response must include the
  exact guided-sim rerun commands (`riptide sim run ...` and
  `riptide sim surface ...`) that produced the assessed root, the exact
  `riptide assess ...` command, and the evidence-pack pointer.
- Preserve the trust boundary: the result is simulation evidence over declared
  inputs, not audit signoff or complete protocol safety.

If the user only asks to configure Riptide, finish an adapter, fill setup
seams, or prepare guided-sim readiness without asking for the assessment
report, use `riptide-config` instead.

## Protocol-Archetype Defaults

Use this table as the starting risk pack. The final choices must be narrowed to
the target program's actual instructions, accounts, IDL, tests, and existing
`.riptide` files.

The scenario and persona columns are what-to-test domain guidance, not flows
that run as-is. Every protocol is assessed through a guided sim, so take the
authoring shape from `references/worst-case-playbook.md` and Step 2's trigger
checklist rather than expecting the listed scenario families to execute
directly.

| Family | Detect from source or IDL | Semantic class | Default scenarios | Default persona mix | Default invariants or metrics | Risk objective |
| --- | --- | --- | --- | --- | --- | --- |
| lending | `borrow`, `repay`, `deposit`, `withdraw`, `liquidate`, collateral, debt, reserve, oracle | `lending.v1` | `lending/oracle-lag-baseline`, `lending/shock-magnitude-sweep`, `lending/utilization-climb`, `lending/whale-share-sweep`, `lending/whale-shock-grid` | depositors, borrowers, liquidators, whales, oracle or keeper pressure | `bad_debt_bound`, `ltv_below_max`, `collection_worst_health_factor`, liquidity, utilization, bad debt | liquidation-safety: stressed borrowers remain liquidatable without unbounded bad debt or liquidity exhaustion |
| amm | `swap`, `add_liquidity`, `remove_liquidity`, pool, reserve, LP mint, fee, tick or price | `amm.v1` | `amm/fee-growth-lp-accounting`, `amm/jit-liquidity-exit`, `amm/price-impact`, `amm/reserve-depletion-sweep`, `amm/sandwich-volume-spike` | swappers, LPs, large takers, arbitrage or timing pressure, JIT liquidity | `reserve_pair_nonzero_together`, `lp_supply_backed_by_liquidity`, `fee_config_bounded`, `stored_k_tracks_current_product`, reserve ratio, price impact | liquidity-accounting-and-price-impact: swaps and liquidity changes preserve reserve and LP accounting under pressure |
| perps | `open_position`, `close_position`, `liquidate`, margin, leverage, funding, oracle, insurance fund | `perps-margin.v1` | `perpetuals/funding-stress`, `perpetuals/insurance-socialized-loss`, `perpetuals/max-leverage-boundary-sweep`, `perpetuals/open-interest-skew-squeeze`, `perpetuals/oracle-shock-liquidation-cascade` | longs, shorts, high-leverage traders, liquidators, insurance or backstop pressure | `no_socialized_loss`, `max_leverage_respected`, `margin_above_maintenance_proxy`, `liquidation_buffer_nonnegative_proxy`, `funding_payment_bounded_proxy`, `insurance_coverage_nonnegative_proxy` | margin-solvency-and-liquidation-safety: leveraged accounts remain bounded by margin, funding, liquidation, and insurance constraints |
| lst | stake, unstake, exchange rate, validator, reserve, withdrawal queue, slash, delayed redemption | `lst.v1` | `liquid-staking/lst-lending-contagion`, `liquid-staking/reserve-refill-lag-sweep`, `liquid-staking/slash-magnitude-sweep`, `liquid-staking/slash-redemption-cascade`, `liquid-staking/withdrawal-queue-run-sweep` | stakers, redeemers, queue-heavy users, slash event pressure, reserve refill pressure | `exchange_rate_sanity_bound`, `reserve_buffer_within_assets`, `withdrawal_queue_within_assets`, `lst_supply_backed_by_pool_rate`, `no_slash_during_healthy_run`, `exchange_rate_bounded` | redemption-and-backing-safety: withdrawals, slash events, and reserve lag do not create unbacked claims or incoherent exchange rates |
| stablecoin | mint, redeem, collateral, liability, peg, PSM, reserve, hedge, issuer concentration | `stablecoin.v1` | `stablecoin/collateral-cascade-replay`, `stablecoin/hedge-loss-magnitude-sweep`, `stablecoin/mint-concentration-sweep`, `stablecoin/redemption-run-sweep`, `stablecoin/reserve-buffer-exhaustion-sweep` | minters, redeemers, peg keepers, concentrated issuers, reserve-drain pressure | `collateral_value_covers_liability_value`, `redemptions_within_collateral_value`, `hedge_gap_within_collateral_value`, `no_hedge_loss_during_healthy_run`, `collateral_ratio_bounded` | backing-and-redemption-safety: minted claims remain backed and redeemable under reserve, hedge, and concentration pressure |

## Step 1: Detect

1. Establish the repo root from `.riptide/`, `Anchor.toml`, `Cargo.toml`,
   `target/idl`, or the current directory.
2. Read existing artifacts before asking the user:
   - `.riptide/adapters/*.toml`, especially `[semantics].class`, lineage,
     observations, personas, and invariants.
   - `target/idl/*.json`, `app/src/idl/*.json`, source files, and tests.
   - `.riptide/sim/` (`Riptide.toml`, `src/flows.rs`) when a guided-sim crate
     already exists.
   - Build outputs such as `target/deploy/*.so` when present.
3. Optionally run the read-only readiness check when it helps classification:

```bash
riptide readiness . --json
```

4. Classify by existing semantics first. If semantics are absent, use source
   and IDL evidence:
   - lending: liquidation, borrow/debt, collateral, reserve, oracle.
   - amm: swap plus liquidity/reserve/LP terms.
   - perps: margin, leverage, funding, liquidation, insurance.
   - lst: stake, exchange rate, withdrawal queue, reserve, slash.
   - stablecoin: mint/redeem plus collateral, liability, peg, PSM, reserve.
5. Record a one-screen detection note for yourself: family, semantic class,
   confidence (`high`, `medium`, or `low`), evidence paths, and competing
   interpretations. If confidence is low between two families, ask one
   classification question before continuing; that counts toward the
   three-question limit.

## Step 2: Classify What The Guided Sim Must Handle

Every protocol is assessed through a project-owned Rust sim crate
(`.riptide/sim/`) that authors precise flows against the real program: typed
arguments, constructed oracle bytes, third-party dispatch, multi-instruction
sequences. Guided sim is the single execution path; there is no generic
campaign path. This step is not "which path" — it is "what authoring
complexity does this protocol need", so the sim crate lands the flows right
the first time.

Swap-shaped programs (AMMs and simple pools where an agent trades its own
tokens against program-owned reserves) need the least: primitive arguments,
self-signed instructions, no externally owned account bytes evolving mid-run.
Credit-shaped and orderbook-shaped protocols — anything with liquidation,
keepers, real oracle accounts, or settlement choreography — need more of the
authoring patterns below.

Classify before scoping so the sim authoring is sized right. For every P0/P1
state-changing instruction, read the IDL `args` and `accounts` entries plus
the handler source, and check the six triggers below. Each trigger that fires
on a P0 flow names a concrete authoring pattern the guided sim must
implement.

### Trigger checklist

**Trigger A — non-primitive or enum instruction arguments.** The instruction
takes an enum, struct, `String`, or `Vec` argument, which raw scalar dispatch
cannot encode. Detect: IDL argument types other than integers, bools, and
pubkeys — `"defined"`, `"string"`, or `"vec"` entries in the IDL, or
enum/struct parameters in the handler signature. Worked example: a protocol's
`swap` takes a `SwapDirection` enum, and a protocol's order placement takes
side/kind enums — both need typed argument builders in a generated sim crate.

**Trigger B — external oracle accounts needing byte-construction.** The
program reads price or attestation bytes from an account owned by an external
program (Pyth receiver, Switchboard, a custom attestor), and the stress axis
is that account's contents, so the sim must construct and mutate those bytes
deterministically. Detect: external SDK account types in the handler (for
example `pyth_solana_receiver_sdk::price_update::PriceUpdateV2`), calls like
`get_price_no_older_than`, or freshness windows checked against the clock.
Worked example: a protocol's liquidation reads a Pyth `PriceUpdateV2`, so the sim
builds the account bytes and crashes the price; a protocol's withdrawal checks a
NAV-attestation account inside a freshness window.

**Trigger C — third-party / target-vs-agent actions.** An actor signs an
instruction that operates on another actor's position or order — liquidator,
keeper, matcher, settler. A self-signed persona action only expresses an agent
acting on its own accounts. Detect: instruction account sets that contain
both a signer and a different user's position/order PDA — `liquidate`,
`settle`, `slash`, keeper cranks. Worked example: a protocol's liquidation lets
any third party repay a borrower's debt and seize collateral; a protocol's keeper
settles a buyer and a seller it does not own.

**Trigger D — multi-instruction sequences.** A flow only completes across an
ordered multi-instruction transaction or a multi-transaction sequence
(request, then execute, then claim). Detect: request/execute instruction
pairs, pending-state accounts, or instruction-introspection requirements such
as a required ed25519 verification instruction. Worked example: a protocol's
withdrawal is a multi-transaction sequence whose execute step must land
inside the attestation window; a protocol requires an ed25519 signature
verification instruction ahead of the consuming instruction in the same
transaction.

**Trigger E — dynamic `remaining_accounts`.** The instruction's account set
varies per call with protocol state, so no static account mapping exists.
Detect: `ctx.remaining_accounts` in handlers, or loops over member/position
lists. Worked example: a protocol's slash redistribution iterates every remaining
member's account; a protocol passes a dependency-program account set that changes per call.

**Trigger F — custom CPI bootstrapping.** Reaching a runnable tick-0 state
needs CPIs into external programs, or manual deployment and configuration of
sibling programs. Detect: init handlers that CPI into a dependency program,
multi-program genesis in `Anchor.toml` test config, or registration steps in
the test suite. Worked example: a protocol must bootstrap its dependency programs
and register its signature oracle before any flow can run.

### Verdict

- **No trigger on any P0/P1 flow → `baseline-sim`.** The guided sim is
  low-touch: primitive arguments, self-signed instructions, no externally
  owned account bytes to evolve mid-run. Confirm by running, not reading: a
  one-seed smoke through riptide-config. Borderline calls — a keeper-reward
  liquidation that might still be self-service, or a mock oracle passed as a
  primitive argument that a real deployment would replace with an oracle
  account — flip on real evidence, so record the fragility in the
  classification note.
- **One or more triggers on a P0 flow → `guided-sim-authored`** for those
  flows: the sim must hand-author the patterns the triggers named.
  Trigger-free flows stay low-touch within the same sim crate.
- **FHE/MPC/ZK, external-venue execution, or off-chain matching the sim
  cannot model → `unsupported`** for those surfaces. Name them as scope
  boundaries instead of silently skipping them.

### Classification note

Record the result in this shape and carry it into the final report:

```text
program: <name>
archetype: <amm | lending | perps | lst | stablecoin | irs | nav-vault | orderbook | other>
triggers: <none | subset of A-F, with one line of evidence each>
authoring patterns: <per trigger — A typed-argument builders; B oracle-account
  construction; C third-party-actor dispatch; D multi-instruction flow;
  E dynamic account resolution; F bootstrap services>
verdict: <baseline-sim | guided-sim-authored | unsupported>
```

The archetype refines the Step 1 family. Cues beyond the defaults table:
`irs` — fixed/floating legs, a settle period, a rate oracle; `nav-vault` —
deposits and withdrawals priced against an attested NAV with a manager or
attestor authority; `orderbook` — place/cancel/match orders with keeper
settlement.

When any trigger fires (verdict `guided-sim-authored`), read
`references/worst-case-playbook.md` (relative to this skill) for the
archetype's worst case to hunt, the axis to sweep, and the invariant or
metric that decides it, before asking any scoping question.

## Step 3: Scope

Ask no more than three questions total. Ask them one at a time and wait for
the answer before asking the next. Do not ask for information already visible
in source, IDL, tests, or `.riptide` files.

Question shape:

1. **Primary risk objective.** Derive two to four options from the detected
   family and actual program surfaces. Recommend the archetype default unless
   source evidence points elsewhere.
2. **Flow emphasis.** Offer stress-flow families or program-specific flows
   that match actual instructions, accounts, or observations. Include one
   "balanced default" option when multiple surfaces matter.
3. **Missing assumption.** Ask only when a material fact is not derivable, such
   as oracle account layout, authority policy, dependency fixture source,
   intended fee cap, or accepted scope exclusion.

After each answer, update the working Risk Plan:

- detected family and semantic class;
- guided-sim authoring needs: triggers present and verdict;
- P0 and P1 flows;
- risk objective;
- selected flow families;
- persona mix;
- invariants or metrics to check;
- assumptions and out-of-scope surfaces;
- evidence profile (`calibration`, `ci-regression`, `pre-audit`,
  `mainnet-scale`, or `overnight-search`).

If the user says "use defaults", proceed with the table defaults narrowed to
the program. Still show the defaults you chose before running.

## Step 4: Author

Delegate setup to `riptide-config` in the same session:

1. Load `skills/riptide-config/SKILL.md`.
2. Pass the detected family, semantic class, classification note (archetype,
   triggers, verdict), Risk Plan, selected flow families, persona mix,
   invariants, and assumptions into that contract. The triggers tell
   riptide-config which authoring seam carries each flow: Trigger B lands in
   deterministic oracle-account bytes (generated setup seams or sim services),
   Triggers A, C, D, and E land in hand-authored guided-sim flows, and Trigger
   F lands in `Riptide.toml` program/account declarations plus bootstrap
   services.
3. Let `riptide-config` own adapter, guided-sim setup, flow, sweep, and
   invariant creation or repair. Preserve existing user-authored `.riptide`
   files unless validation proves a concrete change is required.
4. Keep calibration first: adapter validation, the generated sim crate
   building, and a one-seed smoke must pass before the full sweep runs.
5. If `riptide-config` reports `blocked` or `unsupported`, stop the assessment
   run and report the exact blocker, failing command, and smallest missing
   fact. Do not paper over it with a hand-written report.

The expected authoring output is the generated guided-sim crate under
`.riptide/sim` — the adapter, a `Riptide.toml` carrying the `[sim.sweep]`
block, and hand-authored `src/flows.rs` — produced via `riptide-config`. There
is no Campaign TOML. Use the exact `.riptide/sim` paths that `riptide-config`
produced; do not invent or rename them after validation.

## Authoring Patterns (Guided Sim)

When triggers fire (verdict `guided-sim-authored`), the sim crate under
`.riptide/sim/` is hand-authored, but the hard-won parts are already library
code. Wire these instead of re-deriving them; each pattern maps back to the
trigger that called for it.

### Oracle-account construction (trigger B)

Use `riptide_sim::oracle::PythPriceUpdate` to construct the Pyth
`PriceUpdateV2` account a program's `get_price_no_older_than(...)` reads. The
builder owns the full 134-byte layout (Anchor discriminator, verification
level, feed_id, price/conf/exponent, freshness fields) verified against
`pyth-solana-receiver-sdk`, so never hand-roll those bytes:

```rust
use riptide_sim::oracle::{crash_in_place, PythPriceUpdate};

let mut update = PythPriceUpdate::new(FEED_ID, INITIAL_PRICE, -8, base_ts);
update.install(&mut sim.world, price_update_key)?;
// Later, mid-lifecycle: the crash (the swept stress), re-stamped fresh so the
// program's freshness window is isolated from the price move.
crash_in_place(&mut sim.world, &price_update_key, crashed_price, now)?;
```

Set `write_authority`, `conf`, or other fields on the struct before
`install` when the target program checks them. For non-Pyth attestors
(custom NAV attestations, Switchboard), follow the same shape — a
deterministic byte builder in your sim's `services/`, with a `set`/`crash`
mutator — rather than scattering offsets through flows.

### Third-party-actor dispatch (trigger C)

Use `riptide_sim::dispatch::ThirdPartyDispatch` for any instruction where one
actor signs and operates on another actor's position or order (liquidator,
keeper, matcher, settler). Push accounts in the program's IDL order with the
role methods; `build()` rejects the three recurring hand-roll bugs (target
marked signer, actor never signing, a stray third signer):

```rust
use riptide_sim::dispatch::ThirdPartyDispatch;

let mut dispatch = ThirdPartyDispatch::new(liquidator, position_owner);
dispatch
    .shared(protocol_state, false)
    .target_account(position_pda, true)   // owner's position; never signs
    .actor_account(liquidator_ata, true)  // receives seized collateral
    .actor_signer(true);                  // the sole signer
let (metas, signer) = dispatch.build_with_signer()?;
```

### The sweep + control + invariant scaffold

A guided sim destined for a risk-surface assessment declares four blocks in
`.riptide/sim/Riptide.toml`:

```toml
[sim.sweep]                      # the exogenous stress axis
name = "collateral_price_drop_bps"
values = [0, 1000, 2000, 3000, 4000, 5000, 6000]
seeds_per_value = 4

[sim.positive_control]           # the known-correct baseline coordinate
value = 0                        # parameter defaults to the sweep name

[sim.lifecycle]                  # core flows that must execute on-chain
required_flows = ["create_lend_offer", "accept_lend_offer", "liquidate_loan"]

[sim.cartography]                # surface metadata
class = "lending.v1"
risk_objective = "<one-sentence risk objective with scope boundaries>"
```

In `flows.rs`, read the swept coordinate with
`world.sweep_value("<axis>")` and echo it back with
`world.record_parameter`. Record the deciding signal with
`world.record_metric` and fire the deciding invariant with
`world.record_invariant_fire` when the metric crosses the stated risk line —
the playbook entry for the archetype names the metric, the trap to avoid,
and the line. Author negative controls (a healthy-state action that must
reject) with the transaction builder's `expect_error()`, so a rejection is
asserted rather than silently tolerated.

### The guided evidence pipeline

```bash
riptide sim run .riptide/sim --out <artifact-dir>   # reads [sim.sweep]; warns on failing gates
riptide sim surface <artifact-dir> --sim .riptide/sim --out <assess-root>
riptide assess <assess-root>                        # blocks on any failed gate
```

`sim run` executes one iteration per (value, seed replicate) and records each
coordinate; `sim surface` builds the cartography artifacts and records the
execution-honesty gate report into the guided-sim campaign summary;
`riptide assess` re-verifies the gates and refuses to emit while any gate
fails.

## Honesty Discipline (Non-Negotiable)

Riptide has no automatic oracle for "is this finding real and honestly
framed", so the report's credibility rests on these rules. The runtime
enforces the first three as execution-honesty gates — evaluated at
`riptide sim surface`, warned at `riptide sim run`, and **blocking** at
`riptide assess` — and the rest are framing rules the gates cannot check, so
following them is on you.

1. **Positive control.** Every sweep declares a coordinate whose outcome is
   known-correct (`[sim.positive_control]`, usually axis value `0`: no shock,
   fresh-and-true attestation paying exact pro-rata) and that coordinate must
   pass. Without it a flat surface is unfalsifiable. *Enforced: the
   `positive_control` gate blocks emit when the declaration is missing, the
   coordinate never ran, or it fired an invariant.*
2. **Real-program execution — never mock.** Flows execute the target
   program's real `.so`. Constructed external-account bytes (oracle prices,
   attestations) are the stress input, not a mock of the target; the target
   program itself is never stubbed or reimplemented. A flat result is only
   robustness if the intended lifecycle actually ran on-chain. *Enforced:
   the `lifecycle_executed` gate blocks emit when declared
   `[sim.lifecycle] required_flows` never executed successfully — "no-op,
   not robustness".*
3. **Determinism.** Fixed seeds, fixed amounts, no wall clock, no network.
   The same command must reproduce the same bytes. *Enforced: the
   `determinism` gate re-hashes `risk-surface.json` at emit against the hash
   recorded at surface time, and `riptide assess` refuses to overwrite an
   existing `assessment.json`/`assessment.md` that does not match the freshly
   rendered bytes.*
4. **Scope and boundary framing.** The result is evidence over the declared
   region — one configuration, the swept axis, the listed flows — not a
   safety statement. Name what was held fixed, what was out of scope (e.g.
   an oracle's own staleness guards when you drive the price directly, an
   external reserve that is inert in stub mode), and say "evidence over the
   declared region", never "safe".
5. **Robustness is a valid result — never manufacture a finding.** A flat
   surface with the positive control passing and the lifecycle executed is a
   real, publishable robustness result. State the structural reason the
   guard holds rather than asserting safety, and do not tighten thresholds
   or distort scenarios until something fires.
6. **The fire-threshold is a stated risk line; the gradient is the signal.**
   The invariant's threshold (1% of reserve, 1% of debt value) is a chosen
   reporting line, not a discovered boundary. Report where the metric starts
   moving and where it crosses the line — both are surface facts.
7. **Exogenous-axis cover-framing.** The swept axis is an exogenous stress
   (a market crash, a markdown), not a protocol knob. The auto-generated
   finding title and any "keep `<axis>` in {…}" safe-region line must be
   reframed in your delivery as "the onset sits at X on the axis" — a fact
   about where the risk begins, never a tuning instruction to the protocol
   team. No gate can check this; it is a delivery-step rule.

## Step 5: Run

Run the validated guided sim deterministically, repair setup failures
in-loop, then build the cartography surface and generate the assessment from
the resulting guided-sim root.

Validate the sim manifest, then run the guided sim with the exact options
required by the authored setup:

```bash
riptide sim lint .riptide/sim
riptide sim run .riptide/sim --out <artifact-dir>
```

`riptide sim run` reads the `[sim.sweep]` block in `.riptide/sim/Riptide.toml`
and runs one iteration per (value, seed replicate); there is no `--sweep` CLI
flag. Allowed `sim run` options verified in the current CLI are
`--iterations <n>`, `--flows <n>`, `--seed <hex>`, and `--out <dir>`. Use them
only when the setup or evidence plan requires them, and preserve the exact
command for delivery.

Classify failures carefully:

- Setup errors are repair-loop inputs. Return to `riptide-config`'s adapter or
  guided-sim stage, fix the responsible layer, and rerun from the earliest
  affected validation gate.
- Invariant failures are evidence, not setup failure. The run artifacts are
  still reviewable; continue to surface, review, and assessment generation.
- If a flow needs guided Rust logic the current sim crate does not yet author,
  return to `riptide-config`'s Guided Sim Stage, write the flow in
  `.riptide/sim/src/flows.rs`, and keep the remaining coverage bounded.

For guided-sim evidence destined for a risk-surface heatmap, declare the
`[sim.sweep]`, `[sim.positive_control]`, and `[sim.lifecycle]` blocks in
`.riptide/sim/Riptide.toml` (see the authoring patterns above), then run the
guided pipeline:

```bash
riptide sim run .riptide/sim --out <artifact-dir>
riptide sim surface <artifact-dir> --sim .riptide/sim
riptide assess <assess-root printed by sim surface>
```

`riptide sim surface` builds the cartography artifacts (campaign summary,
risk surface, retention manifest) from the sweep so `riptide assess` renders
the heatmap; without a sweep, guided-sim evidence flows through
`riptide sim review` and the correctness assessment shape instead.

A blocked `riptide assess` that names a failed execution-honesty gate is a
setup repair, not evidence: declare or fix the positive control, make the
required lifecycle flows actually execute, or restore determinism, then
re-run `riptide sim run` + `riptide sim surface` and assess again. Do not
work around a blocked gate with a hand-written report.

Review the guided-sim root printed by `riptide sim surface`:

```bash
riptide review <guided-sim-root>
```

Generate the assessment from that existing root:

```bash
riptide assess <guided-sim-root>
```

Do not stop at the bare invocation above. Before the final assessment, author
the editorial input layer in Step 6 and pass it with
`--input .riptide/assessment-input.json`; the standard final invocation shape
lives in Step 7. Use `--html` or `--pdf` for the full assessment only when the
user asks for presentation exports — the one-page brief (`--brief`) is a
standard deliverable, not an on-request export. Default assessment evidence is
`assessment.json` plus byte-deterministic `assessment.md`.

## Step 6: Author The Assessment Inputs

Before generating the final assessment, write a repo-local
`.riptide/assessment-input.json` — an `AssessmentInputs` object that
`riptide assess --input` folds over the cartography-derived defaults. The
classify, scope, and author steps already produced the protocol knowledge this
file needs; writing it down deterministically is what turns the generic
templated defaults into an assessment that names the protocol's actual
flows, figures, and boundaries. Skipping this step ships the generic layer.

Cover at minimum `verdict`, `riskPlan.target_claim`,
`riskPlan.guided_sim_boundaries`, and explicit `coverage[]` rows:

- `verdict` — the declared send-readiness call (for example
  `"ready_to_send"`), validated against the CLI's accepted verdict values.
- `riskPlan.target_claim` — one paragraph stating the honest claim: lead with
  what held, name the finding, state the onset on the swept axis as a fact
  about where the risk begins, and name the load-bearing design nuance the
  result rests on.
- `riskPlan.guided_sim_boundaries` — what was driven deterministically and is
  therefore out of scope (for example "the Pyth price is driven
  deterministically; Pyth's own staleness/confidence guards are out of
  scope"), what held in every run so the report makes no false claim, and the
  configuration limits ("single loan configuration, one axis, worst-case
  timing — not a mainnet prediction").
- `coverage[]` — one row per P0 flow turning it into explicit evidence:
  `priority`, `flow`, `status`, `evidence_tier`, `commands`, `artifacts`, and
  `notes` stating HELD or FINDING facts. `status` must be one of the CLI's
  accepted coverage statuses (for example `covered`, `covered by guided sim`,
  `blocked`, `out of scope`, `not assessed`); inspect the local command
  source or help if unsure.

Also fill the remaining `riskPlan` fields when you have them — recommended:
`protocol_class`, `evidence_profile`, `p0_flows`, `expected_failure_modes`,
and `known_coverage_limits`.

The honesty discipline applies to every line. Each statement in the input must
be backed by what actually ran — the surface, the sim run, the negative
controls. The input adds protocol nouns and figures the generic default cannot
know; it never invents new findings. The exogenous-axis cover-framing rule in
the honesty discipline above governs the wording of the claim and any onset
line.

Follow the shape of the worked examples:

- `case-studies/anemone/.riptide/assessment-input.json`
- `case-studies/agio/program/.riptide/assessment-input.json`

Both carry a top-level `verdict`, a `riskPlan` (protocol_class, target_claim,
evidence_profile, p0_flows, expected_failure_modes, guided_sim_boundaries,
known_coverage_limits), and explicit `coverage[]` rows.

Do not run a separate assess pass for this file: it is consumed by the final
`--brief --input` invocation in the Deliver step below.

## Step 7: Deliver

Generate the final assessment with the authored inputs and the executive
brief — this is the standard invocation, not an on-request variant:

```bash
riptide assess <campaign-root> --brief --input .riptide/assessment-input.json
```

Read the generated `assessment.md`, `assessment.json`, campaign summary, and
retention manifest before responding. The final response must be short but
complete:

- Assessment report path: `<campaign-root>/assessment.md`.
- Machine artifact path: `<campaign-root>/assessment.json`.
- Executive brief paths: `<campaign-root>/brief.html` and
  `<campaign-root>/brief.pdf` — the one-page executive brief (What we did /
  What we found / What to do / Scope & limits / Reproduce), rendered from the
  assessment model. The brief is the digestible artifact to send a protocol
  team, with the full `assessment.md` as the technical companion. `brief.pdf`
  requires a local headless Chromium; the CLI skips it with a notice
  otherwise.
- Evidence-pack pointer: campaign root, `campaign-summary.md`,
  `retention-manifest.json`, `retained/`, and any retained `rerun.sh` scripts.
- Exact guided-sim rerun commands: the precise `riptide sim run ...` and
  `riptide sim surface ...` commands you executed, including any
  `--iterations`, `--flows`, `--seed`, or `--out` options used.
- Exact assessment rerun command: the precise `riptide assess ...` command
  needed to regenerate the report.
- Visible choices: detected family, semantic class, execution-path
  classification (archetype, triggers, verdict), risk objective, selected
  scenarios, persona mix, invariants or metrics checked, and assumptions.
- Confidence and coverage pointers: after reading the generated
  `assessment.md`, cite the exact section headings it contains for coverage
  boundaries and reproduction details. In the current assessment output, expect
  sections such as `Coverage Matrix`, `Blocked and out-of-scope surfaces`, and
  `Reproduction Commands`; do not invent headings. Also point to the campaign
  summary coverage/confidence line when present.
- Boundary: state that the result covers declared simulation inputs and
  evidence only.
- For guided-sim assessments: the execution-honesty gate results (positive
  control, lifecycle executed, determinism) as printed by `riptide assess`,
  and the worst-case framing from the honesty discipline — the swept axis
  named as an exogenous stress with the onset stated as a surface fact, the
  fire-threshold named as the stated risk line, and a held invariant framed
  as a robustness result with its structural reason.

If no assessment was generated, do not pretend otherwise. Deliver the blocked
state with the exact failed command, the exact error summary, what you repaired,
and the smallest user or protocol-team input needed to continue.

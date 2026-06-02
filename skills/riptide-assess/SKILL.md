---
name: riptide-assess
description: >-
  One front door for Riptide protocol assessments. Use when the user says
  "riptide-assess", "assess my protocol", "is my protocol safe", "run Riptide
  on this", "give me a risk assessment", or wants one agent-led flow from a
  Solana program repo to an assessment report. This skill detects the protocol
  family, asks up to three scoped questions, delegates setup to riptide-config,
  runs the existing campaign and assess commands, and returns simulation
  evidence with exact rerun commands. For deeper adapter, harness, scenario, or
  campaign authoring without a final assessment, use riptide-config instead.
metadata:
  short-description: Run one Riptide assessment front door
---

# riptide-assess

You are the assessment practitioner. The user should point you at a Solana
program repo, answer at most three questions, and receive a generated
assessment report. The user does not author adapter, harness, persona,
scenario, invariant, or campaign files by hand.

This skill is an orchestration wrapper over existing Riptide machinery. It
does not replace `riptide-config`, and it does not introduce new engine or CLI
behavior.

## Contract

- Work in one continuous session: detect, scope, author, run, and deliver.
- Load and follow `skills/riptide-config/SKILL.md` for adapter, harness,
  persona, scenario, invariant, and campaign creation or repair. Do not
  reimplement that authoring contract inside this skill.
- Use existing CLI surfaces only. If command drift is possible, inspect the
  local command source or help before citing a flag.
- Keep the agent's choices visible: detected family, semantic class, risk
  objective, selected scenario families, persona mix, invariants or metrics,
  confidence, and assumptions.
- Preserve rerunnability: every completed assessment response must include the
  exact campaign rerun command that produced the assessed root, the exact
  `riptide assess ...` command, and the evidence-pack pointer.
- Preserve the trust boundary: the result is simulation evidence over declared
  inputs, not audit signoff or complete protocol safety.

If the user only asks to configure Riptide, finish an adapter, repair a
harness, or prepare campaign readiness without asking for the assessment
report, use `riptide-config` instead.

## Protocol-Archetype Defaults

Use this table as the starting risk pack. The final choices must be narrowed to
the target program's actual instructions, accounts, IDL, tests, and existing
`.riptide` files.

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
   - `.riptide/scenarios/**/run-config.json` and any existing campaign TOML.
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

## Step 2: Scope

Ask no more than three questions total. Ask them one at a time and wait for
the answer before asking the next. Do not ask for information already visible
in source, IDL, tests, or `.riptide` files.

Question shape:

1. **Primary risk objective.** Derive two to four options from the detected
   family and actual program surfaces. Recommend the archetype default unless
   source evidence points elsewhere.
2. **Scenario emphasis.** Offer scenario families or program-specific flows
   that match actual instructions, accounts, or observations. Include one
   "balanced default" option when multiple surfaces matter.
3. **Missing assumption.** Ask only when a material fact is not derivable, such
   as oracle account layout, authority policy, dependency fixture source,
   intended fee cap, or accepted scope exclusion.

After each answer, update the working Risk Plan:

- detected family and semantic class;
- P0 and P1 flows;
- risk objective;
- selected scenario families;
- persona mix;
- invariants or metrics to check;
- assumptions and out-of-scope surfaces;
- evidence profile (`calibration`, `ci-regression`, `pre-audit`,
  `mainnet-scale`, or `overnight-search`).

If the user says "use defaults", proceed with the table defaults narrowed to
the program. Still show the defaults you chose before running.

## Step 3: Author

Delegate setup to `riptide-config` in the same session:

1. Load `skills/riptide-config/SKILL.md`.
2. Pass the detected family, semantic class, Risk Plan, selected scenario
   families, persona mix, invariants, and assumptions into that contract.
3. Let `riptide-config` own adapter, harness, scenario, invariant, and campaign
   creation or repair. Preserve existing user-authored `.riptide` files unless
   validation proves a concrete change is required.
4. Keep calibration first: adapter lint, harness build when needed, and a
   one-seed smoke must pass before broader campaign execution.
5. If `riptide-config` reports `blocked` or `unsupported`, stop the assessment
   run and report the exact blocker, failing command, and smallest missing
   fact. Do not paper over it with a hand-written report.

The expected authoring output is a repo-local Campaign TOML such as:

```text
.riptide/campaigns/<risk>.campaign.toml
```

Use the exact path that `riptide-config` produced. Do not invent a campaign
path or rename the campaign after validation.

## Step 4: Run

Run the validated campaign deterministically, repair setup failures in-loop,
then generate the assessment from the existing campaign root.

Validate and preview:

```bash
riptide campaign validate .riptide/campaigns/<risk>.campaign.toml
riptide campaign plan .riptide/campaigns/<risk>.campaign.toml --max-runs 4
```

Run the campaign with the exact options required by the authored setup:

```bash
riptide campaign run .riptide/campaigns/<risk>.campaign.toml
```

Allowed campaign-run options verified in the current CLI include
`--max-runs <n>`, `--out <dir>`, `--harness <path>`, and `--json`. Use them
only when the setup or evidence plan requires them, and preserve the exact
command for delivery.

Classify failures carefully:

- Setup errors are repair-loop inputs. Return to `riptide-config`'s adapter,
  harness, scenario, or campaign stage, fix the responsible layer, and rerun
  from the earliest affected validation gate.
- Invariant failures are evidence, not setup failure. Campaign artifacts are
  still reviewable; continue to review and assessment generation.
- If the protocol requires guided Rust flows, follow `riptide-config`'s guided
  evidence path and keep campaign coverage bounded. Do not describe
  `riptide campaign run` as scheduling guided sims unless the local CLI exposes
  that explicitly.

Review the campaign root printed by the run:

```bash
riptide review <campaign-root>
```

Generate the assessment from that existing root:

```bash
riptide assess <campaign-root>
```

Use `riptide assess <campaign-root> --input <json-file>` only when you wrote a
repo-local Risk Plan, coverage, or verdict input JSON that must override or
complete campaign-derived defaults. Use `--html` or `--pdf` only when the user
asks for presentation exports; default assessment evidence is
`assessment.json` plus byte-deterministic `assessment.md`.

## Step 5: Deliver

Read the generated `assessment.md`, `assessment.json`, campaign summary, and
retention manifest before responding. The final response must be short but
complete:

- Assessment report path: `<campaign-root>/assessment.md`.
- Machine artifact path: `<campaign-root>/assessment.json`.
- Evidence-pack pointer: campaign root, `campaign-summary.md`,
  `retention-manifest.json`, `retained/`, and any retained `rerun.sh` scripts.
- Exact campaign rerun command: the precise `riptide campaign run ...` command
  you executed, including any `--out`, `--max-runs`, `--harness`, or `--json`
  options used.
- Exact assessment rerun command: the precise `riptide assess ...` command
  needed to regenerate the report.
- Visible choices: detected family, semantic class, risk objective, selected
  scenarios, persona mix, invariants or metrics checked, and assumptions.
- Confidence and coverage pointers: after reading the generated
  `assessment.md`, cite the exact section headings it contains for coverage
  boundaries and reproduction details. In the current assessment output, expect
  sections such as `Coverage Matrix`, `Blocked and out-of-scope surfaces`, and
  `Reproduction Commands`; do not invent headings. Also point to the campaign
  summary coverage/confidence line when present.
- Boundary: state that the result covers declared simulation inputs and
  evidence only.

If no assessment was generated, do not pretend otherwise. Deliver the blocked
state with the exact failed command, the exact error summary, what you repaired,
and the smallest user or protocol-team input needed to continue.

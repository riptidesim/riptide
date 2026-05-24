---
name: riptide-config
description: >-
  Configure a Solana program repo for Riptide end to end after the thin
  default `riptide init` bootstrap.
  Use when the user says "riptide-config", "configure Riptide", "make this
  repo run in Riptide", "finish my adapter/harness/scenarios", or has a
  `.riptide/` scaffold that needs a working adapter, setup harness, starter
  scenarios, campaign readiness, validation, and a final readiness verdict. This
  merged skill owns the adapter, harness, scenario, repair, and campaign
  readiness loop.
metadata:
  short-description: Configure Riptide end to end
---

# riptide-config

This skill is the default configuration path after `riptide init`. Plain
init intentionally creates only a thin `.riptide/` bootstrap: adapter
placeholder, artifact path hints when available, and
`.riptide/GETTING-STARTED.md`. The same agent session owns adapter TOML,
Rust harness, personas, scenarios, invariants, campaign readiness,
validation, repair loops, and the final readiness report.
For protocol configuration work, the final report also carries a
protocol-assessment coverage matrix and send/readiness verdict that can
feed `docs/templates/protocol-assessment-report.md`.

There is no second LLM call, no endpoint config, and no API key. Use
normal shell commands and edit normal files.

## Contract

When invoked, do not ask for another prompt unless target detection is
genuinely ambiguous. Work until one final state is true:

- `campaign_ready = yes` — adapter lint passes, the harnessed one-seed
  smoke passes when a harness is required, starter scenarios validate,
  and the written Campaign TOML's stated surface is runnable and
  validated with exact run and review commands. The skill prepares
  campaign readiness; `riptide campaign run` remains a separate user
  command.
- `bounded_ready = yes` — a narrower campaign runs and is validated, but
  specific harness-solvable setup gaps, guided-sim required surfaces, or
  unsupported engine gaps keep the broader intended surface outside the
  current campaign.
- `blocked = <reason>` — local source, build artifacts, CLI validation,
  harness compile, or smoke output names a fixable blocker.
- `unsupported = <boundary>` — the program depends on a protocol
  surface Riptide cannot currently model without new engine support.

Configuration readiness and send readiness are separate. Keep reporting
the setup state above, then also report a protocol assessment verdict
using exactly one of: `ready_to_send`, `needs_guided_sim`,
`needs_campaign_tuning`, `blocked`, or `unsupported`.

Do not stop at "lint PASS" if `riptide run --harness` cannot load the
adapter. Do not hand adapter-side blockers to a separate harness skill.
Repair the adapter, harness, or scenarios yourself in this loop.

Own persona, scenario, invariant, and campaign creation by default when
the input is a thin init scaffold. Do not ask the user to manually fill
adapter TODOs before you begin unless target detection is genuinely
ambiguous. Do not leave required harness setup as comments when the
account bytes, PDA seeds, owners, or local service state are derivable
from source, IDL, tests, dependencies, constants, or existing fixtures.

## Risk Plan Inputs

When the user or Studio provides a confirmed Risk Plan and selected
profile, treat it as source-of-truth input for campaign shape, personas,
scenarios, guided-sim recommendations, runtime ceilings, artifact
ceilings, and evidence boundaries. Do not replace the confirmed plan with
raw agent/tick/seed knobs unless validation proves the plan impossible;
when that happens, report the exact blocker and ask for the smallest
scope decision needed.

Use product-facing profiles before raw knobs:

- `calibration` — prove setup works with the smallest meaningful slice:
  lint, harness build when needed, one deterministic seed, short run,
  exact blocker capture, and no broad campaign execution.
- `ci-regression` — cheap repeatable safety gate: deterministic seeds,
  modest agents, strong invariants, low artifacts, and commands suitable
  for a recurring local or CI check after calibration passes.
- `pre-audit` — stronger economic stress: multiple scenario families,
  stricter invariants, medium/high agents, retained failures/outliers,
  and human-readable review commands.
- `mainnet-scale` — incident rehearsal: use 1000+ agents for main stress
  scenarios when runtime and artifact budgets allow, keep outliers, and
  state any reduced-size fallback as a budget cut.
- `overnight-search` — broad exploration: wider seeds/parameters,
  explicit artifact cap, retained failures/outliers, and a next-day
  review path instead of interactive tuning.

Keep calibration first even when the confirmed profile is larger:
adapter lint, harness build when required, and one deterministic smoke
must prove the setup before campaign expansion. Preserve
guided-sim required surfaces as coverage boundaries instead of forcing
dynamic flows into generic adapter campaigns.

When the Risk Plan names P0/P1 economic flows, carry them into a final
coverage matrix. Every P0 flow must be classified as `covered`,
`covered by guided sim`, `blocked`, `out of scope`, or `not assessed`;
P1 flows named in the plan should be classified the same way when the
configuration report discusses them.

## Detection

1. Establish the repo root from `.riptide/`, `Anchor.toml`,
   `Cargo.toml`, `target/idl`, or the current directory.
2. Locate:
   - `.riptide/adapters/*.toml`
   - `target/idl/*.json`, `app/src/idl/*.json`, or adapter `idl_path`
   - `target/deploy/*.so` or adapter `program_so`
   - source/tests that prove account sizes, PDA seeds, SPL token setup,
     oracle accounts, and bootstrap order
   - `.riptide/harness/`, if already present
   - `.riptide/scenarios/**/run-config.json`
3. If `.riptide/` is missing, run `riptide init` only when the program
   name/profile are unambiguous; otherwise return
   `blocked = run riptide init first`.

Prefer editing the scaffolded adapter in place. Preserve user-authored
`.riptide` files when present.

## Thin Init And Wizard Choices

Treat a thin default `riptide init` scaffold as normal input, not as an
incomplete user task. In the thin path, you are expected to create or
repair the adapter, inline personas, scenario run-configs, invariants,
harness, and campaign TOML yourself.

When the user explicitly ran `riptide init --wizard`, treat those
questionnaire answers as source-of-truth inputs, not disposable
scaffolding:

- Preserve selected personas in the adapter unless source facts prove a
  persona cannot execute against the adapter. If you remove or rename one,
  explain the reason in the final report.
- Preserve selected scenarios and existing `.riptide/scenarios/**/run-config.json`
  values for `agents`, `ticks`, `seed`, `seeds`, `scenario`, and `personas`
  unless a bounded run proves the value is invalid. If you change one,
  show a before/after diff in the final report.
- Scenario catalog defaults are allowed to be scenario-specific. For
  example, a baseline scenario may use the init population while a stress
  scenario may intentionally use a smaller persona mix. Do not describe
  those as skill overwrites; report them as existing scenario settings.
- Use `--seeds 1 --seed-root 1337` only for bounded smoke gates. Do not
  rewrite the scenario's stored `seeds` value just because the smoke used
  a one-seed override.

When both wizard choices and a confirmed Risk Plan are present, preserve
both unless they conflict. If they conflict, the confirmed Risk Plan is
the newer source-of-truth for evidence profile, campaign shape, runtime
ceiling, artifact ceiling, and guided-sim recommendations; record any
changed wizard sizing in the final report.

For any existing user-authored `.riptide` file, preserve the user's
content unless validation proves it is invalid. If you change an existing
persona, scenario, invariant, harness setup, or campaign, report the
change and the validation reason.

## Adapter Stage

Fill or repair the adapter before touching scenarios.

- If `program_so` and `idl_path` are both set, the runtime is Generic
  SBF/IDL even when `protocol = "lending"` remains as a tooling hint.
- Generic top-level `[[invariants]]` may reference only keys declared
  in `[observations]`. Remove bundled-lending snapshot metrics such as
  `active_agents`, `utilization`, `cumulative_bad_debt`,
  `cumulative_liquidations`, `oracle_price`, and `tick` unless the
  adapter explicitly declares them as observations.
- For mapped IDL instructions, every required IDL account must be
  represented by `[accounts.<name>]`, a recognized signer alias
  (`authority`, `owner`, `user`, `payer`, etc.), a well-known
  program/sysvar alias, or an IDL literal `address`.
- Do not omit setup-heavy accounts just because the harness will fill
  bytes later. Declare bindings for accounts like `price_update_v2`,
  `receipt_mint`, reserve vault/token accounts, and per-agent token
  accounts.
- `[[scheduled_actions]].accounts` must name declared `[accounts.*]`
  entries.
- Adapter TOML declares account shape, instruction mappings, actions,
  observations, personas, invariants, semantics, oracle channels, and
  lineage. Harness Rust creates concrete pre-tick-0 bytes.
- Always include `[lineage]` with the IDL source, assumptions, and
  unsupported surfaces.

Validate after every adapter repair:

```bash
riptide lint .riptide/adapters/<program>.toml
```

If lint fails, fix the named adapter field before moving on. If lint
passes but later engine load fails on missing account bindings, repair
the adapter and rerun lint.

## Harness Stage

Use a harness whenever the generic program needs concrete account
bytes, PDAs, SPL mints/vaults, external-owned accounts, or bootstrap
CPIs before tick 0.

If `.riptide/harness/Cargo.toml` does not exist, generate the scaffold:

```bash
riptide harness generate --adapter .riptide/adapters/<program>.toml
```

Then edit `.riptide/harness/src/main.rs`. Preserve existing user code.
Use `riptide_engine::harness` helpers for:

- `ctx.require_declared_account`
- `ctx.bind_shared_account` and `ctx.bind_agent_accounts`
- `ctx.set_raw_account`, `ctx.set_shared_account_data`, and
  `ctx.set_agent_account_data`
- `ctx.derive_pda`
- `ctx.spl_mint`, `ctx.spl_token_account`,
  `ctx.agent_spl_token_account`
- `ctx.load_program_from_so`

Keep setup deterministic: fixed amounts, fixed decimals, fixed seeds,
no network calls. A generated harness may build before it is completed,
but a TODO-only harness is not acceptable when setup-heavy accounts are
required and derivable. Before declaring a blocker, inspect source,
tests, IDL, dependency types, constants, and local fixtures for account
owners, discriminators, sizes, PDA seeds, feed IDs, and serialization.

For external-owned accounts such as oracle receiver accounts, keep the
adapter/harness deterministic: use local account bytes, checked-in
snapshots, or guided-sim fork cache entries. Do not ask Riptide core to
learn Pyth, Switchboard, or other protocol-specific layouts. If the
exact layout, owner, feed ID, or serialization cannot be determined from
local facts or an explicit `.riptide/sim/Riptide.toml` snapshot, return
`blocked = missing deterministic <fact> for harness/guided-sim setup`
and name the account/instruction. Do not hide that state behind a vague
TODO comment.

Harness setup owns pre-tick-0 accounts and sibling programs. Dynamic
protocol behaviour lives in `.riptide/sim/`: use guided sim when the
flow needs dynamic `remaining_accounts`, multi-ix transactions,
target-vs-agent dispatch, or project-local service models.

Validate in this order:

```bash
cargo build --release --quiet --manifest-path .riptide/harness/Cargo.toml
riptide run baseline --adapter .riptide/adapters/<program>.toml --harness .riptide/harness --seeds 1 --seed-root 1337
```

Use the scaffolded scenario name if `baseline` does not exist. Inspect
the produced `simulation-result.json` or sweep cell output. Confirm it
is non-empty, mapped observations are present, expected write actions
are not all setup failures, and the rerun command is retained.

Do not generate broader scenarios until this smoke passes.

## Guided Sim Stage

Use a guided Rust simulation whenever the protocol cannot be represented
as static adapter dispatch plus pre-tick-0 harness setup. Guided sim is
required when the protocol needs dynamic `remaining_accounts`, multi-ix
transactions, target-vs-agent action selection, unsupported custom
argument assembly, or project-local oracle/orderbook/stake service
models.

Generate the project-owned simulation crate:

```bash
riptide sim generate --adapter .riptide/adapters/<program>.toml
```

Then fill `.riptide/sim/Riptide.toml` and `.riptide/sim/src/flows.rs`
from local source, IDL, tests, and fixtures. Use `Riptide.toml` for
Trident-class external dependencies when the project owns the config and
Rust behavior. This is manual guided support, not automatic universal
fuzzing or audit signoff.

```toml
[[sim.programs]]
address = "<program-id>"
program = "../target/deploy/dependency.so"

[[sim.accounts]]
address = "<account-pubkey>"
filename = "fixtures/accounts/dependency-account.json"

[[sim.fork]]
address = "<mainnet-account-pubkey>"
cluster = "mainnet"
filename = "fork-cache/mainnet/dependency-account.json"
overwrite = false
```

Keep generated `types.rs` and `accounts.rs` regenerated-only; put
hand-authored protocol actions, dynamic account resolution, and service
models under `flows.rs`, `invariants.rs`, and `services/`.

Do not add Pyth, Switchboard, OpenBook, Drift, Mango, Marinade,
Whirlpool, or other protocol-specific layouts to Riptide core. If the
protocol needs those account bytes to evolve during a run, declare the
external programs/accounts/forked snapshots generically in
`Riptide.toml`, then model the protocol-specific mutation in
project-owned services.

Validate the guided-sim loop before continuing to scenario or campaign
work:

```bash
riptide sim lint .riptide/sim
riptide sim run .riptide/sim --iterations 5 --flows 20 --seed 1337 --out .riptide/sim/artifacts/smoke
riptide sim review .riptide/sim/artifacts/smoke
```

`riptide review .riptide/sim/artifacts/smoke` is equivalent when you want
the root reviewer command. The review reads `guided-sim-run.json`,
validates `rerun.sh` when present, and reports the retained failing
seed, flow table, labelled transaction outcomes, failure reason, and
rerun command. It does not run the sim again.

After IDL changes, refresh generated builders without overwriting user
flows:

```bash
riptide sim refresh --adapter .riptide/adapters/<program>.toml --dir .riptide/sim
```

## Scenario Stage

After the smoke passes, write or repair user-repo scenarios under:

```text
.riptide/scenarios/<slug>/run-config.json
```

Do not write fixture `manifest.json`, `policies.json`, or
`.riptide/personas/` in user repos. Generic personas stay inline in the
adapter. Scenario `personas` should either be a count map keyed by
inline persona IDs or an empty array when the adapter roster should
round-robin.

Before writing a scenario file, read the existing run-config and preserve
its user-chosen sizing and persona mix. Add new scenarios only when the
selected scaffold does not already cover the failure mode. Repair in
place only for concrete validation failures, path mistakes, or adapter
renames.

Propose 3-5 experiments only when the adapter surface justifies them.
Tie each scenario to a concrete action, observation, semantic role,
oracle path, or invariant. Avoid generic proposals that would be the
same for every program.

Validate each new scenario with a bounded run:

```bash
riptide run <slug> --adapter .riptide/adapters/<program>.toml --harness .riptide/harness --seeds 1 --seed-root 1337
```

Omit `--harness` only when the adapter is proven to boot without setup.

## Campaign Stage

Create or repair one starter Campaign TOML under:

```text
.riptide/campaigns/<risk>.campaign.toml
```

Point it at repo-local adapter and scenario paths. Shape campaign size
from the confirmed Risk Plan/profile when present. Keep `calibration`
as the first executed slice, then prepare the main evidence campaign:
cheap deterministic coverage for `ci-regression`, stronger economic
stress for `pre-audit`, 1000+ agents in main stress scenarios for
`mainnet-scale` when budget allows, and broader seed/parameter search
with an artifact cap for `overnight-search`.

Keep the first campaign small enough to run quickly, with fixed seed
policy and retained rerun cases, unless the confirmed profile explicitly
asks for a larger prepared campaign. Planning a large campaign is allowed
after calibration, but broad execution remains a separate user-approved
command.

Validate and plan it:

```bash
riptide campaign validate .riptide/campaigns/<risk>.campaign.toml
riptide campaign plan .riptide/campaigns/<risk>.campaign.toml --max-runs 4
```

Only report `campaign_ready = yes` after campaign validation succeeds,
the scenario smoke outputs are meaningful, and required harness setup is
implemented rather than comment-only. Use `bounded_ready = yes` when the
validated campaign is intentionally narrower than the protocol surface
because a specific remaining blocker is outside this pass.

Campaigns remain adapter/scenario campaigns. Do not report that
`riptide campaign run` schedules guided Rust sims unless the CLI exposes
an explicit guided-sim scheduling command. If the project needs guided
flows today, keep the campaign report bounded and include the exact
`riptide sim run --out ...` and `riptide sim review ...` commands as the
separate guided evidence path.

## Repair Loop

After every failure, classify it and repair the responsible layer:

- `skill prompt gap` — your generated adapter/harness/scenario omitted
  a fact already visible in source/tests.
- `CLI validation gap` — `riptide lint` passed but a later loader error
  was statically knowable. Record the gap in the final report.
- `harness source fact gap` — setup needs account bytes, owners, PDA
  seeds, feed IDs, or serialization facts that are not derivable from
  local source/tests/IDL/dependencies.
- `harness API/tooling gap` — setup code cannot express required bytes,
  account binding, sibling program, or build behavior.
- `guided-sim required` — when the protocol needs dynamic
  `remaining_accounts`, multi-ix transactions, target-vs-agent dispatch,
  or project-local service models, run `riptide sim generate` and write
  the flow in `.riptide/sim/src/flows.rs`.
- `guided-sim evidence ready` — when `riptide sim lint`, `riptide sim
  run --out`, and `riptide sim review` all pass, record the artifact
  directory, retained seed status, flow labels, transaction labels, and
  rerun command. Keep coverage marked unavailable when
  `sim.coverage.enabled = true` fails lint; do not describe guided-sim
  coverage as emitted until the runner has a coverage collector.
- `unsupported protocol surface` — requires engine support that does
  not exist.
- `case-study source/build issue` — missing `.so`, unreadable IDL,
  failing program build, or inconsistent source/test fixtures.

Restart validation from lint after adapter changes, from harness build
after harness changes, and from one-seed scenario smoke after scenario
changes.

## Protocol Assessment Output

Use `docs/protocol-assessment.md` and
`docs/templates/protocol-assessment-report.md` as the handoff contract
for protocol-level configuration results.

The final configuration report must include:

- a P0 coverage matrix row for every P0 flow in the Risk Plan, with
  status `covered`, `covered by guided sim`, `blocked`, `out of scope`,
  or `not assessed`
- a send/readiness verdict using exactly one of `ready_to_send`,
  `needs_guided_sim`, `needs_campaign_tuning`, `blocked`, or
  `unsupported`
- exact commands, artifact paths, and hashes when emitted for every
  headline evidence claim
- bounded claim language when only a narrow campaign or guided sim is
  runnable; do not describe unassessed authority, oracle, withdrawal,
  liquidation, or payout paths as covered

Verdict meanings:

- `ready_to_send` — every P0 row is classified, at least one P0 claim
  has focused campaign, adversarial campaign, or guided-sim evidence,
  headline claims cite exact commands/artifacts/hashes, and blocked or
  out-of-scope surfaces are visible.
- `needs_guided_sim` — a P0 flow depends on dynamic accounts,
  multi-instruction ordering, project-owned services, or other guided
  Rust logic before the claim is reviewable.
- `needs_campaign_tuning` — the adapter/harness can run, but the
  campaign does not yet cover the target P0 flow, stress range,
  invariant, negative control, or retained evidence shape.
- `blocked` — missing local inputs, build artifacts, deterministic
  account facts, dependency state, private protocol context, or command
  failures prevent a reviewable assessment.
- `unsupported` — the requested protocol claim is outside Riptide's
  current simulation evidence model or requires new engine support.

Once the campaign has run and produced a campaign root, do not hand-write
the coverage matrix and verdict above. Run:

```bash
riptide assess <campaign-root>
```

`riptide assess` is ingest-only: it reads an existing campaign root and
emits `assessment.json` plus a byte-deterministic `assessment.md` into
that root, then prints the assessment digest. It does not run the engine
or campaign — run the campaign (or guided sim) first, then assess its
root.

Not every protocol yields a risk-surface heatmap, so `riptide assess`
handles two assessment shapes and picks the right one from the evidence
in the root:

- **Cartography shape** — parameter-tunable protocols (lending, AMM,
  perps). When the root holds `campaign-summary.json` +
  `risk-surface.json` (+ `retention-manifest.json`), the assessment
  leads with the risk-surface heatmap: a parameter sweep whose cells
  show where a declared invariant's failure rate moves, plus the
  safe-region bounds.
- **Correctness shape** — correctness-dominated protocols (accounting,
  payments, authority). When the root holds guided-sim evidence
  (`sim/artifacts/<run>/guided-sim-run.json`), a run-collection, and
  packs but no `risk-surface.json`, the assessment leads with the
  coverage matrix + findings/non-findings. The risks tested are binary
  (accounting drift, double-payment, wrong-recipient settlement,
  unauthorized control), not a parameter-failure gradient, so a sweep
  would not produce a meaningful surface; the risk-surface section
  degrades to an explicit bounded note instead of a forced or all-zero
  heatmap.

Either way the generated `assessment.md` carries the coverage matrix
(with the status values above), the send/readiness verdict, findings vs
non-findings, and reproduction commands, so this section's output
becomes generated rather than authored by hand. Pass
`--input <json-file>` to feed the Risk Plan / coverage / verdict inputs,
or `--verdict` to assert one explicitly. Assess records simulation
evidence over the declared, fixed-seed region (or the guided-sim flows)
the run covered; it does not extend the claim beyond that region, and it
is not audit signoff or complete protocol safety.

## Final Report

Report:

- final state: `campaign_ready = yes`, `bounded_ready = yes`,
  `blocked = ...`, or `unsupported = ...`
- protocol assessment verdict: `ready_to_send`, `needs_guided_sim`,
  `needs_campaign_tuning`, `blocked`, or `unsupported`
- P0 coverage matrix with status, evidence tier, exact commands,
  artifact paths, hashes when emitted, and claim limits for each row
- adapter path and whether runtime is bundled or Generic SBF/IDL
- harness path and smoke command/result, if used
- scenario paths written or repaired
- init choices preserved or changed: selected personas, selected
  scenarios, and per-scenario `agents`, `ticks`, `seed`/`seeds`, and
  persona mix. If changed, include the reason and before/after values
- campaign path plus exact `campaign run` and `riptide review` commands
- guided-sim manifest path, artifact directory, and exact `riptide sim
  run --out ...` plus `riptide sim review ...` commands when guided sim
  was used
- remaining blockers or unsupported fields, separated into
  harness-solvable setup gaps, missing deterministic source facts,
  guided-sim required surfaces, and unsupported engine gaps
- evidence that output moved: non-empty simulation result, observation
  movement or a clear reason movement is not expected, retained rerun
  commands, and useful campaign summary readiness
- next steps, as a short explicit block. When `campaign_ready = yes` or
  `bounded_ready = yes`, include at minimum:
  1. the exact `riptide campaign run ...` command
  2. the exact `riptide review <campaign-root>` command, or tell the
     user to review the campaign root printed by `campaign run` when
     the final root is not known yet
  3. the exact `riptide assess <campaign-root>` command to generate the
     coverage matrix + verdict (`assessment.json` + `assessment.md`)
     from the run campaign root
  4. the retained-case paths to inspect after review
  5. the scope decision: accept the current evidence boundary or expand
     scope by addressing listed unsupported fields

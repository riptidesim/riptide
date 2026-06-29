---
name: riptide-config
description: >-
  Configure a Solana program repo for Riptide end to end after the thin
  default `riptide init` bootstrap.
  Use when the user says "riptide-config", "configure Riptide", "make this
  repo run in Riptide", "finish my adapter/sim", or has a
  `.riptide/` scaffold that needs a working adapter, a generated guided-sim
  crate, filled setup seams, a parameter sweep, validation, and a final
  readiness verdict. This merged skill owns the
  adapter, guided-sim setup, sweep, repair, and assessment readiness loop.
metadata:
  short-description: Configure Riptide end to end
---

# riptide-config

This skill is the default configuration path after `riptide init`. Plain
init intentionally creates only a thin `.riptide/` bootstrap: adapter
placeholder, artifact path hints when available, and
`.riptide/GETTING-STARTED.md`. The same agent session owns the adapter
TOML, the generated guided-sim crate (setup seams, personas, flows,
sweep, invariants), validation, repair loops, and the final readiness
report.
For protocol configuration work, the final report also carries a
protocol-assessment coverage matrix and send/readiness verdict that can
feed `docs/templates/protocol-assessment-report.md`.

There is no second LLM call, no endpoint config, and no API key. Use
normal shell commands and edit normal files.

## Contract

When invoked, do not ask for another prompt unless target detection is
genuinely ambiguous. Work until one final state is true:

- `campaign_ready = yes` — the adapter validates (`riptide doctor`), the
  generated guided-sim crate builds, a one-seed smoke (`riptide sim run`)
  passes, the declared flows and sweep run, and `riptide sim surface`
  produces a cartography root that `riptide assess` and `riptide review`
  validate with exact rerun commands. The skill prepares the guided-sim
  evidence; running the full sweep and `riptide assess` remain the user's
  to invoke when they want the final report.
- `bounded_ready = yes` — a narrower guided sim runs and is validated, but
  specific setup-solvable gaps, unsupported flows, or unsupported engine
  gaps keep the broader intended surface outside the current sim.
- `blocked = <reason>` — local source, build artifacts, CLI validation,
  crate compile, or smoke output names a fixable blocker.
- `unsupported = <boundary>` — the program depends on a protocol
  surface Riptide cannot currently model without new engine support.

Configuration readiness and send readiness are separate. Keep reporting
the setup state above, then also report a protocol assessment verdict
using exactly one of: `ready_to_send`, `needs_guided_sim`,
`needs_campaign_tuning`, `blocked`, or `unsupported`.

Do not stop at "lint PASS" if `riptide sim run` cannot execute the
generated crate against the adapter. Do not hand adapter-side blockers to
a separate skill. Repair the adapter, setup seams, or flows yourself in
this loop.

Own adapter, persona, flow, sweep, and invariant authoring by default
when the input is a thin init scaffold. Do not ask the user to manually
fill adapter TODOs before you begin unless target detection is genuinely
ambiguous. Do not leave required setup as comments when the account
bytes, PDA seeds, owners, or local service state are derivable from
source, IDL, tests, dependencies, constants, or existing fixtures.

## Risk Plan Inputs

When the user or Studio provides a confirmed Risk Plan and selected
profile, treat it as source-of-truth input for sweep shape, personas,
flows, guided-sim recommendations, runtime ceilings, artifact ceilings,
and evidence boundaries. Do not replace the confirmed plan with raw
iteration/flow/seed knobs unless validation proves the plan impossible;
when that happens, report the exact blocker and ask for the smallest
scope decision needed.

Use product-facing profiles before raw knobs:

- `calibration` — prove setup works with the smallest meaningful slice:
  adapter validation, the generated crate building, one deterministic
  seed, a short run, exact blocker capture, and no broad sweep execution.
- `ci-regression` — cheap repeatable safety gate: deterministic seeds,
  modest iterations, strong invariants, low artifacts, and commands
  suitable for a recurring local or CI check after calibration passes.
- `pre-audit` — stronger economic stress: multiple flow families and
  sweep axes, stricter invariants, medium/high iterations, retained
  failures/outliers, and human-readable review commands.
- `mainnet-scale` — incident rehearsal: use a wide sweep and high
  iteration counts for the main stress flows when runtime and artifact
  budgets allow, keep outliers, and state any reduced-size fallback as a
  budget cut.
- `overnight-search` — broad exploration: wider seeds/sweep values,
  explicit artifact cap, retained failures/outliers, and a next-day
  review path instead of interactive tuning.

Keep calibration first even when the confirmed profile is larger:
adapter validation, the generated crate building, and one deterministic
smoke must prove the setup before sweep expansion. Preserve unsupported
surfaces as coverage boundaries instead of forcing flows the sim cannot
model.

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
   - `.riptide/sim/`, if a generated guided-sim crate is already present
   - `.riptide/sim/Riptide.toml` and `.riptide/sim/src/flows.rs`
3. If `.riptide/` is missing, run `riptide init` only when the program
   name/profile are unambiguous; otherwise return
   `blocked = run riptide init first`.

Prefer editing the scaffolded adapter in place. Preserve user-authored
`.riptide` files when present.

## Thin Init And Wizard Choices

Treat a thin default `riptide init` scaffold as normal input, not as an
incomplete user task. In the thin path, you are expected to create or
repair the adapter, the generated guided-sim crate, inline personas,
flows, the sweep, and invariants yourself.

When the user explicitly ran `riptide init --wizard`, treat those
questionnaire answers as source-of-truth inputs, not disposable
scaffolding:

- Preserve selected personas in the adapter unless source facts prove a
  persona cannot execute against the adapter. If you remove or rename one,
  explain the reason in the final report.
- Preserve selected flow emphasis and existing `.riptide/sim/Riptide.toml`
  sweep values for `name`, `values`, `seeds_per_value`, and the persona
  mix unless a bounded run proves the value is invalid. If you change one,
  show a before/after diff in the final report.
- Sweep and flow defaults are allowed to differ per run. For example, a
  baseline run may sweep a narrow axis while a stress run sweeps wider. Do
  not describe those as skill overwrites; report them as existing run
  settings.
- Use a single `--seed <hex>` with low `--iterations` only for bounded
  smoke gates. Do not rewrite the stored `[sim.sweep] seeds_per_value`
  just because the smoke used a one-seed override.

When both wizard choices and a confirmed Risk Plan are present, preserve
both unless they conflict. If they conflict, the confirmed Risk Plan is
the newer source-of-truth for evidence profile, sweep shape, runtime
ceiling, artifact ceiling, and guided-sim recommendations; record any
changed wizard sizing in the final report.

For any existing user-authored `.riptide` file, preserve the user's
content unless validation proves it is invalid. If you change an existing
persona, flow, invariant, setup seam, or sweep, report the change and the
validation reason.

## Adapter Stage

Fill or repair the adapter before generating the sim crate.

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
- Do not omit setup-heavy accounts just because the generated setup will
  fill bytes later. Declare bindings for accounts like `price_update_v2`,
  `receipt_mint`, reserve vault/token accounts, and per-agent token
  accounts.
- `[[scheduled_actions]].accounts` must name declared `[accounts.*]`
  entries.
- Adapter TOML declares account shape, instruction mappings, actions,
  observations, personas, invariants, semantics, oracle channels, and
  lineage. The generated sim crate's setup seams create concrete
  pre-tick-0 bytes.
- Always include `[lineage]` with the IDL source, assumptions, and
  unsupported surfaces.

Validate after every adapter repair:

```bash
riptide doctor
```

`riptide doctor` is a static health check that loads the adapter and
reports its lint status. If it names an adapter field error, fix that
field before moving on. If doctor passes but a later sim load fails on
missing account bindings, repair the adapter and rerun doctor.

## Guided Sim Stage

The guided Rust simulation is the single execution path. After the
adapter validates, generate the project-owned sim crate, fill its setup
seams and flows, declare the sweep and evidence-honesty blocks, run a
smoke, then build the cartography surface that `riptide assess` reads.
The flow is one continuous narrative: adapter → generate → setup → flows
and sweep → run → surface → assess.

When the assessment front door (`riptide-assess`) hands over an
execution-path classification note, treat it as the path decision and map
its triggers to authoring seams: non-primitive or enum arguments → typed
builders in the generated sim crate; external oracle account bytes →
deterministic account construction in the generated setup seams or in
project-owned sim services; third-party / target-vs-agent actions,
multi-instruction sequences, and dynamic `remaining_accounts` →
hand-authored flows in `flows.rs`; custom CPI bootstrapping →
`Riptide.toml` program/account declarations plus bootstrap services.

### Generate the crate

```bash
riptide sim generate --adapter .riptide/adapters/<program>.toml
```

This scaffolds `.riptide/sim` with `Riptide.toml`, `src/flows.rs`,
`src/invariants.rs`, generated `types.rs` and `accounts.rs`, and a
`services/` directory. The `init`/setup code carries `TODO(setup)`
markers where pre-tick-0 state must exist. Keep generated `types.rs` and
`accounts.rs` regenerated-only; put hand-authored protocol actions,
dynamic account resolution, and service models under `flows.rs`,
`invariants.rs`, and `services/`.

### Fill the setup seams

Fill every `TODO(setup)` seam in the generated setup/init code with
deterministic facts: account bytes, SPL mints/vaults, PDAs, sibling
programs, and oracle accounts, all derived from local source, IDL, tests,
constants, and fixtures.

Keep setup deterministic: fixed amounts, fixed decimals, fixed seeds, no
network calls. The generated crate may build with `TODO(setup)` seams
still present, but TODO-only setup is not acceptable when setup-heavy
accounts are required and derivable. Before declaring a blocker, inspect
source, tests, IDL, dependency types, constants, and local fixtures for
account owners, discriminators, sizes, PDA seeds, feed IDs, and
serialization.

For external-owned accounts such as oracle receiver accounts, keep setup
deterministic: use local account bytes, checked-in snapshots, or
guided-sim fork cache entries. For Pyth `PriceUpdateV2` accounts, use the
provided `riptide_sim::oracle::PythPriceUpdate` builder instead of
hand-rolled bytes; other protocol-specific layouts stay project-owned (do
not ask Riptide core to learn them). If the exact layout, owner, feed ID,
or serialization cannot be determined from local facts or an explicit
`.riptide/sim/Riptide.toml` snapshot, return
`blocked = missing deterministic <fact> for guided-sim setup` and name
the account/instruction. Do not hide that state behind a vague TODO
comment.

Declare external programs, accounts, and forked snapshots generically in
`Riptide.toml` for Trident-class dependencies the project owns:

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

### Author flows, personas, and the sweep

Wire the provided guided-sim helpers instead of re-deriving their
patterns by hand:

- `riptide_sim::oracle::PythPriceUpdate` (+ `crash_in_place`) constructs
  and mutates the Pyth `PriceUpdateV2` account bytes a program's price
  read consumes — never hand-roll that layout.
- `riptide_sim::dispatch::ThirdPartyDispatch` builds the account set for
  an actor signing an instruction that operates on another actor's
  position or order (liquidator, keeper, matcher); `build()` enforces
  that the actor is the sole signer and the target never signs.

Do not add OpenBook, Drift, Mango, Marinade, Whirlpool, or other
protocol-specific layouts to Riptide core beyond the provided helpers. If
the protocol needs other external account bytes to evolve during a run,
declare the external programs/accounts/forked snapshots generically in
`Riptide.toml`, then model the protocol-specific mutation in
project-owned services.

Generic personas stay inline in the adapter; the sweep and flows in the
sim crate drive them. Do not write fixture `manifest.json`, `policies.json`,
or `.riptide/personas/` in user repos.

Declare the parameter sweep and the evidence-honesty blocks in
`Riptide.toml`. The sweep is the exogenous stress axis that replaces the
removed per-scenario run-configs: `riptide sim run` reads `[sim.sweep]`
and runs one iteration per (value, seed replicate). There is no `--sweep`
CLI flag and no campaign TOML — the sweep lives in `Riptide.toml`.

```toml
[sim.sweep]                      # the exogenous stress axis
name = "collateral_price_drop_bps"
values = [0, 1000, 2000, 3000, 4000, 5000, 6000]
seeds_per_value = 4

[sim.positive_control]           # the known-correct baseline coordinate
value = 0                        # usually axis value 0

[sim.lifecycle]                  # core flows that must execute on-chain
required_flows = ["create_lend_offer", "accept_lend_offer", "liquidate_loan"]
```

When the guided evidence is destined for an assessment, these blocks are
load-bearing: `[sim.positive_control]` is the known-correct baseline
coordinate (usually axis value `0`) and `[sim.lifecycle]` lists the
transaction labels that must execute on-chain. `riptide sim run` warns
when those checks fail; `riptide assess` blocks the report until they
pass. In `flows.rs`, read the swept coordinate with
`world.sweep_value("<axis>")`, echo it back with `world.record_parameter`,
record the deciding signal with `world.record_metric`, and fire the
deciding invariant with `world.record_invariant_fire` when the metric
crosses the stated risk line.

### Run, surface, and assess

Validate the guided-sim loop before running the full sweep:

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

Do not run the full sweep until this one-seed smoke passes.

Once the smoke passes, run the full sweep and build the cartography
surface that `riptide assess` reads:

```bash
riptide sim run .riptide/sim --flows 20 --out .riptide/sim/artifacts/<run>
riptide sim surface .riptide/sim/artifacts/<run> --sim .riptide/sim
```

`riptide sim run` reads `[sim.sweep]` and runs every (value, seed)
coordinate; `riptide sim surface` writes the cartography root —
`campaign-summary.json` + `risk-surface.json` + `retention-manifest.json`
— that `riptide assess` and `riptide review` consume.

After IDL changes, refresh generated builders without overwriting user
flows:

```bash
riptide sim refresh --adapter .riptide/adapters/<program>.toml --dir .riptide/sim
```

## Repair Loop

After every failure, classify it and repair the responsible layer:

- `skill prompt gap` — your generated adapter/setup/flow omitted a fact
  already visible in source/tests.
- `CLI validation gap` — `riptide doctor` or `riptide sim lint` passed but
  a later loader error was statically knowable. Record the gap in the
  final report.
- `setup source fact gap` — setup needs account bytes, owners, PDA seeds,
  feed IDs, or serialization facts that are not derivable from local
  source/tests/IDL/dependencies.
- `setup API/tooling gap` — setup code cannot express required bytes,
  account binding, sibling program, or build behavior.
- `guided-sim required` — when a flow needs dynamic `remaining_accounts`,
  multi-ix transactions, target-vs-agent dispatch, or project-local
  service models, run `riptide sim generate` and write the flow in
  `.riptide/sim/src/flows.rs`.
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

Restart validation from `riptide doctor` after adapter changes, from the
crate build and `riptide sim run` smoke after setup or flow changes, and
from one-seed smoke after sweep changes.

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
- bounded claim language when only a narrow sweep or guided sim is
  runnable; do not describe unassessed authority, oracle, withdrawal,
  liquidation, or payout paths as covered

Verdict meanings:

- `ready_to_send` — every P0 row is classified, at least one P0 claim
  has focused guided-sim evidence, headline claims cite exact
  commands/artifacts/hashes, and blocked or out-of-scope surfaces are
  visible.
- `needs_guided_sim` — a P0 flow depends on dynamic accounts,
  multi-instruction ordering, project-owned services, or other guided
  Rust logic before the claim is reviewable.
- `needs_campaign_tuning` — the adapter and sim crate can run, but the
  sweep does not yet cover the target P0 flow, stress range,
  invariant, negative control, or retained evidence shape.
- `blocked` — missing local inputs, build artifacts, deterministic
  account facts, dependency state, private protocol context, or command
  failures prevent a reviewable assessment.
- `unsupported` — the requested protocol claim is outside Riptide's
  current simulation evidence model or requires new engine support.

Once the guided sim has run and `riptide sim surface` has produced a
cartography root, do not hand-write the coverage matrix and verdict
above. Run:

```bash
riptide assess <guided-sim-root>
```

`riptide assess` is ingest-only: it reads an existing guided-sim root and
emits `assessment.json` plus a byte-deterministic `assessment.md` into
that root, then prints the assessment digest. It does not run the engine
or sim — run the guided sim and `riptide sim surface` first, then assess
its root.

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
  evidence packs but no `risk-surface.json`, the assessment leads with the
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
- which setup seams were filled and the smoke command/result
- flows and sweep authored or repaired
- init choices preserved or changed: selected personas, sweep axis and
  values, `seeds_per_value`, and persona mix. If changed, include the
  reason and before/after values
- guided-sim crate path, artifact directory, and exact `riptide sim
  run --out ...`, `riptide sim surface ...`, and `riptide sim review ...`
  commands
- remaining blockers or unsupported fields, separated into
  setup-solvable gaps, missing deterministic source facts,
  unsupported flows, and unsupported engine gaps
- evidence that output moved: non-empty simulation result, observation
  movement or a clear reason movement is not expected, retained rerun
  commands, and a useful campaign summary readiness
- next steps, as a short explicit block. When `campaign_ready = yes` or
  `bounded_ready = yes`, include at minimum:
  1. the exact `riptide sim run ...` command for the full sweep
  2. the exact `riptide sim surface ...` command to build the cartography
     root
  3. the exact `riptide assess <guided-sim-root>` command to generate the
     coverage matrix + verdict (`assessment.json` + `assessment.md`)
     from that cartography root
  4. the exact `riptide review <guided-sim-root>` command, or tell the
     user to review the root printed by `riptide sim surface` when the
     final root is not known yet
  5. the retained-case paths to inspect after review
  6. the scope decision: accept the current evidence boundary or expand
     scope by addressing listed unsupported fields

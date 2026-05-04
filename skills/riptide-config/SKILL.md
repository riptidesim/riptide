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
  specific harness-solvable setup gaps or engine/runtime dispatcher gaps
  keep the broader intended surface outside the current campaign.
- `blocked = <reason>` — local source, build artifacts, CLI validation,
  harness compile, or smoke output names a fixable blocker.
- `unsupported = <boundary>` — the program depends on a protocol
  surface Riptide cannot currently model without new engine support.

Do not stop at "lint PASS" if `riptide run --harness` cannot load the
adapter. Do not hand adapter-side blockers to a separate harness skill.
Repair the adapter, harness, or scenarios yourself in this loop.

Own persona, scenario, invariant, and campaign creation by default when
the input is a thin init scaffold. Do not ask the user to manually fill
adapter TODOs before you begin unless target detection is genuinely
ambiguous. Do not leave required harness setup as comments when the
account bytes, PDA seeds, owners, or local service state are derivable
from source, IDL, tests, dependencies, constants, or existing fixtures.

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

For external-owned accounts such as oracle receiver accounts, mock the
local account bytes the program reads; do not require a live network
service or put that setup in Riptide core. If the exact layout, owner,
feed ID, or serialization cannot be determined from local facts, return
`blocked = missing deterministic <fact> for harness setup` and name the
account/instruction. Do not hide that state behind a vague TODO comment.

Harness setup owns pre-tick-0 accounts and sibling programs. It does
not teach the generic dispatcher to construct dynamic
`remaining_accounts`, add new signer aliases, or encode unsupported
custom arguments. Report those separately as engine/runtime dispatcher
gaps.

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

Point it at repo-local adapter and scenario paths. Keep the first
campaign small enough to run quickly, with fixed seed policy and
retained rerun cases.

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
- `engine/runtime dispatcher gap` — the harness can create state, but
  execution needs generic support for `remaining_accounts`, signer role
  aliases, or unsupported argument encoding.
- `unsupported protocol surface` — requires engine support that does
  not exist.
- `case-study source/build issue` — missing `.so`, unreadable IDL,
  failing program build, or inconsistent source/test fixtures.

Restart validation from lint after adapter changes, from harness build
after harness changes, and from one-seed scenario smoke after scenario
changes.

## Final Report

Report:

- final state: `campaign_ready = yes`, `bounded_ready = yes`,
  `blocked = ...`, or `unsupported = ...`
- adapter path and whether runtime is bundled or Generic SBF/IDL
- harness path and smoke command/result, if used
- scenario paths written or repaired
- init choices preserved or changed: selected personas, selected
  scenarios, and per-scenario `agents`, `ticks`, `seed`/`seeds`, and
  persona mix. If changed, include the reason and before/after values
- campaign path plus exact `campaign run` and `riptide review` commands
- remaining blockers or unsupported fields, separated into
  harness-solvable setup gaps, missing deterministic source facts, and
  engine/runtime dispatcher gaps
- evidence that output moved: non-empty simulation result, observation
  movement or a clear reason movement is not expected, retained rerun
  commands, and useful campaign summary readiness
- next steps, as a short explicit block. When `campaign_ready = yes` or
  `bounded_ready = yes`, include at minimum:
  1. the exact `riptide campaign run ...` command
  2. the exact `riptide review <campaign-root>` command, or tell the
     user to review the campaign root printed by `campaign run` when
     the final root is not known yet
  3. the retained-case paths to inspect after review
  4. the scope decision: accept the current evidence boundary or expand
     scope by addressing listed unsupported fields

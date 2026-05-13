# Riptide case-study corpus readiness

This page is the launch-readiness boundary for the local case-study corpus.
It combines deterministic static inventory with the executed validation
commands captured for the current release candidate.

> **Snapshot note:** This page records the earlier corpus-readiness snapshot.
> Newer real-world evidence for Raydium CP-Swap, Mango V4, and Whirlpools is
> recorded in the local report set under `reports/real-world-scale/`, including
> `reports/real-world-scale/semantic-amm-evidence.md`. Treat the matrix below as
> historical unless it is refreshed with those later commands.

- Case-study root: `/home/ailton/Work/riptide/case-studies`
- Local repositories with `.riptide/`: 10
- Public claim summary from executed evidence: demo-ready=2, blocked=8
- Static corpus report: the deterministic readiness command completed, but
  that command is intentionally static-only and keeps dynamic gates skipped.

## What this supports

- You can demo the `lending` row with a harness-aware deterministic baseline
  run and a hash-verified pack review boundary.
- You can demo the `anchor-uniswap-v2` row with guided-sim lint, build, run,
  guided review, and root review.
- You can tell external testers exactly which local case-study repos are only
  inventory and adapter-readiness evidence today.
- You can use the blocked rows as an implementation queue because each row has
  a concrete missing input or adapter completion step.
- You can point to the bundled incident shape-replay fixtures for Mango, Euler,
  KelpDAO, Loopscale, and Drift as separate simulation evidence from this
  external case-study corpus.

## What this does not prove

- This does not replace an independent audit, formal verification, or a
  protocol team's own production risk process.
- This does not show bytecode-level historical incident reproduction. Mango,
  Euler, KelpDAO, Loopscale, and Drift ship as economic-shape replay fixtures
  with explicit boundaries, not literal mainnet or EVM reconstructions.
- This does not make every local case-study repo executable. Eight rows still
  need adapter, IDL, account mapping, harness, or trustworthy run-artifact work.
- This does not prove the fresh-clone path unless the fresh-clone section below
  records an executed command sequence and exit code.

## Evidence families

| Evidence family | Current status | Boundary |
| --- | --- | --- |
| Internal fixture catalog | Shipping fixtures and scenario families live in the main repo. See [Scenario family catalog](scenario-catalog.md). | These fixtures prove Riptide's bundled examples and regression hashes, not the external case-study corpus. |
| External case-study corpus | Ten local `.riptide/` repos were inventoried. Two rows have executed demo evidence. Eight rows are blocked with concrete next actions. | This is local prerelease validation for testers and filming. It is not a statement that every external protocol is wired end to end. |
| Historical incident shape replays | Five bundled replay fixtures ship for Mango, Euler, KelpDAO, Loopscale, and Drift. | These are machine-checkable economic-shape replays with named invariant firings and pinned hashes. They are not bytecode-level reconstructions or protocol audit claims. |

## Gate contract

| Gate | Default | Contract |
| --- | --- | --- |
| inventory-only | yes | Discover immediate child repositories under the case-study root that contain `.riptide/`. |
| static-health | yes | Run readiness inspection without building, fetching, or executing simulations. |
| adapter-lint | no | Validate the repo-local adapter TOML and its declared IDL or explicit fields. |
| direct-baseline-run | no | Run a repo-local baseline scenario through `riptide run`. |
| guided-sim-run-review | no | Run and review a repo-local guided simulation artifact. |
| campaign-validate-plan-run | no | Validate, plan, run, and review a repo-local campaign input. |
| fresh-clone-eligibility | no | Clone the public repo, install it, check help output, and run a smoke path. |

## Case-study matrix

| Case study | Protocol class | Current public claim | Highest executed evidence | Boundary | Next action |
| --- | --- | --- | --- | --- | --- |
| `anchor-uniswap-v2` | AMM guided simulation | demo-ready | `riptide sim lint`, guided-sim Cargo build, `riptide sim run`, `riptide sim review`, and root `riptide review` exited 0. | Guided evidence covers the declared manifest, Rust flows, services, seed, and artifact. It does not claim campaign coverage or broad AMM incident coverage. | Keep the guided artifact available for the close note. Add direct adapter or campaign evidence only if the demo needs that path. |
| `lending` | Lending / Solend fork | demo-ready with harness boundary | `riptide doctor`, `riptide lint`, and harness-aware baseline `riptide run` exited 0. Pack review verified the canonical hash. | The row requires `.riptide/harness` for pre-tick-0 setup. `riptide review` exits 1 because provenance and proof metadata are absent, so no proof-level badge is claimed. | Keep the harness requirement in rerun instructions. Add risk-slice and provenance metadata before claiming proof-level evidence. |
| `liquid-staking-program` | Liquid staking | blocked | Static readiness exited 0. Adapter lint and direct baseline exited 2. | The adapter still depends on a missing `target/idl/marinade_finance.json`. | Build or restore the IDL, or replace IDL-backed inference with explicit adapter fields, then rerun lint and baseline. |
| `mango-v4` | Perps / margin | blocked; external adapter candidate | Static readiness exited 0. Adapter lint exited 2. | The adapter still depends on a missing `target/idl/mango_v4.json`. The bundled Mango incident fixture is a separate shape replay and does not make this external repo executable. | Restore/build the IDL or write explicit adapter fields, then regenerate trustworthy run evidence. |
| `marinade-liquid-stake-fork` | Liquid staking | blocked | Static readiness exited 0. Adapter lint and direct baseline exited 2. | The adapter still depends on a missing `target/idl/marinade_forking_smart_contract.json`. | Build or restore the IDL, or replace IDL-backed inference with explicit adapter fields, then rerun lint and baseline. |
| `perpetuals` | Perpetuals | blocked | Static readiness exited 0. Adapter lint and direct baseline exited 2. | The adapter still depends on a missing `target/idl/perpetuals.json`. | Restore/build the IDL or write explicit adapter fields, then rerun lint and baseline. |
| `protocol-v2` | Perps / Drift | blocked | Static readiness exited 0. Adapter lint exited 2. | The adapter still depends on a missing `target/idl/drift.json`; protocol-specific mocks are not supplied. The bundled Drift incident fixture is a separate shape replay and does not make this external repo executable. | Treat this as later external-protocol ladder work after local IDL, artifacts, and mocks are available. |
| `solana-program-library` | Selected SPL target | blocked | Static readiness exited 0. Adapter lint exited 2. | The broad repo is not a concrete proof-pack row as-is, and the adapter expects `target/idl/solana_program_library.json`. | Pick one SPL program target and provide local IDL/artifacts or explicit adapter fields before end-to-end work. |
| `stablecoin-protocol` | Stablecoin | blocked | Static readiness exited 0. Adapter lint and direct baseline exited 2. | The adapter is still an incomplete stub; `[accounts]` has no account binding. | Finish account, instruction, state, action, observation, and persona mapping, then rerun lint and baseline. |
| `whirlpools` | CLMM / AMM | blocked | Static readiness exited 0. Adapter lint exited 2. | The adapter is still an incomplete stub; `[accounts]` has no account binding. | Finish adapter mapping before attempting CLMM execution; keep this as later external-protocol ladder work. |

## Command summary

The command evidence was captured from fresh shells. Raw stdout and stderr stay
in the local report directory; this page keeps only the launch-readable
boundary.

| Area | Command shape | Exit | Summary |
| --- | --- | ---: | --- |
| Corpus inventory | `find /home/ailton/Work/riptide/case-studies -maxdepth 2 -type d -name .riptide \| sort` | 0 | Found all ten local `.riptide/` case-study workspaces. |
| Static corpus report | `node cli/dist/src/index.js readiness --case-studies /home/ailton/Work/riptide/case-studies --out <local-report-dir>` | 0 | Wrote deterministic JSON and Markdown. Dynamic gates remain skipped in that generated report. |
| Lending health | `riptide doctor` from `case-studies/lending` | 0 | Environment and repo-local readiness checks passed. |
| Lending adapter lint | `riptide lint .riptide/adapters/lending.toml` from `case-studies/lending` | 0 | Adapter validation passed. |
| Lending baseline | `riptide run .riptide/scenarios/baseline/run-config.json --adapter .riptide/adapters/lending.toml --harness .riptide/harness --seed-root 1337` | 0 | `ok baseline`; one pass, zero fail, zero error, zero skip. |
| Lending pack review | `riptide review .riptide/pack/baseline` | 1 | Canonical hash verification passed. Exit 1 is retained because provenance/proof metadata is absent. |
| AUV2 guided lint | `riptide sim lint .riptide/sim/Riptide.toml` | 0 | Guided manifest lint passed. |
| AUV2 guided build | `cargo build --manifest-path .riptide/sim/Cargo.toml --release` | 0 | Guided-sim Rust flows built successfully. |
| AUV2 guided run | `riptide sim run .riptide/sim --iterations 5 --flows 20 --seed 1337 --out <guided-artifact-dir>` | 0 | Produced a guided artifact for five iterations and 100 flow calls. |
| AUV2 guided review | `riptide sim review <guided-artifact-dir>` | 0 | Status passed; zero unexpected errors and zero panics. |
| AUV2 root review | `riptide review <guided-artifact-dir>` | 0 | Root review accepted the guided artifact. |
| Beta-class readiness | `riptide readiness . --json` from stablecoin, liquid staking, Marinade fork, and perpetuals | 0 | Static readiness produced useful blockers and next actions. |
| Beta-class lint | `riptide lint <repo-local-adapter>` from stablecoin, liquid staking, Marinade fork, and perpetuals | 2 | Lint stopped on incomplete adapter account bindings or missing IDL files. |
| Beta-class baseline | `riptide run .riptide/scenarios/baseline/run-config.json --adapter <repo-local-adapter>` | 2 | Existing baseline inputs were attempted and stopped on the same setup blockers. |
| Stretch readiness | `riptide readiness . --json` from Mango, Drift, Whirlpools, and SPL | 0 | Static readiness produced useful blockers and handoff notes. |
| Stretch lint | `riptide lint <repo-local-adapter>` from Mango, Drift, Whirlpools, and SPL | 2 | Lint stopped on incomplete adapter account bindings or missing IDL files. |

## Tester paths available now

From the current checkout, the demo rows use these rerun paths:

```bash
cd /home/ailton/Work/riptide/case-studies/lending
riptide doctor
riptide lint .riptide/adapters/lending.toml
riptide run .riptide/scenarios/baseline/run-config.json \
  --adapter .riptide/adapters/lending.toml \
  --harness .riptide/harness \
  --seed-root 1337
```

```bash
cd /home/ailton/Work/riptide/case-studies/anchor-uniswap-v2
riptide sim lint .riptide/sim/Riptide.toml
cargo build --manifest-path .riptide/sim/Cargo.toml --release
riptide sim run .riptide/sim \
  --iterations 5 \
  --flows 20 \
  --seed 1337 \
  --out /tmp/riptide-auv2-guided-artifact
riptide sim review /tmp/riptide-auv2-guided-artifact
riptide review /tmp/riptide-auv2-guided-artifact
```

## Fresh-clone evaluator path

Status: executed from `/tmp/riptide-fresh-clone` on May 5, 2026. The cloned
commit was `f2693d4d09c52f05f9e8939842343d1fd87c1e89`.

Use this sequence from a clean shell:

```bash
cd /tmp
git clone https://github.com/riptidesim/riptide riptide-fresh-clone
cd riptide-fresh-clone
./install.sh
riptide --help
riptide doctor
riptide run examples/configs/safe.json --adapter fixtures/adapters/lending.toml
```

Execution summary:

| CWD | Command | Exit | Summary |
| --- | --- | ---: | --- |
| `/tmp` | `git clone https://github.com/riptidesim/riptide riptide-fresh-clone` | 0 | Fresh clone completed. |
| `/tmp/riptide-fresh-clone` | `./install.sh` | 0 | Install completed in 19m 10s. It built the engine, shipped SBF programs, CLI, launcher, safe lending smoke, and generic smoke. |
| `/tmp/riptide-fresh-clone` | `riptide --help` | 0 | Help printed the command surface. |
| `/tmp/riptide-fresh-clone` | `riptide doctor` | 1 | WARN verdict: 10 pass, 3 warn, 0 fail. The warnings are optional fixture binaries not built for AMM, liquid staking, and perpetuals. |
| `/tmp/riptide-fresh-clone` | `riptide run examples/configs/safe.json --adapter fixtures/adapters/lending.toml` | 0 | One scenario passed with no failure observed; one pass, zero fail, zero error, zero skip. |

Accepted caveats:

- The repository installer builds from source and therefore requires the pinned
  local Rust, Node.js, npm, and Solana SBF toolchain.
- The installer writes `/home/ailton/.local/bin/riptide` as a source-checkout
  launcher pointing at `/tmp/riptide-fresh-clone/cli/dist/src/index.js`. Keep
  that clone available, reinstall from the intended checkout, or use the hosted
  installer before relying on the global `riptide` command after `/tmp` cleanup.
- Hosted installer checks are separate from this path.
- The smoke run checks a bundled fixture path, not an external case-study repo.
- `riptide doctor` returns WARN after install because AMM, liquid-staking, and
  perpetuals fixture binaries are optional and were not built by the repository
  installer.
- `riptide run lending/whale-shock-grid --seeds 1 --seed-root 1337` was
  attempted from the fresh repo root and exited 2 because the pattern does not
  match a discovered `.riptide/scenarios/` entry. Use the explicit
  `examples/configs/safe.json` smoke path above for this evaluator flow until a
  root scenario alias is wired.

## Next actions

1. Keep public beta wording for the external corpus limited to local simulation
   evidence and guided artifact review for the two demo-ready rows.
2. For incident claims, use the bundled Mango, Euler, KelpDAO, Loopscale, and
   Drift shape-replay fixtures and preserve the explicit no-bytecode-replay
   boundary.
3. Complete adapter account mappings or restore IDLs for blocked external rows,
   then rerun adapter lint and the baseline path for each row.
4. Decide whether `riptide adapt` should become harness-aware or remain
   documented as adapter-only for setup-heavy repositories.

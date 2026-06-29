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
- Public claim summary from executed evidence: demo-ready=1, blocked=9
- Static corpus report: the deterministic readiness command completed, but
  that command is intentionally static-only and keeps dynamic gates skipped.

## What this supports

- You can demo the `anchor-uniswap-v2` row with guided-sim lint, build, run,
  guided review, and root review.
- You can show the static `riptide readiness` and `riptide doctor` gates for
  every inventoried repo, including `lending`.
- You can tell external testers exactly which local case-study repos are only
  inventory and adapter-readiness evidence today.
- You can use the blocked rows as an implementation queue because each row has
  a concrete missing input or adapter completion step.

## What this does not prove

- This does not replace an independent audit, formal verification, or a
  protocol team's own production risk process.
- This does not make every local case-study repo executable. Eight rows still
  need adapter, IDL, account mapping, harness, or trustworthy run-artifact work.
- This does not prove the fresh-clone path unless the fresh-clone section below
  records an executed command sequence and exit code.

## Evidence families

| Evidence family | Current status | Boundary |
| --- | --- | --- |
| Internal adapter fixtures | Shipping adapter and program fixtures live in the main repo under `fixtures/` and `programs/`. | These fixtures prove Riptide's bundled examples, not the external case-study corpus. |
| External case-study corpus | Ten local `.riptide/` repos were inventoried. One row has executed demo evidence. Nine rows are blocked with concrete next actions. | This is local prerelease validation for testers and filming. It is not a statement that every external protocol is wired end to end. |

## Gate contract

| Gate | Default | Contract |
| --- | --- | --- |
| inventory-only | yes | Discover immediate child repositories under the case-study root that contain `.riptide/`. |
| static-health | yes | Run readiness inspection without building, fetching, or executing simulations. |
| guided-sim-run-review | no | Run and review a repo-local guided simulation artifact. |
| fresh-clone-eligibility | no | Clone the public repo, install it with `./install.sh`, and check `riptide --version`, `riptide --help`, and `riptide doctor`. |

## Case-study matrix

| Case study | Protocol class | Current public claim | Highest executed evidence | Boundary | Next action |
| --- | --- | --- | --- | --- | --- |
| `anchor-uniswap-v2` | AMM guided simulation | demo-ready | `riptide sim lint`, guided-sim Cargo build, `riptide sim run`, `riptide sim review`, and root `riptide review` exited 0. | Guided evidence covers the declared manifest, Rust flows, services, seed, and artifact. It does not claim swept cartography coverage or broad AMM incident coverage. | Keep the guided artifact available for the close note. Add a guided-sim parameter sweep (`riptide sim surface`) only if the demo needs cartography evidence. |
| `lending` | Lending / Solend fork | blocked (historical demo path removed) | `riptide doctor` and static `riptide readiness` exited 0. | The earlier demo used a direct baseline-run and pack-review path that has been removed. The row has no surviving guided-sim artifact yet, so no demo-level claim holds. | Add a guided sim for the deposit and redemption flows (`riptide sim generate` -> `riptide sim run` -> `riptide sim review` / `riptide review`) to make it demo-ready again. |
| `liquid-staking-program` | Liquid staking | blocked | Static readiness exited 0 and flagged the missing IDL. | The adapter still depends on a missing `target/idl/marinade_finance.json`. | Build or restore the IDL, or replace IDL-backed inference with explicit adapter fields, then rerun readiness. |
| `mango-v4` | Perps / margin | blocked; external adapter candidate | Static readiness exited 0 and flagged the missing IDL. | The adapter still depends on a missing `target/idl/mango_v4.json`. | Restore/build the IDL or write explicit adapter fields, then regenerate trustworthy guided-sim evidence. |
| `marinade-liquid-stake-fork` | Liquid staking | blocked | Static readiness exited 0 and flagged the missing IDL. | The adapter still depends on a missing `target/idl/marinade_forking_smart_contract.json`. | Build or restore the IDL, or replace IDL-backed inference with explicit adapter fields, then rerun readiness. |
| `perpetuals` | Perpetuals | blocked | Static readiness exited 0 and flagged the missing IDL. | The adapter still depends on a missing `target/idl/perpetuals.json`. | Restore/build the IDL or write explicit adapter fields, then rerun readiness. |
| `protocol-v2` | Perps / Drift | blocked | Static readiness exited 0 and flagged the missing IDL. | The adapter still depends on a missing `target/idl/drift.json`; protocol-specific mocks are not supplied. | Treat this as later external-protocol ladder work after local IDL, artifacts, and mocks are available. |
| `solana-program-library` | Selected SPL target | blocked | Static readiness exited 0 and flagged the missing IDL. | The broad repo is not a concrete demo row as-is, and the adapter expects `target/idl/solana_program_library.json`. | Pick one SPL program target and provide local IDL/artifacts or explicit adapter fields before end-to-end work. |
| `stablecoin-protocol` | Stablecoin | blocked | Static readiness exited 0 and flagged the incomplete adapter stub. | The adapter is still an incomplete stub; `[accounts]` has no account binding. | Finish account, instruction, state, action, observation, and persona mapping, then rerun readiness. |
| `whirlpools` | CLMM / AMM | blocked | Static readiness exited 0 and flagged the incomplete adapter stub. | The adapter is still an incomplete stub; `[accounts]` has no account binding. | Finish adapter mapping before attempting CLMM execution; keep this as later external-protocol ladder work. |

## Command summary

The command evidence was captured from fresh shells. Raw stdout and stderr stay
in the local report directory; this page keeps only the launch-readable
boundary.

| Area | Command shape | Exit | Summary |
| --- | --- | ---: | --- |
| Corpus inventory | `find /home/ailton/Work/riptide/case-studies -maxdepth 2 -type d -name .riptide \| sort` | 0 | Found all ten local `.riptide/` case-study workspaces. |
| Static corpus report | `node cli/dist/src/index.js readiness --case-studies /home/ailton/Work/riptide/case-studies --out <local-report-dir>` | 0 | Wrote deterministic JSON and Markdown. Dynamic gates remain skipped in that generated report. |
| Lending health | `riptide doctor` from `case-studies/lending` | 0 | Environment and repo-local readiness checks passed. |
| AUV2 guided lint | `riptide sim lint .riptide/sim/Riptide.toml` | 0 | Guided manifest lint passed. |
| AUV2 guided build | `cargo build --manifest-path .riptide/sim/Cargo.toml --release` | 0 | Guided-sim Rust flows built successfully. |
| AUV2 guided run | `riptide sim run .riptide/sim --iterations 5 --flows 20 --seed 1337 --out <guided-artifact-dir>` | 0 | Produced a guided artifact for five iterations and 100 flow calls. |
| AUV2 guided review | `riptide sim review <guided-artifact-dir>` | 0 | Status passed; zero unexpected errors and zero panics. |
| AUV2 root review | `riptide review <guided-artifact-dir>` | 0 | Root review accepted the guided artifact. |
| Beta-class readiness | `riptide readiness . --json` from stablecoin, liquid staking, Marinade fork, and perpetuals | 0 | Static readiness produced useful blockers and next actions, including incomplete adapter bindings and missing IDL files. |
| Stretch readiness | `riptide readiness . --json` from Mango, Drift, Whirlpools, and SPL | 0 | Static readiness produced useful blockers and handoff notes, including missing IDL files. |

## Tester paths available now

From the current checkout, the demo row uses this rerun path:

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

The installer is engine-free: `./install.sh` runs `npm install`, builds the
CLI, writes the `riptide` launcher, and verifies the install with
`riptide --version`, `riptide --help`, and `riptide doctor`. It does not build a
simulation engine binary.

Use this sequence from a clean shell:

```bash
cd /tmp
git clone https://github.com/riptidesim/riptide riptide-fresh-clone
cd riptide-fresh-clone
./install.sh
riptide --version
riptide --help
riptide doctor
```

Accepted caveats:

- The installer builds the CLI from source and therefore requires the pinned
  local Node.js and npm toolchain.
- The installer writes `/home/ailton/.local/bin/riptide` as a source-checkout
  launcher pointing at `/tmp/riptide-fresh-clone/cli/dist/src/index.js`. Keep
  that clone available, reinstall from the intended checkout, or use the hosted
  installer before relying on the global `riptide` command after `/tmp` cleanup.
- Hosted installer checks are separate from this path.
- `riptide doctor` can return WARN when optional fixture binaries are not
  present; that is a warning, not a failed install.
- To exercise a workspace after install, use the guided-sim demo row above
  (`anchor-uniswap-v2`).

## Next actions

1. Keep public beta wording for the external corpus limited to local simulation
   evidence and guided artifact review for the demo-ready row.
2. Complete adapter account mappings or restore IDLs for blocked external rows,
   then rerun `riptide readiness` for each row.
3. Add guided sims for the highest-value blocked rows so they can reach
   `riptide sim run`, `riptide assess`, and `riptide review` evidence.

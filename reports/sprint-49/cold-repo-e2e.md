# Cold-repo end-to-end proof — installed CLI, no monorepo resolvable

Goal: prove the packaged Riptide CLI runs the guided-sim → cartography → assess
flow inside an external Solana program repo, with the Riptide monorepo
unresolvable from the sandbox environment. Fixture: the Agio P2P-lending
case-study program + its authored guided sim (the largest runtime surface).

Sandbox layout:

- `/tmp/riptide-t04/prefix` — clean npm prefix; the only Riptide install visible.
- `/tmp/riptide-t04/agio-repo` — the "external team repo": Agio program sources,
  built `target/deploy/agio.so` + `target/idl/agio.json`, no `.riptide/`.
- `/tmp/riptide-t04/case-study-sim` — the authored guided-sim sources staged for
  the overlay step (stands in for authoring the sim in the user repo).

Artifact under test: `riptide-cli-0.9.1.tgz`, shasum
`444801cfe4b3a34c5e9788f64331c2010359be74`, rebuilt from this checkout
(`cd cli && npm run build && npm pack`) after the runtime-path resolution fix,
installed via the documented local-tarball path in `docs/install.md`
(`npm install -g --ignore-scripts` + locally built engine pre-seeded at
`bin/riptide-engine`, because the v0.9.1 release engine asset is not published).

Every step below ran under `env -i HOME=$HOME TERM=dumb NO_COLOR=1
PATH="/tmp/riptide-t04/prefix/bin:$HOME/.cargo/bin:/usr/bin:/bin"` — no
inherited environment, no monorepo PATH component. Outputs are verbatim.

## Step 0 — install the tarball into a clean prefix

```
$ npm install -g --prefix /tmp/riptide-t04/prefix --ignore-scripts /tmp/riptide-t04-artifact/riptide-cli-0.9.1.tgz

added 53 packages in 6s

19 packages are looking for funding
  run `npm fund` for details
Reshimming mise 24.11.1...
$ cp ~/Work/riptide/riptide/target/release/riptide-engine /tmp/riptide-t04/prefix/lib/node_modules/@riptide/cli/bin/riptide-engine
$ riptide --version
0.9.1
```

## Step 1 — isolation verification (monorepo unresolvable)

The installed `riptide` launcher realpath-resolves inside the prefix (a real
copy, not a symlink into the checkout), no PATH component is under
`/home/ailton/Work/riptide`, and no `RIPTIDE_*` / `NODE_PATH` variables exist:

```
$ echo $PATH
/tmp/riptide-t04/prefix/bin:/home/ailton/.cargo/bin:/usr/bin:/bin
$ case ":$PATH:" in *"/Work/riptide"*) echo MONOREPO-ON-PATH ;; *) echo no /Work/riptide component on PATH ;; esac
no /Work/riptide component on PATH
$ command -v riptide node cargo
/tmp/riptide-t04/prefix/bin/riptide
/usr/bin/node
/home/ailton/.cargo/bin/cargo
$ realpath $(command -v riptide)
/tmp/riptide-t04/prefix/lib/node_modules/@riptide/cli/dist/src/index.js
$ env | grep -iE "riptide|node_path" || echo "no riptide/NODE_PATH env vars"
PWD=/tmp/riptide-t04
PATH=/tmp/riptide-t04/prefix/bin:/home/ailton/.cargo/bin:/usr/bin:/bin
$ ls /tmp/riptide-t04/prefix/lib/node_modules/@riptide/cli/dist/sim-runtime
Cargo.lock
riptide-sim
riptide-sim-macros
```

## Step 2 — `riptide init` in the external repo

```
$ riptide init
riptide init: scaffolded .riptide/ for agio
  created .riptide/adapters/agio.toml
  created .riptide/GETTING-STARTED.md
  created .gitignore
  created .claude/skills/riptide-config

Next steps:

  1. Invoke /riptide-config in your coding agent.
     It will finish the adapter, harness, scenarios, campaign readiness, and validation.

  2. Run the campaign it creates:
     riptide campaign run .riptide/campaigns/<risk>.campaign.toml

  3. Review the printed campaign root:
     riptide review <campaign-root>

Manual / advanced path: run riptide init --wizard --force only if you want to replace this thin scaffold with questionnaire-selected starter files. Otherwise follow .riptide/GETTING-STARTED.md.

More detail: .riptide/GETTING-STARTED.md
$ ls .riptide .riptide/adapters
.riptide:
GETTING-STARTED.md
adapters

.riptide/adapters:
agio.toml
```

## Step 3 — authored adapter + `riptide sim generate`

The case-study adapter (repo-root-relative `idl_path` / `program_so`, the form
`riptide-config` writes) stands in for adapter authoring. Generation resolves
the IDL from the repo root and emits vendored, relative runtime deps:

```
$ cp ../case-study-sim/agio.toml .riptide/adapters/agio.toml   # authored adapter (stands in for /riptide-config)
$ riptide sim generate --adapter .riptide/adapters/agio.toml
riptide sim: generated guided Rust simulation at /tmp/riptide-t04/agio-repo/.riptide/sim
  adapter /tmp/riptide-t04/agio-repo/.riptide/adapters/agio.toml
  idl /tmp/riptide-t04/agio-repo/target/idl/agio.json
  manifest /tmp/riptide-t04/agio-repo/.riptide/sim/Cargo.toml
  bootstrap /tmp/riptide-t04/agio-repo/.riptide/sim/Riptide.toml
$ sed -n "/\[dependencies\]/,\$p" .riptide/sim/Cargo.toml
[dependencies]
anyhow = "1.0"
borsh = { version = "1.6.1", features = ["derive"] }
riptide-sim = { path = "vendor/riptide-sim" }
riptide-sim-macros = { path = "vendor/riptide-sim-macros" }
$ grep -rn "Work/riptide" .riptide/sim/Cargo.toml .riptide/sim/Cargo.lock .riptide/sim/vendor/*/Cargo.toml .riptide/sim/src/ || echo "no monorepo paths in the generated crate"
no monorepo paths in the generated crate
```

Overlay of the authored guided-sim sources (flows, services, invariants,
`Riptide.toml`, customized `main.rs`) — stands in for authoring the sim:

```
$ cp -r ../case-study-sim/src/. .riptide/sim/src/ && cp ../case-study-sim/Riptide.toml .riptide/sim/Riptide.toml   # authored guided sim (flows, services, invariants, manifest)
$ grep -rn "Work/riptide" .riptide/sim/src/ .riptide/sim/Riptide.toml || echo "no monorepo paths in the authored sim sources"
no monorepo paths in the authored sim sources
```

## Step 4 — `riptide sim run` (manifest-declared sweep, cold build)

First build of the generated crate in the sandbox; `cargo metadata` provenance
appended at the end shows both runtime crates resolved from `vendor/`:

```
$ riptide sim run .riptide/sim --flows 12 --out .riptide/sim/artifacts/sweep
  sweep collateral_price_drop_bps over 7 value(s) x 4 seed(s)
warning: constant `STATUS_ACCEPTED` is never used
  --> src/flows.rs:94:7
   |
94 | const STATUS_ACCEPTED: u8 = 1;
   |       ^^^^^^^^^^^^^^^
   |
   = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

warning: constant `STATUS_ACCEPTED_PUB` is never used
   --> src/flows.rs:757:11
    |
757 | pub const STATUS_ACCEPTED_PUB: u8 = STATUS_ACCEPTED;
    |           ^^^^^^^^^^^^^^^^^^^

riptide sim iteration=0 seed=5252525252525252525252525252525252525252525252525252525252525252
riptide sim agio collateral_price_drop_bps=0
riptide sim iteration=1 seed=5252525252525252525252525252525252525252525252525352525252525252
riptide sim agio collateral_price_drop_bps=0
riptide sim iteration=2 seed=5252525252525252525252525252525252525252525252525052525252525252
riptide sim agio collateral_price_drop_bps=0
riptide sim iteration=3 seed=5252525252525252525252525252525252525252525252525152525252525252
riptide sim agio collateral_price_drop_bps=0
riptide sim iteration=4 seed=5252525252525252525252525252525252525252525252525652525252525252
riptide sim agio collateral_price_drop_bps=1000
riptide sim iteration=5 seed=5252525252525252525252525252525252525252525252525752525252525252
riptide sim agio collateral_price_drop_bps=1000
riptide sim iteration=6 seed=5252525252525252525252525252525252525252525252525452525252525252
riptide sim agio collateral_price_drop_bps=1000
riptide sim iteration=7 seed=5252525252525252525252525252525252525252525252525552525252525252
riptide sim agio collateral_price_drop_bps=1000
riptide sim iteration=8 seed=5252525252525252525252525252525252525252525252525a52525252525252
riptide sim agio collateral_price_drop_bps=2000
riptide sim iteration=9 seed=5252525252525252525252525252525252525252525252525b52525252525252
riptide sim agio collateral_price_drop_bps=2000
riptide sim iteration=10 seed=5252525252525252525252525252525252525252525252525852525252525252
riptide sim agio collateral_price_drop_bps=2000
riptide sim iteration=11 seed=5252525252525252525252525252525252525252525252525952525252525252
riptide sim agio collateral_price_drop_bps=2000
riptide sim iteration=12 seed=5252525252525252525252525252525252525252525252525e52525252525252
riptide sim agio collateral_price_drop_bps=3000
riptide sim iteration=13 seed=5252525252525252525252525252525252525252525252525f52525252525252
riptide sim agio collateral_price_drop_bps=3000
riptide sim iteration=14 seed=5252525252525252525252525252525252525252525252525c52525252525252
riptide sim agio collateral_price_drop_bps=3000
riptide sim iteration=15 seed=5252525252525252525252525252525252525252525252525d52525252525252
riptide sim agio collateral_price_drop_bps=3000
riptide sim iteration=16 seed=5252525252525252525252525252525252525252525252524252525252525252
riptide sim agio collateral_price_drop_bps=4000
riptide sim iteration=17 seed=5252525252525252525252525252525252525252525252524352525252525252
riptide sim agio collateral_price_drop_bps=4000
riptide sim iteration=18 seed=5252525252525252525252525252525252525252525252524052525252525252
riptide sim agio collateral_price_drop_bps=4000
riptide sim iteration=19 seed=5252525252525252525252525252525252525252525252524152525252525252
riptide sim agio collateral_price_drop_bps=4000
riptide sim iteration=20 seed=5252525252525252525252525252525252525252525252524652525252525252
riptide sim agio collateral_price_drop_bps=5000
riptide sim iteration=21 seed=5252525252525252525252525252525252525252525252524752525252525252
riptide sim agio collateral_price_drop_bps=5000
riptide sim iteration=22 seed=5252525252525252525252525252525252525252525252524452525252525252
riptide sim agio collateral_price_drop_bps=5000
riptide sim iteration=23 seed=5252525252525252525252525252525252525252525252524552525252525252
riptide sim agio collateral_price_drop_bps=5000
riptide sim iteration=24 seed=5252525252525252525252525252525252525252525252524a52525252525252
riptide sim agio collateral_price_drop_bps=6000
riptide sim iteration=25 seed=5252525252525252525252525252525252525252525252524b52525252525252
riptide sim agio collateral_price_drop_bps=6000
riptide sim iteration=26 seed=5252525252525252525252525252525252525252525252524852525252525252
riptide sim agio collateral_price_drop_bps=6000
riptide sim iteration=27 seed=5252525252525252525252525252525252525252525252524952525252525252
riptide sim agio collateral_price_drop_bps=6000
exit: 0
$ cargo metadata --format-version 1 --offline | (riptide-sim manifest paths)
riptide-sim -> /tmp/riptide-t04/agio-repo/.riptide/sim/vendor/riptide-sim/Cargo.toml
riptide-sim-macros -> /tmp/riptide-t04/agio-repo/.riptide/sim/vendor/riptide-sim-macros/Cargo.toml
```

## Step 5 — `riptide sim surface`

```
$ riptide sim surface .riptide/sim/artifacts/sweep --sim .riptide/sim --out .riptide
riptide sim surface: wrote cartography artifacts to /tmp/riptide-t04/agio-repo/.riptide
  campaign-summary.json (id guided-sim-e9b6b620cc6fd896)
  risk-surface.json
  retention-manifest.json
  execution-honesty gates: pass
    ✓ positive_control: positive control collateral_price_drop_bps=0 passed across 4 iteration(s).
    ✓ lifecycle_executed: all 3 declared lifecycle flow(s) executed on-chain.
    ✓ determinism: surface hash recorded for re-verification (sha256 de748996f19bb373…).
  next: riptide assess .riptide
exit: 0
```

## Step 6 — `riptide assess`

```
$ riptide assess .riptide
Assessment generated: collateral_price_drop_bps sweep

Result
  Verdict: needs_campaign_tuning (derived)
  Runs: 28/28 completed, 12 invariant-failed (42.8571%)
  Risk surface: 7/7 cells populated, worst cell 100%, most sensitive `collateral_price_drop_bps`
  Safe region: bounded region at or under 5%
  Execution honesty: pass
    ✓ positive_control
    ✓ lifecycle_executed
    ✓ determinism

Artifacts
  Assessment: .riptide/assessment.json
  Report: .riptide/assessment.md

Hashes
  Assessment digest: 79d97896f3faf542733e2f34f434762b84a4dc165b0635cb1f27a3465c2bd046
  Campaign digest: e9b6b620cc6fd89696689574827a14397a486cc689996042b16c4896dfd28e73
  risk-surface.json sha256: de748996f19bb373ef7afb03152cac0880456b37dd40f59d964271e6a5eec8fa

Next
  riptide review .riptide

Boundary
  Simulation evidence over the campaign's declared, fixed-seed region — not audit signoff, formal verification, complete protocol safety, or a mainnet prediction.

exit: 0
$ ls .riptide
GETTING-STARTED.md
adapters
assessment.json
assessment.md
campaign-summary.json
retention-manifest.json
risk-surface.json
sim
```

## Verdict

Every step succeeded with the monorepo unresolvable: the generated crate built
against the vendored runtime (`vendor/riptide-sim`, `vendor/riptide-sim-macros`),
the 7×4 sweep completed 28/28 iterations, and `riptide assess` rendered the
cartography report with all three execution-honesty gates passing
(positive_control, lifecycle_executed, determinism). The sandbox reproduces the
known Agio gradient: 12/28 invariant-failed (42.8571%), bad-debt onset between
3000 and 4000 bps collateral crash.

One CLI fix was required and is part of this change set: `sim generate` now
resolves `idl_path` / `program_so` with the same repo-root fallback the adapter
validator uses, so canonical `.riptide/adapters/` adapters generate in a fresh
repo (previously adapter-dir-relative only, which failed cold).

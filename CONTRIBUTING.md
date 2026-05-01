# Contributing to Riptide

Thanks for contributing to Riptide! This guide covers everything you need: setting up your dev environment, understanding the architecture, deciding what to build, and getting your PR merged.

Riptide is a protocol-agnostic economic simulator for Solana programs. Every shipping bundle — lending, perps, AMM, liquid staking, and stablecoin today; whatever ships next — layers the same **six-layer stack** on top of the program under test:

1. **Adapter** — one TOML declaring the program, its actions, observations, and invariants.
2. **Personas** — TOML files describing agent behavior with a trigger DSL.
3. **Scenarios** — engine shocks (oracle trajectories, scheduled actions) mounted from declarative presets.
4. **Parameters** — run-config knobs that sweep over the dimensions that matter.
5. **Failure-mode taxonomy** — named categories (`whale_concentration`, `margin_cascade_from_oracle_shock`, `price_manipulation_via_swap`, `impermanent_loss_spike`, …) the scenarios skill matches against adapter shape.
6. **Invariants** — machine-checkable properties declared inline in the adapter. The engine exits non-zero when any invariant fires.

The growth rhythm is: one new protocol class per bundle, shipped as all six layers rather than as a new trait in the engine. Adding a new protocol class should mean writing TOML and extending a skill prompt — **not** reshaping the engine. That rhythm is load-bearing; preserve it.

---

## Contribution Priorities

We value contributions in this order:

1. **Determinism regressions** — any change that flips a byte-stable hash without a conscious retune is top priority to fix. Riptide's whole adversarial-review posture rests on determinism. See [Determinism & Regression Gates](#determinism--regression-gates).
2. **Bug fixes** — crashes, incorrect behavior, data loss. Always near-top priority.
3. **New adapters** — new Solana programs wired into the six-layer stack. This is the primary growth path.
4. **New personas** — new adversarial archetypes that compose against existing adapters.
5. **New failure-mode taxonomy categories** — new named categories the `riptide-scenarios` skill can classify and propose against.
6. **Skill improvements** — sharpening `riptide-adapt`, `riptide-harness`, `riptide-scenarios`, or `riptide-narrative` so they produce better artifacts in cold-read evaluation.
7. **Documentation** — fixes, clarifications, new examples.
8. **Engine changes** — rare and carefully scoped. See [Touching Engine Code](#touching-engine-code).

---

## What am I adding? — Decision tree

This is the most common question for new contributors. Most contributions are *not* engine changes.

### Make it an **Adapter** when

- You want Riptide to run against a specific Solana program (yours, a fork, a public one).
- The existing adapter patterns (`lending.toml`, `perpetuals.toml`, `amm.toml`, `liquid-staking.toml`, `stablecoin.toml`, `resource-grinder.toml`) come close — you copy one, swap the IDL + accounts + actions + observations + invariants.
- See [Adding an Adapter](#adding-an-adapter).

### Make it a **Persona** when

- You want a new adversarial archetype that fires actions against *existing* adapters.
- The behavior can be expressed in the trigger DSL (single comparison + constant per rule today — e.g., `observation.utilization > 0.9 → withdraw_all`).
- Examples: `whale-depositor`, `leveraged-long`, `sandwich-attacker`, `arbitrageur`, `rug-puller`.
- See [Adding a Persona](#adding-a-persona).

### Make it a **Taxonomy Category** when

- You want the `riptide-scenarios` skill to classify a new failure mode and propose experiments targeting it.
- It's named after *what fails* (`price_manipulation_via_swap`), not *how it fails* (`sandwich`).
- Needs an adapter-shape hook (what action/observation/invariant keys trigger it) and an IDL hook (what instruction names trigger it), so it fires on its protocol class and stays quiet on the others.
- See [Adding a Taxonomy Category](#adding-a-taxonomy-category).

### Modify a **Skill** when

- You want to sharpen `riptide-adapt` (adapter generation), `riptide-harness` (pre-tick-0 Rust setup), `riptide-scenarios` (classification / proposal), or `riptide-narrative` (post-run report).
- Skills are session-native instructions plus optional prompts/references/helper scripts. They live in `skills/riptide-*/` with a `SKILL.md` and any supporting `prompts/` or `references/` files.
- See [Modifying a Skill](#modifying-a-skill).

### Touch **engine code** only when

- A new capability genuinely cannot be declared in TOML or expressed as a skill prompt (rare — historically, replay mode was the last such unlock).
- You've checked with a maintainer first. Engine changes ship with determinism regression risk attached.
- See [Touching Engine Code](#touching-engine-code).

---

## Development Setup

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Git** | — |
| **Linux** | Primary supported OS (macOS is untested; Windows is out of scope) |
| **Rust** | Stable channel (see [`TOOLCHAIN.md`](TOOLCHAIN.md) for exact pins) |
| **Node.js 18+** | For the CLI wrapper |
| **`cargo-build-sbf`** | For compiling on-chain programs — install via the [Anza tooling installer](https://docs.anza.xyz/cli/install) |

### Clone and install

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
./install.sh
```

The installer detects missing toolchains and prints actionable hints rather than auto-installing. See [`docs/install.md`](docs/install.md) for the full flow and from-source alternatives.

### Verify

```bash
# Canonical smoke: the shipping hero-grid cell
riptide run lending/hero-grid/w25-s40

# Regression gate (engine suites)
cargo test -p riptide-engine

# Regression gate (CLI suite)
(cd cli && npm test)
```

If all three are green, your environment is good.

### Testing against your own Anchor program

Contributors developing adapters against their own Anchor repos (rather than working on Riptide itself) should use the drop-in path — run `riptide init` inside your Anchor repo to scaffold `.riptide/` with an adapter stub and getting-started guide, fill in the adapter TODOs, add your own scenarios under `.riptide/scenarios/`, and then `riptide run` to execute them. See [`docs/install.md`](docs/install.md#next-steps-after-install) for the full walkthrough. The monorepo path above stays as the authoritative workflow for contributors working on Riptide itself (engine, CLI, or the shipping bundles).

---

## Project Structure

```
riptide/
├── engine/                       # Rust simulation engine
│   ├── src/
│   │   ├── primitive/            # Primitive traits — LendingPrimitive, AmmPrimitive, GenericPrimitive harness
│   │   ├── adapter/              # Adapter TOML serde loader (the Rust-side schema truth)
│   │   ├── scenario/             # Scenario engine, oracle trajectories, preset_spec
│   │   ├── replay/               # Historical replay module
│   │   ├── invariant/            # Invariant evaluation + CI exit codes
│   │   └── main.rs               # Engine binary entry
│   └── tests/                    # Integration tests (litesvm_parity, e2e_determinism, roundtrips)
│
├── cli/                          # TypeScript CLI wrapper
│   ├── src/
│   │   ├── commands/             # run, replay, adapt, serve entry points
│   │   ├── schemas/              # Zod mirrors of the serde schemas (adapter, run-config, persona)
│   │   ├── compiler/             # Persona compilation pipeline
│   │   ├── serve/                # Dashboard HTTP server + asset pipeline
│   │   └── adapt/                # Smoke-test harness invoked by the riptide-adapt skill
│   ├── assets/dashboard.html     # Inlined single-page dashboard template
│   └── package.json
│
├── programs/                     # Standalone SBF crates (built out of the root workspace)
│   ├── lending_pool/             # Forked Solend SPL-Token-Lending pool
│   ├── perpetuals/               # Minimal perps-lite program
│   ├── amm/                 # Constant-product x*y=k pool
│   ├── liquid-staking/      # Minimal pooled-stake / withdrawal-queue LST surface
│   ├── stablecoin/          # Minimal collateral / stable-supply / redemption-queue surface + apply_hedge_loss stress mutation
│   ├── resource_grinder/         # Non-DeFi toy program proving the generic path
│   └── admin_mock_oracle/        # Shared-oracle helper for perps + liquid staking + stablecoin
│
├── fixtures/
│   ├── adapters/                 # Adapter TOMLs (lending, perpetuals, amm, liquid-staking, stablecoin, resource-grinder)
│   ├── personas/                 # Persona TOMLs (whale, leveraged-long, arbitrageur, stablecoin/*, …)
│   ├── scenarios/                # Run-config bundles per-adapter per-experiment
│   ├── replays/                  # Failure-shape replay fixtures (lending-whale-bad-debt, liquid-staking-*, stablecoin-uxd-style-collateral-cascade)
│   ├── idls/                     # Anchor IDL JSONs for each shipped program
│   └── oracle_state_golden.bin   # Byte-layout SSOT for oracle state
│
├── skills/                       # Claude Code skills (self-contained, session-native)
│   ├── riptide-adapt/            # Adapter generation from IDL
│   ├── riptide-harness/          # Rust pre-tick-0 setup harness authoring
│   ├── riptide-scenarios/        # Failure-mode classification + experiment proposal
│   └── riptide-narrative/        # Post-run narrative report
│
├── demo/                         # Canonical demo (safe-vs-risky lending side-by-side)
├── scripts/                      # Helper scripts (agent-scaling-benchmark, amm-scratch, etc.)
├── docs/                         # User-facing documentation
└── TOOLCHAIN.md                  # Exact toolchain pins — engine, programs, CI, Docker all anchor here
```

---

## Core Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full explanation. Short version:

- **Two processes:** Rust engine + TypeScript CLI. The CLI pre-validates TOML with Zod, compiles personas, then shells out to the release-build engine binary. The engine loads the adapter, boots LiteSVM, deploys the pinned `.so`, ticks the scenario, writes `simulation-result.json`.
- **Schemas mirror:** the Zod schema (CLI) and the serde schema (engine) describe the same TOML shapes. When they drift, serde is the canonical truth and the Zod side is the bug to fix.
- **LiteSVM is the default runtime.** `solana-test-validator` lives as a diagnostic parity path gated on `RIPTIDE_RUN_VALIDATOR_TESTS=1`.
- **Determinism is enforced by test.** `engine/tests/e2e_determinism.rs` runs every fixture twice and asserts byte-identical JSON output. See [Determinism & Regression Gates](#determinism--regression-gates).

---

## Code Style

**Rust:**
- Standard `rustfmt` and `clippy` hygiene.
- Avoid `unwrap()` in library code; prefer `?` with context, or `expect("load-bearing reason")` when a failure is structural.
- Error handling: the engine is a batch process, so fail fast with a clear error surface. Don't silently degrade.

**TypeScript:**
- Strict mode. The CLI ships `tsconfig.json` with strict flags on — keep them on.
- Error handling at boundaries: CLI validation produces friendly messages for end users; engine invocations surface engine exit codes verbatim.

**Both:**
- **Comments are for the non-obvious.** Don't narrate what the code does; the identifier already did. Explain *why* a non-obvious choice is made, a hidden invariant, a workaround for a specific bug.
- **No dead code.** Feature flags, fallback paths for hypothetical futures, commented-out blocks — delete them.
- **Cross-platform posture:** Linux is the supported path. Don't add macOS- or Windows-specific branches speculatively; flag platform concerns in the PR description if they come up.

---

## Adding an Adapter

An adapter wires a specific Solana program into the engine.

1. **Compile your program to `.so`** and get its Anchor IDL (or a hand-written IDL JSON).
2. **Generate or hand-write the adapter TOML:**
   - *Skill path:* install the `riptide-adapt` Claude Code skill (`skills/riptide-adapt/SKILL.md`). Invoke it in-session pointing at your program source or IDL. The skill reads the program, classifies it against the primitive library (lending / perps / AMM / generic), writes the adapter TOML, and runs `riptide adapt` as a smoke test. No API keys or endpoint config.
   - *Hand-written path:* copy the closest shipping adapter from `fixtures/adapters/` (`lending.toml`, `perpetuals.toml`, `amm.toml`, `liquid-staking.toml`, `stablecoin.toml`, or `resource-grinder.toml`) and edit `program_so`, `[[accounts]]`, `[[actions]]`, `[[observations]]`, and `[[invariants]]`.
3. **Wire an oracle if the program needs one.** A generic adapter can declare a single `[[oracles]]` block bound to a `kind = "shared"` account. The harness bootstraps that account at tick 0 with admin-mock bytes and mutates it on every scenario/replay oracle update. The bound account can optionally declare `owner = { program_so = "<path>.so" }` (owner resolved from the companion `target/deploy/<name>-keypair.json`) for sibling-owned oracles such as `admin_mock_oracle`, or `owner = { pubkey = "<base58>" }` for a literal external owner. Omit `owner` and the simulated program owns the account. See [`docs/architecture.md#oracle-binding-for-generic-adapters`](docs/architecture.md#oracle-binding-for-generic-adapters) and the end-to-end proof at `engine/tests/perpetuals_sibling_oracle_proof.rs`. Two or more `[[oracles]]` entries on a generic adapter is currently a loader error — multi-oracle generic semantics remain a follow-up.
4. **Smoke-test it:** `riptide adapt --adapter fixtures/adapters/<your-adapter>.toml` — confirms the engine boots it and observes a state delta.
5. **Add harness setup if zeroed accounts are not enough.** Use the `riptide-harness` skill or run `riptide harness generate --adapter <adapter>` and edit `.riptide/harness/src/main.rs` for SPL mints/vaults, PDAs, sibling programs, and concrete account bytes.
6. **Commit** the adapter under `fixtures/adapters/` and the IDL under `fixtures/idls/`.

The adapter is the contract between your program and the six-layer stack. Keep it declarative — anything that can't be expressed in TOML is a signal that the engine needs a new capability, which is a separate (and rarer) PR.

---

## Adding a Persona

Personas are pure TOML — one file per persona in `fixtures/personas/`.

1. **Copy the closest existing persona:** `whale.toml` for lending, `leveraged-long.toml` for perps, `arbitrageur.toml` for AMM.
2. **Edit the trigger DSL and action block.** Single comparison op + constant per rule today (e.g., `observation.utilization > 0.9 → withdraw_all`). Reference only your adapter's declared actions.
3. **Smoke-test it** by running a small scratch simulation (see `scripts/amm-scratch.sh` for the pattern). A persona TOML that parses clean and emits at least one action per tick against its adapter is ready to ship.
4. **Compose it** into a scenario under `fixtures/scenarios/<adapter>/<experiment>/`, or let `riptide-scenarios` reference it.

Personas stay composable by staying small. If a persona needs branching control flow, it's probably two personas.

---

## Adding a Taxonomy Category

Taxonomy lives in `skills/riptide-scenarios/prompts/classify.md` (discrimination) and `skills/riptide-scenarios/prompts/propose.md` (experiment templates).

1. **Add the discrimination rule** in `classify.md`. Each rule needs:
   - an **adapter-shape hook** — what `[actions]` / `[observations]` / `[[invariants]]` keys trigger it
   - an **IDL hook** — what instruction names trigger it
   So the classifier fires on the intended adapter class and stays quiet on the others.
2. **Add a proposal template** in `propose.md`. Minimum a 1D sweep; ideally a 2D grid with full-cell materialization (see `whale-shock-grid`, `depositor-shock-grid`, `trade-size-volume-grid` for the pattern — every grid cell is a complete bootable sub-scenario).
3. **Extend the Zod enum** in `cli/src/scenarios/validate.ts` with your new `failure_mode` value so `riptide scenarios --validate` accepts configs that reference it.
4. **Run the cold-chain validation flow** (three-session pattern — setup → cold test → scoring) against your adapter and record the verdict under `docs/case-studies/` or `Obsidian Vault/Riptide/Experiments/` as the shipping bundles did.

Taxonomy is where Riptide's discrimination power lives. A good category fires precisely on its class and explains itself to the next reader — resist generic categories.

---

## Modifying a Skill

Skills are self-contained Claude Code session artifacts under `skills/riptide-*/`:

```
skills/riptide-<name>/
├── SKILL.md            # Entry instructions + metadata frontmatter
└── prompts/
    ├── <prompt-1>.md   # Referenced from SKILL.md
    └── <prompt-2>.md
```

When modifying a skill:

1. **Run the existing flow cold** before editing — observe the artifact the skill currently produces. Many "this prompt is broken" instincts are actually about a specific cell in the prompt's decision tree; pin that down first.
2. **Edit the prompt** in `prompts/<name>.md`. Skills are pure markdown — no Python, no JS — so changes are immediate.
3. **Re-run cold against the same input.** Compare artifacts. If the new artifact is clearly better on a cold read, ship it. If it's ambiguous, iterate.
4. **Test across adapters** (lending, perps, AMM, generic) to confirm the change doesn't regress the existing protocol classes while fixing the new one.

Skills are load-bearing for adapter generation, scenario proposal, and narrative reports — cold-read testing is the acceptance bar, not passing tests.

---

## Touching Engine Code

Engine changes are rare. If you're about to write one, stop and ask:

- **Can this be expressed in adapter TOML?** (Most "missing feature" instincts turn out to be expressible.)
- **Can this be expressed as a skill-prompt extension?**
- **Is this a genuinely new engine capability?** If yes — good, write it, but:
  - It ships with its own integration test in `engine/tests/`.
  - It must preserve the `e2e_determinism` regression.
  - It does not break the three byte-stable hashes shipped today (Solend-fork hero-grid `w25-s40`, perpetuals scratch, AMM-fork scratch — see [Determinism & Regression Gates](#determinism--regression-gates)).
  - It updates `docs/architecture.md` if the change touches a documented pattern.

Engine changes that break determinism without a conscious retune are the top-priority reverts.

---

## Cross-Platform Compatibility

**Linux is the supported path.** The installer, Docker image, and CI all target Linux. macOS is untested; Windows is explicitly out of scope.

When writing code that touches the OS:

- Use `pathlib` / `std::path::Path` idioms; avoid hard-coded separators.
- Any shell command in `install.sh` must be POSIX-sh-compatible.
- If you touch the Dockerfile, verify the build from a clean context — the multi-stage split is load-bearing for image size (280 MB today).

If a contribution specifically adds macOS support, that's welcome, but it comes with the responsibility of running the regression gates on macOS before merge.

---

## Determinism & Regression Gates

**This is the single most important discipline in the project.** Every shipping fixture is byte-stable. The engine asserts determinism on every `cargo test` run via the `e2e_determinism` integration test. Any change that flips a hash without a conscious retune is a regression.

Before opening a PR, make sure the regression floor is green:

```bash
# Engine-side determinism + parity + roundtrip gates
cargo test -p riptide-engine --test litesvm_parity
cargo test -p riptide-engine --test e2e_determinism
cargo test -p riptide-engine --test perpetuals_roundtrip
cargo test -p riptide-engine --test amm_roundtrip
cargo test -p riptide-engine --test liquid_staking_roundtrip
cargo test -p riptide-engine --test stablecoin_roundtrip
cargo test -p riptide-engine --test replay_framework
cargo test -p riptide-engine --test replay_lending_whale_bad_debt
cargo test -p riptide-engine --test replay_liquid_staking_depeg_redemption_run
cargo test -p riptide-engine --test replay_liquid_staking_slash_with_open_queue
cargo test -p riptide-engine --test replay_stablecoin_uxd_style_collateral_cascade

# CLI suite
(cd cli && npm test)
```

**Byte-stable fixtures that must not drift:**

| Fixture | sha256 |
|---------|--------|
| Solend-fork hero-grid `w25-s40` | `89ca84209f3423c317e6be96f14261a9ebed7a9668398a08087a25631b782a11` |
| Perps-fork scratch | `1518bcfdeb6cdb7d538be86584195b4b348b73beed610003d4a35939994f1878` |
| AMM-fork scratch | `5de060cdcacfbacaa598a387a9f249e7633fedac449f137d62c0ede9cf10624f` |
| Liquid-staking depeg + redemption-run replay (canonical `result_sha256`) | see `fixtures/replays/liquid-staking-depeg-redemption-run/expected-summary.json` |
| Liquid-staking slash-with-open-queue replay (canonical `result_sha256`) | see `fixtures/replays/liquid-staking-slash-with-open-queue/expected-summary.json` |
| Stablecoin UXD-style collateral-cascade replay (canonical `result_sha256`) | `2f61c0a7cfd592b0e625060ddc076cccb62093a1f0d5b5779fc8f548f7c2f2bf` (pinned in `fixtures/replays/stablecoin-uxd-style-collateral-cascade/expected-summary.json`) |

If your PR flips any of these, include the conscious-retune justification in the PR description — why the new bytes are correct, what changed in the adapter / scenario / engine that causes the shift, and why the old hash is no longer load-bearing.

---

## Pull Request Process

### Branch naming

```
fix/description        # Bug fixes
feat/description       # New features
adapter/<protocol>     # New adapters
persona/<name>         # New personas
taxonomy/<category>    # New taxonomy categories
skill/<name>           # Skill prompt changes
docs/description       # Documentation
```

### Before submitting

1. **Run the regression gates** (see [Determinism & Regression Gates](#determinism--regression-gates)).
2. **Test manually:** run the shipping demo (`riptide run lending/hero-grid/w25-s40`) and confirm the hash is unchanged.
3. **Keep PRs focused.** One logical change per PR. Don't mix an adapter addition with a skill rewrite.
4. **Scrub for sprint numbers + internal task IDs.** Nothing user-facing should carry internal sprint/phase references.

### PR description

Include:
- **What** changed and **why**.
- **Which of the six layers** your change touches (adapter / persona / scenario / parameter / taxonomy / invariant / engine).
- **Regression-gate output** (paste the test counts + the three byte-stable hashes).
- **Manual-test steps** — how a reviewer reproduces the outcome.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

| Type | Use for |
|------|---------|
| `fix` | Bug fixes |
| `feat` | New features (including new adapters, personas, taxonomy categories) |
| `docs` | Documentation |
| `test` | Tests |
| `refactor` | Code restructuring (no behavior change) |
| `chore` | Build, CI, dependency updates |

Scopes: `engine`, `cli`, `adapter`, `persona`, `taxonomy`, `skill`, `docs`, `install`, `dockerfile`, etc.

Examples:
```
feat(adapter): add stablecoin adapter + 4-persona library
fix(engine): preserve determinism when liquidation cascade reorders events
docs(architecture): clarify LiteSVM-vs-validator parity path
feat(skill): extend riptide-scenarios classify.md with impermanent_loss_spike
```

---

## Reporting Issues

- Use [GitHub Issues](https://github.com/riptidesim/riptide/issues).
- Include: OS, Rust + Node versions, exact command that failed, full error output.
- Include a minimal reproduction — adapter TOML + run-config that triggers the issue.
- For determinism regressions: include the expected hash and the actual hash from your machine.

---

## Community

- **Issues / Discussions:** [github.com/riptidesim/riptide](https://github.com/riptidesim/riptide) — questions, proposals, showcases.
- **Case studies:** Non-trivial adapter + taxonomy contributions are candidates for the `docs/case-studies/` shelf. If you've run a cold-chain validation on your new bundle, we want to see it.

---

## License

By contributing, you agree that your contributions will be licensed under both the [MIT License](LICENSE) and the [Apache License 2.0](LICENSE) at the recipient's option.

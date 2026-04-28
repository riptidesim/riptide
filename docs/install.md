# Install

**Purpose:** How to install, build, upgrade, and sanity-check Riptide on Linux.

**Audience:** first-time users on Linux who want `riptide` on their `$PATH`, plus contributors who need the from-source recipe.

Linux is the supported path. macOS is not tested — steps are POSIX-ish and may work, but nothing here is validated on Darwin. Windows is explicitly out of scope.

## Release install — public path

```bash
curl -fsSL https://riptide.run/install | sh
```

The release installer is [`../scripts/install-release.sh`](../scripts/install-release.sh). It downloads a prebuilt GitHub Release bundle for the current platform, verifies the bundle's `.sha256`, unpacks it under `$XDG_DATA_HOME/riptide/current` (or `$HOME/.local/share/riptide/current`), and installs a small `riptide` launcher into `$HOME/.local/bin`.

This path is the intended first-run install once public release assets are cut. It does **not** require Rust, Node, npm, Solana CLI, or `cargo-build-sbf` on the user's machine; the bundle carries the compiled TypeScript CLI, a pinned Node runtime, the native `riptide-engine` binary, fixtures, examples, shipped `.so` artifacts, and the generated fixture deploy keypairs required by owner-aware shipped adapters.

Useful options:

```bash
curl -fsSL https://riptide.run/install | sh -s -- --version 0.6.0
curl -fsSL https://riptide.run/install | sh -s -- --bin-dir "$HOME/bin"
curl -fsSL https://riptide.run/install | sh -s -- --dry-run
```

Release bundles are produced by [`../scripts/package-release.sh`](../scripts/package-release.sh). The first Linux x86_64 artifact contract is:

```text
riptide-x86_64-unknown-linux-gnu.tar.gz
riptide-x86_64-unknown-linux-gnu.tar.gz.sha256
```

Those files should be attached to the matching GitHub Release tag. The hosted `https://riptide.run/install` endpoint can serve the installer script directly from this repository.

## `install.sh` — from-source path

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
./install.sh
```

The script runs eight steps, each with a banner and a clear failure hint if something goes wrong. It (1) detects Rust, Cargo, Node, npm, and `cargo-build-sbf`, printing an actionable install command for anything missing; (2) builds the release engine (`cargo build --release -p riptide-engine`); (3) builds the shipped on-chain programs (`lending_pool.so`, `resource_grinder.so`, `admin_mock_oracle.so`, `stablecoin.so`) via `cargo build-sbf`; (4) `npm install --ignore-scripts`s the CLI so the npm postinstall downloader does not fetch a release binary during source installs; (5) `npm run build`s it; (6) installs a bash shim at `$HOME/.local/bin/riptide` that execs Node against the compiled CLI entry point; (7) runs a lending smoke test (`riptide run examples/configs/safe.json --adapter fixtures/adapters/lending.toml`); (8) runs a generic-adapter smoke test against `resource-grinder`.

The source installer is idempotent — rerunning it on an unchanged tree is safe and fast (cargo and npm handle their own incremental builds, the launcher is rewritten in place). It never uses sudo; missing toolchains produce a hint, not an install attempt. If `$HOME/.local/bin` is not on your `$PATH` it warns and prints the exact `export` line to add to your shell rc.

## Docker — the pinned image

```bash
docker build -t riptide .
docker run --rm riptide run lending/hero-grid/w25-s40
```

The multi-stage `Dockerfile` pins the full toolchain via sha256 digests: `rust:1.91.1-bookworm`, `node:24.11.1-bookworm-slim`, the Node tarball, and the Anza installer. The build stage compiles the engine, the CLI, and all five on-chain programs (`lending_pool`, `resource_grinder`, `admin_mock_oracle`, `perpetuals`, `amm`). The runtime stage mirrors the `/src/` layout so every adapter's relative `program_so` path resolves without overrides, ships the `.so` artifacts (never the matching keypairs — the LiteSVM runtime does not need them), and wires `riptide` as the ENTRYPOINT. See `Dockerfile` for the full comment trail on why each pin is where it is.

## From source

When you need to rebuild a single piece without running `install.sh`:

```bash
# Engine only
cargo build --release -p riptide-engine

# A single on-chain program (repeat for each program as needed)
cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml

# CLI
(cd cli && npm install --no-audit --no-fund --ignore-scripts && npm run build)
```

The engine's `env!("CARGO_MANIFEST_DIR")` bakes `/src/engine` (in Docker) or your repo path (locally), so the default lending `.so` lookup resolves relative to the crate root. Adapter TOMLs use relative paths that assume the repo layout — if you move `programs/` or `fixtures/`, adapters need their `program_so` updated. See [`../TOOLCHAIN.md`](../TOOLCHAIN.md) for the exact Rust, Solana CLI, `cargo-build-sbf`, platform-tools, and Node pins the Dockerfile and CI are locked to, plus the repo-local `vendor/` patches that freeze the SBF crate graph at a band the bundled SBF rustc can compile.

## Distribution posture — honest note

GHCR, crates.io, npm, and the release-bundle installer are wired up in repo tooling, but public release assets have not been published yet. Build-from-source via `install.sh` and local `docker build` are the supported paths today. `@riptide/cli`'s postinstall binary downloader and `scripts/install-release.sh` both expect GitHub Release artifacts that are not yet cut. When a release is published this page will point at the public install path.

## Next steps after install

Once `riptide` is on your `$PATH`, the canonical first run is **install → doctor → init → adapt/run**.

```bash
riptide doctor
```

`riptide doctor` is a static diagnostic — no build, no network, no simulation. It probes the documented toolchain surface (`node`, `npm`, `rustc`, `cargo`, `solana`, `cargo-build-sbf`), resolves the `riptide-engine` binary via `RIPTIDE_ENGINE_BIN` or the repo's `target/release/` tree, walks any adapters under `.riptide/adapters/` or the monorepo's `fixtures/adapters/`, and prints a compact pass / warn / fail table with a one-line next-step hint on any non-pass row. Exit codes are `0` all-pass, `1` warnings only, `2` at least one failure — jest-style semantics so CI wrappers can gate on it without extra shell logic. It is deliberately fast and it will never secretly build, lint-fix, or run a scenario for you.

```bash
cd ~/path/to/your-anchor-program
riptide init
```

`riptide init` scaffolds a `.riptide/` working directory in the current repo: an adapter stub at `.riptide/adapters/<program-name>.toml` (with TODO comments pointing at `target/deploy/*.so` + `target/idl/*.json`), three starter personas under `.riptide/personas/`, a minimum-viable `.riptide/scenarios/baseline/run-config.json`, and an inline `GETTING-STARTED.md` one-screen guide. Check the tree into git alongside your program source — the `.riptide/` convention is the shipping contract.

Fill in the adapter stub — the TODO comments name every block that needs editing — then static-check it against its IDL and run:

```bash
riptide lint <program-name>              # Static validation against the JSON IDL named in [lineage].idl_source
riptide adapt --adapter .riptide/adapters/<program-name>.toml   # End-to-end smoke (lint preflight runs first when JSON IDL lineage is present)
riptide run --serve
```

`riptide lint` machine-validates an adapter against its IDL only when `[lineage].idl_source` points at a JSON IDL — mapped instructions, args, accounts, and `account.field` references must all resolve in the IDL, and positive mismatches fail loudly (exit 2). When the lineage source is a non-JSON file (for example `programs/<name>/src/state.rs`) or the adapter has no `[lineage]` block at all, lint prints an explicit `WARN` / `SKIP` and exits `1`/`0` — it does **not** silently claim PASS. See [`adapter-lineage.md`](adapter-lineage.md) for the honest boundary between inspection and machine validation. `riptide adapt` reuses the same linter as a preflight: when machine-checkable lineage is present, adapt runs lint first and aborts before engine spawn on any concrete fail.

With no positional argument, `riptide run` discovers every `.riptide/scenarios/**/run-config.json` and executes them sequentially, printing a jest-style pass/fail summary. Each scenario line includes a run verdict (`failure-observed`, `no-failure-observed`, `inconclusive`, or `setup-error`), confidence, and coverage classification derived from coverage checks over ticks, events, state movement, invariants, agents, and artifact readability. The sweep writes `.riptide/run-collection.json` with totals by status, verdict, and coverage plus per-scenario artifact paths. `--serve` starts a collection-aware dashboard at `localhost:4173` so you can review every selected scenario from the sweep, then drill into metrics, events, invariant rows, evidence, and next action for the selected scenario. This is simulation evidence for the declared run, not audit signoff and not a safety verdict.

For running against the repo's shipping bundles from a clone of the Riptide monorepo, the same short-form invocation works — `.riptide/scenarios/` is a symlink to `fixtures/scenarios/` at the repo root, so discovery picks up the shipping hero-grid + perps + AMM + replay fixtures automatically:

```bash
riptide run lending/hero-grid/w25-s40 --serve
```

The full-path form (`riptide run fixtures/scenarios/<path>/run-config.json`) also still works for CI and scripts that already reference those paths.

If you want Claude Code to accelerate the adapter-filling step, install the `riptide-adapt` skill under `skills/riptide-adapt/` and invoke it in-session pointing at your program source — it reads the IDL, generates the adapter TOML, and runs `riptide adapt` as a smoke test. Orthogonal to `riptide init`; either path alone is supported.

## Upgrade path

```bash
git pull
./install.sh
```

Rerunning `install.sh` after a pull is the supported upgrade. Cargo and npm fast-forward their incremental builds; the launcher is rewritten in place. When CLI changes land, the CLI rebuild is enough. When engine changes land, the engine rebuilds. When on-chain program sources change, rerun `cargo build-sbf` for that program (or rerun `install.sh`, which rebuilds all three shipped programs). If a `TOOLCHAIN.md` pin changes — Rust, Solana CLI, Node — update the host toolchain first, then rerun `install.sh`.

## Further reading

- [`architecture.md`](architecture.md) — what you just installed, and how the pieces fit.
- [`vision.md`](vision.md) — the stance the engine commits to.
- [`../TOOLCHAIN.md`](../TOOLCHAIN.md) — pinned toolchain versions and the LiteSVM benchmark + validator-parity run commands.

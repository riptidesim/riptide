# Install

**Purpose:** How to install, build, upgrade, and sanity-check Riptide on Linux.

**Audience:** first-time users on Linux who want `riptide` on their `$PATH` from a fresh clone, plus contributors who need the from-source recipe.

Linux is the supported path. macOS is not tested — steps are POSIX-ish and may work, but nothing here is validated on Darwin. Windows is explicitly out of scope.

## `install.sh` — the one-command path

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
./install.sh
```

The script runs eight steps, each with a banner and a clear failure hint if something goes wrong. It (1) detects Rust, Cargo, Node, npm, and `cargo-build-sbf`, printing an actionable install command for anything missing; (2) builds the release engine (`cargo build --release -p riptide-engine`); (3) builds the three shipped on-chain programs (`lending_pool.so`, `resource_grinder.so`, `admin_mock_oracle.so`) via `cargo build-sbf`; (4) `npm install`s the CLI; (5) `npm run build`s it; (6) installs a bash shim at `$HOME/.local/bin/riptide` that execs Node against the compiled CLI entry point; (7) runs a lending smoke test (`riptide run examples/configs/safe.json`); (8) runs a generic-adapter smoke test against `resource-grinder`.

The script is idempotent — rerunning it on an unchanged tree is safe and fast (cargo and npm handle their own incremental builds, the launcher is rewritten in place). It never uses sudo; missing toolchains produce a hint, not an install attempt. If `$HOME/.local/bin` is not on your `$PATH` it warns and prints the exact `export` line to add to your shell rc.

## Docker — the pinned image

```bash
docker build -t riptide .
docker run --rm riptide run fixtures/scenarios/solend-fork/hero-grid/w25-s40/run-config.json
```

The multi-stage `Dockerfile` pins the full toolchain via sha256 digests: `rust:1.91.1-bookworm`, `node:24.11.1-bookworm-slim`, the Node tarball, and the Anza installer. The build stage compiles the engine, the CLI, and all five on-chain programs (`lending_pool`, `resource_grinder`, `admin_mock_oracle`, `perps-fork`, `amm-fork`). The runtime stage mirrors the `/src/` layout so every adapter's relative `program_so` path resolves without overrides, ships the `.so` artifacts (never the matching keypairs — the LiteSVM runtime does not need them), and wires `riptide` as the ENTRYPOINT. See `Dockerfile` for the full comment trail on why each pin is where it is.

## From source

When you need to rebuild a single piece without running `install.sh`:

```bash
# Engine only
cargo build --release -p riptide-engine

# A single on-chain program (repeat for each program as needed)
cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml

# CLI
(cd cli && npm install --no-audit --no-fund && npm run build)
```

The engine's `env!("CARGO_MANIFEST_DIR")` bakes `/src/engine` (in Docker) or your repo path (locally), so the default lending `.so` lookup resolves relative to the crate root. Adapter TOMLs use relative paths that assume the repo layout — if you move `programs/` or `fixtures/`, adapters need their `program_so` updated. See [`../TOOLCHAIN.md`](../TOOLCHAIN.md) for the exact Rust, Solana CLI, `cargo-build-sbf`, platform-tools, and Node pins the Dockerfile and CI are locked to, plus the repo-local `vendor/` patches that freeze the SBF crate graph at a band the bundled SBF rustc can compile.

## Distribution posture — honest note

GHCR, crates.io, and npm registries are wired up in release tooling and dry-run-verified, but not yet published. Build-from-source via `install.sh` and local `docker build` are the supported paths today. `@riptide/cli`'s postinstall binary downloader expects a GitHub Release artifact that is not yet cut, so `npm install -g` from a public registry will not work in this sprint — use `install.sh` or the Docker image instead. When a release is published this page will point at it.

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

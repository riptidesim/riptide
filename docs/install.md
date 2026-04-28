# Install

**Supported path:** Linux. macOS may work from source but is not validated. Windows is out of scope today.

Riptide currently installs from a source checkout or a local Docker build. The public release installer, GHCR image, crates.io package, and npm package are prepared in repo tooling but not published yet.

## Release Install

```bash
curl -fsSL https://riptide.run/install | sh
```

This is the intended public path once the first GitHub Release assets are cut. The installer script lives at [`../scripts/install-release.sh`](../scripts/install-release.sh): it downloads a prebuilt bundle for the current platform, verifies the bundle `.sha256`, unpacks it under `$XDG_DATA_HOME/riptide/current` or `$HOME/.local/share/riptide/current`, and writes a `riptide` launcher to `$HOME/.local/bin`.

The release bundle does not require Rust, Node.js, npm, Solana CLI, or `cargo-build-sbf` on the user's machine. It carries the compiled TypeScript CLI, pinned Node runtime, native `riptide-engine` binary, fixtures, examples, shipped `.so` artifacts, and generated fixture deploy keypairs required by owner-aware shipped adapters.

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

Those files should be attached to the matching GitHub Release tag. Until that happens, use the source install or Docker path below.

## Prerequisites

Required on your `PATH` for source installs:

- Rust and Cargo
- Node.js and npm
- Solana SBF toolchain (`cargo-build-sbf`)

The pinned versions live in [TOOLCHAIN.md](../TOOLCHAIN.md). `./install.sh` checks for the tools and prints fix-it hints if any are missing; it does not install toolchains or run `sudo`.

## Source Install

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
./install.sh
```

The installer:

1. Checks toolchains.
2. Builds `riptide-engine` in release mode.
3. Builds the shipped SBF programs needed by the smoke tests.
4. Installs CLI dependencies with npm postinstall scripts disabled.
5. Builds the TypeScript CLI.
6. Writes a `riptide` launcher to `$HOME/.local/bin`.
7. Runs lending and generic-adapter smoke tests.

If `$HOME/.local/bin` is not on your `PATH`, the installer prints the export line to add to your shell rc.

Verify the install:

```bash
riptide --help
riptide doctor
riptide run lending/whale-shock-grid --serve
```

## Docker

Use Docker when you want a pinned runtime with the engine, CLI, fixtures, and shipped `.so` artifacts already in place:

```bash
docker build -t riptide .
docker run --rm riptide run lending/whale-shock-grid
```

The Dockerfile pins Rust, Node, npm, Solana CLI, `cargo-build-sbf`, platform tools, and the base images. It builds all shipped example programs in the image.

## Rebuild Pieces Manually

From the repo root:

```bash
# Rust engine
cargo build --release -p riptide-engine

# One on-chain program
cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml

# CLI
(cd cli && npm install --no-audit --no-fund --ignore-scripts && npm run build)
```

Repeat the `cargo build-sbf` command for whichever program your adapter references.

## First Run In Your Repo

After `riptide` is on your `PATH`, move into your Solana program repo:

```bash
cd ~/path/to/your-anchor-program
riptide init
```

Then fill in the generated adapter and run:

```bash
riptide lint <program-name>
riptide adapt --adapter .riptide/adapters/<program-name>.toml
riptide run --serve
```

What each command does:

| Command | Role |
| --- | --- |
| `riptide doctor` | Static health check. No build, no network, no simulation. |
| `riptide init` | Creates `.riptide/adapters/`, `.riptide/personas/`, `.riptide/scenarios/`, and a short getting-started note. |
| `riptide lint` | Machine-checks JSON-IDL-backed adapter references. Non-JSON lineage warns honestly. |
| `riptide adapt` | Smoke-tests the adapter against the local engine. |
| `riptide run --serve` | Runs discovered scenarios and opens the dashboard for the run collection. |

## Upgrade

```bash
git pull
./install.sh
```

The installer is idempotent. Cargo and npm reuse incremental state; the launcher is rewritten in place.

When [TOOLCHAIN.md](../TOOLCHAIN.md) changes, update the host toolchain first, then rerun `./install.sh`.

## Distribution Status

The intended future paths are:

```bash
curl -fsSL https://riptide.run/install | sh
npm install -g @riptide/cli
cargo install riptide-engine
docker pull ghcr.io/riptidesim/riptide
```

Those public artifacts are not live yet. Until a release is cut, avoid the curl installer and `npm install -g @riptide/cli`; both expect GitHub Release assets that do not exist yet.

## Further Reading

- [Architecture](architecture.md) for how the CLI and engine fit together.
- [Evidence packs](pack.md) for the artifacts emitted by every run and replay.
- [Toolchain](../TOOLCHAIN.md) for exact version pins and validator-parity notes.

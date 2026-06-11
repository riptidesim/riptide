# Install

**Supported path:** use the hosted installer for Linux x86_64 or macOS Intel/Apple Silicon.

The hosted installer downloads a prebuilt bundle for the current platform. Windows x64 packaging exists in the release tooling, but no Windows asset is published for `v0.11.0`; use WSL, Linux/macOS, or the repository checkout path until a Windows bundle is attached. A repository checkout and local Docker build are available for Riptide development or unreleased changes.

## Release Install

Linux and macOS:

```bash
curl -fsSL https://riptide.run/install | sh
```

Windows PowerShell is not an active prebuilt path for `v0.11.0`; the hosted PowerShell script exits with a no-bundle message until a Windows release asset is published:

```powershell
irm https://riptide.run/install.ps1 | iex
```

The POSIX installer script lives at [`../scripts/install-release.sh`](../scripts/install-release.sh), and the Windows placeholder installer lives at [`../scripts/install-release.ps1`](../scripts/install-release.ps1). The active Linux/macOS installer downloads a prebuilt bundle for the current platform through the `riptide.run` release proxy, verifies the bundle `.sha256`, unpacks it under the user's local app/data directory, and writes a `riptide` launcher to the configured bin directory.

The release bundle does not require Rust, Node.js, npm, Solana CLI, or `cargo-build-sbf` on the user's machine. It carries the compiled TypeScript CLI, pinned Node runtime, native `riptide-engine` binary, fixtures, examples, shipped `.so` artifacts, and generated fixture deploy keypairs required by owner-aware shipped adapters.

Useful options:

```bash
curl -fsSL https://riptide.run/install | sh -s -- --version 0.11.0
curl -fsSL https://riptide.run/install | sh -s -- --bin-dir "$HOME/bin"
curl -fsSL https://riptide.run/install | sh -s -- --dry-run
curl -fsSL https://riptide.run/install | sh -s -- --no-agent-skills
```

By default, the hosted installer also installs the bundled agent skills
into `${CODEX_HOME:-$HOME/.codex}/skills` and
`${CLAUDE_HOME:-$HOME/.claude}/skills`, including `riptide-config`.
It symlinks to the active Riptide bundle on Linux/macOS and leaves any
existing non-Riptide-managed skill directory untouched. Set
`RIPTIDE_INSTALL_AGENT_SKILLS=0` or pass `--no-agent-skills` to skip
that step.

Release bundles are produced by [`../scripts/package-release.sh`](../scripts/package-release.sh). The current `v0.11.0` public release artifact set is:

```text
riptide-x86_64-unknown-linux-gnu.tar.gz
riptide-x86_64-unknown-linux-gnu.tar.gz.sha256
riptide-x86_64-apple-darwin.tar.gz
riptide-x86_64-apple-darwin.tar.gz.sha256
riptide-aarch64-apple-darwin.tar.gz
riptide-aarch64-apple-darwin.tar.gz.sha256
```

The packager also has a Windows x64 contract for a future release environment with the required Windows cross toolchain:

```text
riptide-x86_64-pc-windows-msvc.zip
riptide-x86_64-pc-windows-msvc.zip.sha256
```

Those files must be attached to the matching GitHub Release tag for the hosted command to install that version. The public installer fetches official releases through `https://riptide.run/releases/...`; set `RIPTIDE_RELEASE_BASE_URL` only when you intentionally maintain a private mirror with both the archive and `.sha256` file. Use the repository checkout or Docker path below for unreleased changes.

## Prerequisites

Required on your `PATH` for repository builds:

- Rust and Cargo
- Node.js and npm
- Solana SBF toolchain (`cargo-build-sbf`)

The pinned versions live in [TOOLCHAIN.md](../TOOLCHAIN.md). `./install.sh` checks for the tools and prints fix-it hints if any are missing; it does not install toolchains or run `sudo`.

## Build From Repository

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

Verify the launcher:

```bash
riptide --help
```

`riptide doctor` is a workspace health check. Run it from a configured
Riptide workspace; in an empty directory it reports that no adapters were
found.

## Local npm Package Install

To install the CLI as a global npm package without a registry, build the tarball from a repository checkout and install it into your npm prefix. For `v0.9.1`, install scripts stay disabled because the matching GitHub Release engine asset is not published; copy the locally built engine into the package after install:

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
cargo build --release -p riptide-engine
cd cli
npm install --no-audit --no-fund --ignore-scripts
npm run build
npm pack
npm install -g --ignore-scripts ./riptide-cli-<version>.tgz
RIPTIDE_NPM_ROOT="$(npm root -g)"
mkdir -p "$RIPTIDE_NPM_ROOT/@riptide/cli/bin"
cp ../target/release/riptide-engine "$RIPTIDE_NPM_ROOT/@riptide/cli/bin/riptide-engine"
chmod +x "$RIPTIDE_NPM_ROOT/@riptide/cli/bin/riptide-engine"
riptide --version
```

Prerequisites on the machine that runs `riptide`:

- Node.js 20+ and npm.
- Rust and Cargo — guided simulation crates generated by `riptide sim generate` build locally with Cargo.
- Solana SBF toolchain (`cargo-build-sbf`), the same baseline as any Anchor development setup, when you build your program's `.so` artifacts.

The package carries the guided-sim runtime crates under `dist/sim-runtime/`. In a packaged install, `riptide sim generate` copies them into your repo at `.riptide/sim/vendor/` and writes relative path dependencies, so the generated simulation crate builds without this repository present.

If you install into a custom prefix, use `npm root -g --prefix <prefix>` for `RIPTIDE_NPM_ROOT` and put `<prefix>/bin` on `PATH`.

The npm postinstall step downloads the prebuilt `riptide-engine` binary from GitHub Releases for the package version. When a matching release asset exists, the plain `npm install -g ./riptide-cli-<version>.tgz` path can fetch it automatically. Until then, use the `--ignore-scripts` local-engine path above, or set `RIPTIDE_RELEASE_BASE_URL` to a mirror that hosts the binary. Verify with:

```bash
riptide --version
```

## Docker

Use Docker when you want a pinned runtime with the engine, CLI, fixtures, and shipped `.so` artifacts already in place:

```bash
docker build -t riptide .
docker run --rm riptide doctor
```

To run Riptide against your own repo with that image, mount the repo and
use the same repo-local commands:

```bash
docker run --rm -v "$PWD:/work" -w /work riptide doctor
docker run --rm -v "$PWD:/work" -w /work riptide run \
  --adapter .riptide/adapters/<program-name>.toml \
  --seeds 1 --seed-root 1337
```

The Dockerfile pins Rust, Node, npm, Solana CLI, `cargo-build-sbf`,
platform tools, and the base images. It builds the shipped program
artifacts copied into the image.

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

The default next step is the merged setup skill:

```bash
/riptide-config
```

`riptide-config` prepares or repairs the adapter, harness, scenarios,
and starter campaign readiness in one loop. It should finish with
`campaign_ready = yes`, `blocked = <reason>`, or
`unsupported = <boundary>`.

If you used the hosted installer, `riptide-config` is installed into
Codex and Claude Code skill folders automatically unless agent skill
installation was disabled or a user-authored skill with the same name
already existed. Start a new Codex or Claude Code session after install
before asking for `/riptide-config`; sessions that were already running
usually will not reload newly installed skills.

When it reports campaign readiness, run the campaign and review the
printed campaign root:

```bash
riptide campaign run .riptide/campaigns/<risk>.campaign.toml
riptide review <campaign-root>
```

Without the agent skill, use the manual / advanced path in
`.riptide/GETTING-STARTED.md`: fill in the adapter by hand, run
`riptide lint`, add a harness when setup bytes are needed, create
scenarios, smoke one seed, then create and run a campaign TOML.

What each command does:

| Command | Role |
| --- | --- |
| `riptide doctor` | Static health check. No build, no network, no simulation. |
| `riptide init` | Creates the thin bootstrap: `.riptide/adapters/<program>.toml` plus `.riptide/GETTING-STARTED.md`. `--profile` / `--protocol` record adapter hints; `--wizard` opens the advanced questionnaire. |
| `/riptide-config` | Default setup flow: adapter TOML, Rust setup harness, personas, scenarios, invariants, campaign readiness, validation, and readiness notes. |
| `riptide harness generate` | Optional escalation: creates a Rust setup crate for account bytes, PDAs, SPL accounts, and sibling programs your adapter needs before tick 0. |
| `riptide explain <adapter>` | Pretty-prints a parsed adapter: protocol, runtime, accounts, instructions, observations, personas, invariants, semantics, and oracles. |
| `riptide lint` | Machine-checks JSON-IDL-backed adapter references. Non-JSON lineage warns honestly. |
| `riptide adapt` | Adapter-only smoke against the local engine; use `riptide run --harness` only after you explicitly add a harness setup layer. |
| `riptide campaign run` | Executes the generated campaign runs and prints the campaign root for review. |
| `riptide review <campaign-root>` | Validates retained campaign evidence and prints reviewer markdown. |
| `riptide run --serve` | Runs discovered scenarios and opens the dashboard for the run collection. |

## Upgrade

```bash
git pull
./install.sh
```

The installer is idempotent. Cargo and npm reuse incremental state; the launcher is rewritten in place.

When [TOOLCHAIN.md](../TOOLCHAIN.md) changes, update the host toolchain first, then rerun `./install.sh`.

## Distribution Status

Hosted installer paths:

Linux and macOS:

```bash
curl -fsSL https://riptide.run/install | sh
```

Windows PowerShell currently reports that no Windows prebuilt bundle is published for `v0.11.0`:

```powershell
irm https://riptide.run/install.ps1 | iex
```

Package-manager and registry paths are not the primary distribution
surface yet. A local npm tarball built from a repository checkout works
today (see [Local npm Package Install](#local-npm-package-install)).
Use the hosted installer, source checkout, local tarball, or local
Docker build above until these artifacts are published:

```bash
# Planned after npm publication:
npm install -g @riptide/cli

# Planned after crates.io publication:
cargo install riptide-engine

# Planned after GHCR publication:
docker pull ghcr.io/riptidesim/riptide
```

The curl and PowerShell commands expect matching GitHub Release assets
for the requested version, served through the `riptide.run` release
proxy for the official repository. GHCR, crates.io, and npm publication
remain separate distribution paths and should be documented as supported
only after the corresponding artifacts exist.

## Further Reading

- [Architecture](architecture.md) for how the CLI and engine fit together.
- [Evidence packs](pack.md) for the artifacts emitted by every run and replay.
- [Toolchain](../TOOLCHAIN.md) for exact version pins and validator-parity notes.

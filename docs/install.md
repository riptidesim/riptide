# Install

Riptide ships as an engine-free CLI. There is no separate simulator
binary to download or build: `riptide sim generate` scaffolds a
project-owned Rust crate that builds against the vendored `riptide-sim`
runtime with ordinary `cargo`. You bring your own Solana program; the
Solana SBF toolchain builds its `.so`.

Two install paths are supported:

- **Hosted release installer** — a prebuilt bundle for Linux x86_64 or
  macOS Intel / Apple Silicon. No Rust, Node, or npm required to install
  the CLI itself.
- **Repository checkout (`./install.sh`)** — build the TypeScript CLI from
  source. Use this for Riptide development or unreleased changes.

Windows is not a published target yet; use WSL, Linux/macOS, or the
repository checkout path.

## Release Install

Linux and macOS:

```bash
curl -fsSL https://riptide.run/install | sh
```

The POSIX installer lives at
[`../scripts/install-release.sh`](../scripts/install-release.sh). It
downloads the prebuilt bundle for the current platform through the
`riptide.run` release proxy, verifies the bundle `.sha256`, unpacks it
under the user's local app/data directory, and writes a `riptide`
launcher to the configured bin directory.

The release bundle carries a pinned Node runtime, the compiled
TypeScript CLI with its production npm dependencies (including the
vendored guided-sim runtime crates under `dist/sim-runtime/`), the
bundled agent skills, adapter fixtures, examples, and docs. Installing
the CLI does not require Rust, Node, or npm on your machine.

Useful options:

```bash
curl -fsSL https://riptide.run/install | sh -s -- --bin-dir "$HOME/bin"
curl -fsSL https://riptide.run/install | sh -s -- --dry-run
curl -fsSL https://riptide.run/install | sh -s -- --no-agent-skills
```

By default, the hosted installer also installs the bundled agent skills
into `${CODEX_HOME:-$HOME/.codex}/skills` and
`${CLAUDE_HOME:-$HOME/.claude}/skills`, including `riptide-config`. It
symlinks to the active Riptide bundle on Linux/macOS and leaves any
existing non-Riptide-managed skill directory untouched. Set
`RIPTIDE_INSTALL_AGENT_SKILLS=0` or pass `--no-agent-skills` to skip that
step.

Release bundles are produced by
[`../scripts/package-release.sh`](../scripts/package-release.sh). To run
a guided simulation against your own program after installing the bundle,
you still need a Rust/Cargo toolchain and the Solana SBF toolchain
(`cargo-build-sbf`) locally — they build your program's `.so` and the
generated guided-sim crate (see [Prerequisites](#prerequisites)).

## Prerequisites

To build the CLI from a repository checkout, and to run guided
simulations against your program in any install, the following must be on
your `PATH`:

- Rust and Cargo — generated guided-sim crates build locally with Cargo.
- Node.js and npm — only required for the repository-checkout CLI build.
- Solana SBF toolchain (`cargo-build-sbf`) — the same baseline as any
  Anchor development setup; builds your program's `.so` artifacts.

The pinned versions live in [TOOLCHAIN.md](../TOOLCHAIN.md).
`./install.sh` checks for the tools and prints fix-it hints if any are
missing; it does not install toolchains or run `sudo`.

## Build From Repository

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
./install.sh
```

The installer is engine-free. It runs five steps:

1. **Detect toolchains.** Confirms `rustc`, `cargo`, `node`, `npm`, and
   `cargo-build-sbf` are on `PATH`, printing an actionable hint for any it
   cannot find. (`cargo-build-sbf` is required because you build the
   Solana program you simulate.)
2. **Install CLI dependencies** with `npm install --ignore-scripts` in
   `cli/` (postinstall hooks disabled).
3. **Build the TypeScript CLI** with `npm run build`.
4. **Install a `riptide` launcher** into `$HOME/.local/bin`. The launcher
   is a small shim that execs the built CLI entry point; it is rewritten
   atomically on every run, so installing twice is safe.
5. **Verify the install.** Runs `riptide --version`, `riptide --help`, and
   `riptide doctor` as a static toolchain self-check. A `doctor` WARN
   verdict is acceptable; a hard FAIL aborts the install.

If `$HOME/.local/bin` is not on your `PATH`, the installer prints the
export line to add to your shell rc.

Verify the launcher:

```bash
riptide --help
```

`riptide doctor` is a static health check. Run it from a configured
Riptide workspace; in an empty directory it reports that no adapters were
found.

## Docker

Use Docker when you want a pinned runtime with the CLI, fixtures, and
Solana SBF toolchain already in place:

```bash
docker build -t riptide .
docker run --rm riptide doctor
```

To run Riptide against your own repo with that image, mount the repo:

```bash
docker run --rm -v "$PWD:/work" -w /work riptide doctor
```

The Dockerfile pins Rust, Node, npm, Solana CLI, `cargo-build-sbf`,
platform tools, and the base images.

## Rebuild The CLI Manually

From the repo root:

```bash
(cd cli && npm install --no-audit --no-fund --ignore-scripts && npm run build)
```

Build the Solana program your adapter references with the SBF toolchain,
for example:

```bash
cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml
```

## First Run In Your Repo

After `riptide` is on your `PATH`, move into your Solana program repo and
bootstrap the thin scaffold:

```bash
cd ~/path/to/your-anchor-program
riptide init
```

The default next step is the merged setup skill:

```text
/riptide-config
```

`riptide-config` prepares or repairs the adapter and authors the guided
simulation: the `.riptide/sim/` crate, its `Riptide.toml` manifest, the
project-owned `flows.rs` / `invariants.rs` / `services/`, and the
readiness notes.

If you used the hosted installer, `riptide-config` is installed into
Codex and Claude Code skill folders automatically unless agent skill
installation was disabled or a user-authored skill with the same name
already existed. Start a new Codex or Claude Code session after install
before asking for `/riptide-config`; sessions that were already running
usually will not reload newly installed skills.

The guided-sim assessment flow then runs entirely through `riptide sim`,
`riptide assess`, and `riptide review`:

```bash
riptide sim generate --adapter .riptide/adapters/<program>.toml
riptide sim run .riptide/sim --flows 20 --out .riptide/sim/artifacts/run-001
riptide sim surface .riptide/sim/artifacts/run-001 --sim .riptide/sim
riptide assess .riptide/sim
riptide review .riptide/sim/artifacts/run-001
```

See [Guided simulations](guided-sim.md) for the full command workflow,
bootstrap manifest, and generated-file ownership rules.

What each command does:

| Command | Role |
| --- | --- |
| `riptide doctor` | Static health check. No build, no network, no simulation. |
| `riptide init` | Creates the thin bootstrap: `.riptide/adapters/<program>.toml` plus `.riptide/GETTING-STARTED.md`. `--profile` / `--protocol` record adapter hints; `--wizard` opens the advanced questionnaire. |
| `/riptide-config` | Default setup flow: adapter TOML and the guided-sim crate, flows, invariants, services, and readiness notes. |
| `riptide readiness` | Inspects local protocol evidence readiness without building or simulating. |
| `riptide sim generate` | Scaffolds the project-owned guided-sim crate from an IDL-backed adapter. |
| `riptide sim run` | Runs the generated guided-sim crate and writes the guided-sim artifact. |
| `riptide sim surface` | Builds cartography artifacts (risk-surface, summary, retention) from a guided-sim sweep so `riptide assess` can render a heatmap. |
| `riptide sim review` / `riptide review` | Validate a guided-sim artifact directory and print reviewer markdown. |
| `riptide assess` | Generates a protocol assessment (`assessment.json` + `assessment.md`) from a guided-sim root. |

## Upgrade

For a repository checkout:

```bash
git pull
./install.sh
```

The installer is idempotent. npm reuses incremental state; the launcher is
rewritten in place. When [TOOLCHAIN.md](../TOOLCHAIN.md) changes, update
the host toolchain first, then rerun `./install.sh`.

## Distribution Status

Hosted installer (Linux and macOS):

```bash
curl -fsSL https://riptide.run/install | sh
```

Package-manager and registry paths are not the primary distribution
surface yet. Use the hosted installer, source checkout, or local Docker
build above until these artifacts are published:

```bash
# Planned after npm publication:
npm install -g @riptide/cli

# Planned after GHCR publication:
docker pull ghcr.io/riptidesim/riptide
```

The curl command expects matching GitHub Release assets for the requested
version, served through the `riptide.run` release proxy for the official
repository. GHCR and npm publication remain separate distribution paths
and should be documented as supported only after the corresponding
artifacts exist.

## Further Reading

- [Architecture](architecture.md) for how the CLI, the guided-sim runtime, and codegen fit together.
- [Guided simulations](guided-sim.md) for the `.riptide/sim/` crate and the assessment flow.
- [Toolchain](../TOOLCHAIN.md) for exact version pins and validator-parity notes.

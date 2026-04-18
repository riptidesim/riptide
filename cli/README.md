# @riptide/cli

Riptide is a **deterministic multi-agent simulator for Solana programs**. Point it at your program's IDL + a handful of persona TOMLs and it runs hundreds of adversarial users against your code in LiteSVM, emitting a byte-stable per-tick JSON trace plus a rolled-up summary.

This npm package is the Node.js CLI front-end. It ships a prebuilt native `riptide-engine` binary for your platform via a postinstall step (pattern: esbuild / @swc/core).

## Install

```bash
npm install -g @riptide/cli
riptide --help
```

Supported platforms (as of this release):

- Linux x86_64

macOS and Windows prebuilt binaries will land in a later release. Until then, those platforms can build from source via [cargo install riptide-engine](https://crates.io/crates/riptide-engine) or run via Docker.

## Usage

```bash
# Run a scenario
riptide run path/to/run-config.json

# Generate an adapter from an IDL (via the riptide-adapt Claude Code skill)
riptide adapt --adapter path/to/adapter.toml

# Validate a proposal catalog from the riptide-scenarios skill
riptide scenarios --validate path/to/scenario-dir

# Replay a real on-chain trajectory tick-by-tick
riptide replay path/to/replay-config.json
```

See the [main Riptide repo](https://github.com/riptidesim/riptide) for the full tour, the Solend-fork case study, and the two Claude Code skills (`riptide-adapt`, `riptide-scenarios`).

## License

Dual-licensed under MIT or Apache-2.0 at your option.

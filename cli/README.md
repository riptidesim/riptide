# @riptide/cli

Riptide is a **deterministic multi-agent simulator for Solana programs**. Point it at your program's IDL + a handful of persona TOMLs and it runs hundreds of adversarial users against your code in LiteSVM, emitting a byte-stable per-tick JSON trace plus a rolled-up summary.

This npm package is the Node.js CLI front-end. On install it fetches a prebuilt native `riptide-engine` binary for your platform from the main repo's GitHub Releases and verifies it against a shipped sha256 (pattern: esbuild / @swc/core).

## Install

> **Pre-publish notice.** `@riptide/cli` is not yet published to the public npm registry — it lands in an upcoming release after one more cold-eyes validation pass. Until then, install from the monorepo:
>
> ```bash
> git clone https://github.com/riptidesim/riptide
> cd riptide &&./install.sh
> ```

Once published, the registry path will be:

```bash
npm install -g @riptide/cli
riptide --help
```

Supported platforms at first publish: Linux x86_64. macOS and Windows prebuilts ship in a later release; those platforms can build from the monorepo source today or use the repo's `Dockerfile`.

## Usage

```bash
# Run a scenario
riptide run path/to/run-config.json

# Generate an adapter from an IDL (via the riptide-adapt Claude Code skill)
riptide adapt --adapter path/to/adapter.toml

# Validate a proposal catalog from the riptide-scenarios skill
riptide scenarios --validate path/to/scenario-dir

# Replay a real on-chain trajectory tick-by-tick
riptide replay path/to/config.json
```

See the [main Riptide repo](https://github.com/riptidesim/riptide) for the full tour, the Solend-fork case study, and the two Claude Code skills (`riptide-adapt`, `riptide-scenarios`).

## License

Dual-licensed under MIT or Apache-2.0 at your option.

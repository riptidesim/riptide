---
name: Bug report
about: Report something Riptide does that it shouldn't
title: "[bug] "
labels: bug
---

## What happened

A one-line description of the bug.

## Reproduction steps

1. Run... (exact command line, including adapter path, run-config path, env vars)
2....
3. Observe...

If the bug reproduces against a shipping fixture (`fixtures/adapters/solend-fork.toml`, `perps-fork.toml`, `amm-fork.toml`, `resource-grinder.toml`), mention that — it's the fastest path to a repro on our end.

## Expected behavior

What should have happened instead.

## Actual behavior

What actually happened. Paste the full error, the exit code, and any relevant stderr.

## Environment

- Riptide version (Docker tag / `cargo install` version / `npm` version / git SHA):
- OS (Linux distro + kernel / macOS version):
- Rust toolchain (`rustc --version`):
- Solana CLI (`solana --version`) if you built programs locally:
- Node version (`node --version`) if you used the CLI wrapper:

## Additional context

Anything else — determinism hash mismatches, the contents of `simulation-result.json`, a minimal adapter TOML that reproduces the issue, etc.

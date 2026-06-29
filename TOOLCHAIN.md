# Toolchain

This repository uses two compatibility bands:

- Off-chain workspace: current host toolchain and current stable app dependencies where practical.
- On-chain program workspace: pinned Solana-compatible versions for reproducible `cargo-build-sbf` builds.

## Off-chain

- Rust: `rustc 1.91.1`
- Cargo: `cargo 1.91.1`
- Node.js: `v24.11.1`
- npm: `11.6.2`

## On-chain

- Solana CLI: `3.0.13`
- `cargo-build-sbf`: `3.0.13`
- platform-tools: `v1.51`
- bundled SBF rustc: `1.84.1`

### Program workspace pins

The standalone program workspace at `programs/lending_pool/` is pinned to:

- `solana-program = 1.18.26`
- direct program serialization deps: `borsh = 0.10.4`, `borsh-derive = 0.10.4`
- `thiserror = 1.0.69`

`programs/lending_pool/` is the only supported on-chain workspace path. The older
`programs/lending-pool/` tree is legacy and should not be used for builds, tests, or deploys.

It also carries repo-local compatibility patches for transitive dependencies that the SBF toolchain
cannot resolve reproducibly from the newest compatible crate graph:

- `blake3 = 1.5.1`
- `borsh = 1.2.1`
- `borsh-derive = 1.2.1`
- `cpufeatures = 0.2.17`

Reason:

The newer `solana-program 4.x` dependency chain pulls `solana-blake3-hasher -> blake3 1.8.x -> cpufeatures 0.3.0`, and `cpufeatures 0.3.0` requires `edition = "2024"` and Rust `>= 1.85`. The currently available SBF toolchain used here bundles Rust `1.84.1`, so clean builds fail during dependency resolution before our program code is compiled.

Even on the `1.18.26` Solana line, Cargo will otherwise float transitive dependencies to newer
`borsh` and `indexmap` releases that also require 2024-edition parsing through the derive
toolchain. The repo-local patches freeze the on-chain compatibility boundary to a graph that the
Agave `3.0.13` SBF toolchain can build from a wiped cargo registry with no manual intervention.

Until Agave ships an SBF toolchain that cleanly supports the newer Rust ecosystem, keep the on-chain workspace on a known-good pinned band and regenerate its lockfile from clean state when changing Solana-facing dependencies.

## Reproducible commands

Off-chain:

- `cargo test --workspace`
- `cd cli && npm test`

On-chain:

- `cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml`
- `cargo test --manifest-path programs/lending_pool/Cargo.toml`

## Known workarounds

The on-chain workspace ships repo-local vendor copies of `blake3`, `borsh`,
`borsh-derive`, and `cpufeatures` (see `vendor/`) to freeze the SBF dependency
graph at a band the bundled Rust `1.84.1` can compile. This was necessary
because newer transitive crates (notably `cpufeatures 0.3.0`, pulled in by
`blake3 >= 1.8`) declare `edition = "2024"` and require Rust `>= 1.85`.

These vendor copies can be removed once `cargo-build-sbf` ships a platform-tools
release whose bundled rustc is `>= 1.85`. After that, drop the
`[patch.crates-io]` block in `programs/lending_pool/Cargo.toml` and let cargo
resolve from crates.io directly.

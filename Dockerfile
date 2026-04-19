# syntax=docker/dockerfile:1.7
#
# Riptide — Sprint 6 T18 Docker image.
#
# Produces a single runnable image that ships the engine, the
# TypeScript CLI, and all five on-chain programs pre-built as `.so`
# artifacts, with every fixture/scenario/replay/adapter tree in place
# so `docker run <image> run fixtures/scenarios/...` works end-to-end.
#
# Toolchain pins (TOOLCHAIN.md — do not drift):
#   - Rust           1.91.1
#   - Node           24.11.1
#   - npm            11.6.2
#   - Solana CLI     3.0.13   (Agave / Anza installer)
#   - cargo-build-sbf 3.0.13
#   - platform-tools v1.51
#   - bundled SBF rustc 1.84.1
#
# The on-chain workspace ships repo-local `vendor/` copies of blake3,
# borsh, borsh-derive, cpufeatures. Do not strip them — the bundled
# SBF rustc 1.84.1 cannot resolve newer crate graph cleanly without
# these patches.
#
# The `CARGO_MANIFEST_DIR`-baked default `.so` path for the lending
# primitive (`engine/src/harness/setup.rs::default_program_so_path`)
# resolves at runtime as `/src/engine/../programs/lending_pool/target/
# deploy/lending_pool.so`. The runtime stage mirrors the `/src`
# directory layout so that baked path, plus every adapter's relative
# `program_so = "../../programs/.../*.so"`, resolves without overrides.

# ---------------------------------------------------------------------------
# Build stage — heavy toolchains. Discarded at the end.
# ---------------------------------------------------------------------------
# Base pinned via @sha256: digest instead of the mutable `rust:1.91.1-bookworm`
# tag, so the repo has full diff-visibility into which manifest the build
# actually resolves. The tag is kept for human readability; Docker uses the
# digest for resolution. Captured 2026-04-18 via `docker buildx imagetools
# inspect rust:1.91.1-bookworm`.
FROM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS build

# Avoid interactive apt prompts and cap apt's cache footprint.
ENV DEBIAN_FRONTEND=noninteractive

# System deps:
#   - curl, ca-certificates, gnupg: fetch installers + NodeSource GPG
#   - build-essential, pkg-config, libudev-dev, libssl-dev: Solana CLI
#     + native crates (ring, ssl) need these to compile
#   - bzip2: Anza installer expands platform-tools archives
#   - git: solana installer + some cargo deps still expect git
#   - python3: cargo build-sbf invokes python for script steps
#   - jq: handy for any JSON parsing in follow-on scripts (small)
#   - xz-utils: node tarball extractor for NodeSource postinstall
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg git bzip2 xz-utils \
        build-essential pkg-config libudev-dev libssl-dev \
        python3 jq \
 && rm -rf /var/lib/apt/lists/*

# --- Node 24.11.1 + npm 11.6.2 via sha256-pinned tarball ---------------------
# Download the official Node tarball from nodejs.org directly instead of
# piping NodeSource's installer to bash (which pulls a live script + apt
# key that the repo has no diff-visibility into, and which only pins the
# major line "24.x" rather than the exact 24.11.1 the TOOLCHAIN.md
# contract claims). NODE_SHA256 is the tarball hash from the published
# SHASUMS256.txt for v24.11.1 — if the upstream file changes, the build
# fails rather than silently shipping drift.
ENV NODE_VERSION=24.11.1 \
    NODE_SHA256=60e3b0a8500819514aca603487c254298cd776de0698d3cd08f11dba5b8289a8
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      -o /tmp/node.tar.xz \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm /tmp/node.tar.xz \
 && npm install -g npm@11.6.2 \
 && node --version \
 && npm --version

# --- Solana CLI 3.0.13 via sha256-pinned Anza installer ----------------------
# Download the Anza installer script to disk, sha256-verify against the
# value captured at 2026-04-18 for v3.0.13, then execute it. The installer
# in turn lands `solana`, `cargo-build-sbf`, `platform-tools v1.51`, and
# the bundled SBF rustc 1.84.1 under ~/.local/share/solana. The downstream
# artifacts that installer fetches are not pinned here (Sprint 7 follow-up
# item), but the installer script itself is no longer a live-fetch-and-bash.
ENV ANZA_INSTALL_SHA256=dfab59a5773be04a284501f276a58a7856e2f42ae6ea68564140d0b3a56ce8c6
RUN curl -fsSL https://release.anza.xyz/v3.0.13/install -o /tmp/anza-install.sh \
 && echo "${ANZA_INSTALL_SHA256}  /tmp/anza-install.sh" | sha256sum -c - \
 && sh /tmp/anza-install.sh \
 && rm /tmp/anza-install.sh

# Put the Solana toolchain on PATH for every subsequent layer + the
# resulting shell. `$HOME/.local/share/solana/install/active_release/bin`
# is where the installer drops the CLI + cargo-build-sbf shims.
ENV PATH=/root/.local/share/solana/install/active_release/bin:/root/.cargo/bin:${PATH}

# Sanity: fail the build early if any of the pinned tools are missing
# or wrong. Keeps the "image built but broken" failure mode off the table.
RUN rustc --version \
 && cargo --version \
 && node --version \
 && npm --version \
 && solana --version \
 && cargo-build-sbf --version

# --- Copy source --------------------------------------------------------------
# Single COPY keeps the build context predictable; .dockerignore filters
# out target/, node_modules/, test-ledger/, .git/, etc.
WORKDIR /src
COPY . /src

# --- Build the off-chain engine (release) ------------------------------------
# The engine binary lands at /src/target/release/riptide-engine. Its
# `env!("CARGO_MANIFEST_DIR")` bakes in `/src/engine`, so the default
# lending .so lookup resolves relative to `/src/`.
RUN cargo build --release -p riptide-engine \
 && test -x /src/target/release/riptide-engine

# --- Build the TypeScript CLI ------------------------------------------------
# `npm ci` requires package-lock.json — the repo ships one. The build
# script runs tsc and then copy-personas.mjs (which also copies the
# dashboard assets into cli/dist/assets).
#
# `--ignore-scripts` skips the T19 postinstall binary downloader. That
# script fetches a prebuilt `riptide-engine` from GitHub Releases for
# end-users installing `@riptide/cli` via npm. Inside this image we
# already have a locally-built engine at /src/target/release/riptide-
# engine, so the postinstall download would be wasted network — and
# would fail outright until the v0.6.0 release is actually cut on
# GitHub (currently 404s).
WORKDIR /src/cli
RUN npm ci --no-audit --no-fund --ignore-scripts \
 && npm run build \
 && test -f /src/cli/dist/src/index.js

# --- Build all five on-chain programs ----------------------------------------
# Order by heaviest-first so a failure surfaces early in the most
# diagnostic spot. Each `cargo build-sbf` lands its .so at
# `<manifest>/target/deploy/<name>.so`. Adapter TOMLs use relative
# paths that mirror this layout.
WORKDIR /src
RUN cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml \
 && test -f /src/programs/lending_pool/target/deploy/lending_pool.so
RUN cargo build-sbf --manifest-path programs/resource_grinder/Cargo.toml \
 && test -f /src/programs/resource_grinder/target/deploy/resource_grinder.so
RUN cargo build-sbf --manifest-path programs/admin_mock_oracle/Cargo.toml \
 && test -f /src/programs/admin_mock_oracle/target/deploy/admin_mock_oracle.so
RUN cargo build-sbf --manifest-path programs/perps-fork/Cargo.toml \
 && test -f /src/programs/perps-fork/target/deploy/perps_fork.so
RUN cargo build-sbf --manifest-path programs/amm-fork/Cargo.toml \
 && test -f /src/programs/amm-fork/target/deploy/amm_fork.so

# ---------------------------------------------------------------------------
# Runtime stage — minimal, ships only what `riptide` needs at runtime.
# ---------------------------------------------------------------------------
# node:24.11.1-bookworm-slim gives us the exact Node version the CLI was
# built against without reinstalling apt + NodeSource in the runtime
# layer. It's ~200MB base which is fine — the multi-GB weight of this
# image comes from the cargo .so artifacts the engine needs, not Node.
# Pinned via @sha256: digest for the same supply-chain reason as the
# build stage base. Captured 2026-04-18 via `docker buildx imagetools
# inspect node:24.11.1-bookworm-slim`.
FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57 AS runtime

# Minimal runtime OS deps:
#   - ca-certificates: TLS for outbound tooling (rare, but keeps
#     `riptide` usable in workflows that do fetch anything)
#   - libssl3: the engine binary may link against openssl at runtime
#     (solana-sdk transitively pulls it in)
#   - libudev1: same reason, carried over from the build stage
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates libssl3 libudev1 \
 && rm -rf /var/lib/apt/lists/*

# Mirror the /src layout from the build stage so that:
#   1. The `CARGO_MANIFEST_DIR`-baked default lending .so path resolves
#      (/src/engine/../programs/lending_pool/target/deploy/lending_pool.so)
#   2. Every adapter's relative `program_so = "../../programs/.../*.so"`
#      resolves from `/src/fixtures/adapters/<name>.toml`
#   3. Adapter `idl_path = "../idls/..."` resolves against
#      `/src/fixtures/idls/`
WORKDIR /src

# `engine/src/harness/setup.rs::default_program_so_path` bakes in
# `env!("CARGO_MANIFEST_DIR")` (= `/src/engine` in the build container)
# and joins `../programs/lending_pool/target/deploy/lending_pool.so`.
# Rust's `Path::exists()` on that path returns false when `/src/engine`
# does not exist as a directory, even though the canonical absolute
# path does. Create the empty marker so the default-path lookup works
# without forcing every lending invocation to pass `--program-so`.
RUN mkdir -p /src/engine

# --- Engine binary -----------------------------------------------------------
# Put it at the same path the build stage produced, plus a stable
# `/usr/local/bin/riptide-engine` symlink in case anything downstream
# relies on `$PATH`.
COPY --from=build /src/target/release/riptide-engine \
                  /src/target/release/riptide-engine
RUN ln -s /src/target/release/riptide-engine /usr/local/bin/riptide-engine

# --- CLI (compiled dist + node_modules) --------------------------------------
# Copy the whole cli/ so package.json + dist + node_modules + assets
# stay together. `resolveEngineBinary()` walks up from this module's
# disk location to find the engine — mirroring /src/target/release is
# why that lookup lands correctly without env-var hints.
COPY --from=build /src/cli /src/cli

# --- Shipped Solana programs (.so artifacts only — NEVER keypairs) -----------
# Only the `target/deploy/*.so` files are load-bearing for the runtime
# image. The matching `*-keypair.json` files that `cargo build-sbf`
# generates are private key material consumed only by the validator-parity
# path (`engine/src/harness/setup.rs::deploy_program`, which shells out
# to the real `solana` CLI for a live on-chain deploy). The LiteSVM
# in-process harness — which is the only path that runs inside this
# container — never reads them, and the runtime stage ships no `solana`
# CLI. Shipping them would be unnecessary secret disclosure in a public
# distribution artifact, so the copies are explicitly omitted here.
COPY --from=build /src/programs/lending_pool/target/deploy/lending_pool.so \
                  /src/programs/lending_pool/target/deploy/lending_pool.so
COPY --from=build /src/programs/resource_grinder/target/deploy/resource_grinder.so \
                  /src/programs/resource_grinder/target/deploy/resource_grinder.so
COPY --from=build /src/programs/admin_mock_oracle/target/deploy/admin_mock_oracle.so \
                  /src/programs/admin_mock_oracle/target/deploy/admin_mock_oracle.so
COPY --from=build /src/programs/perps-fork/target/deploy/perps_fork.so \
                  /src/programs/perps-fork/target/deploy/perps_fork.so
COPY --from=build /src/programs/amm-fork/target/deploy/amm_fork.so \
                  /src/programs/amm-fork/target/deploy/amm_fork.so

# --- Fixtures + examples + scripts -------------------------------------------
# Fixtures are read from disk by every engine invocation; examples/configs
# is referenced by the README; scripts/ carries the Sprint 5 + Sprint 6
# scratch runners.
COPY --from=build /src/fixtures /src/fixtures
COPY --from=build /src/examples /src/examples
COPY --from=build /src/scripts  /src/scripts
COPY --from=build /src/skills   /src/skills
COPY --from=build /src/README.md /src/README.md
COPY --from=build /src/TOOLCHAIN.md /src/TOOLCHAIN.md

# --- `riptide` launcher on $PATH --------------------------------------------
# Shim script matching the install.sh pattern: exec Node against the
# compiled CLI entry point. `RIPTIDE_ENGINE_BIN` is exported so the CLI
# always picks up the right engine without walking the filesystem.
RUN printf '#!/usr/bin/env bash\n\
# Riptide CLI launcher — baked into the T18 Docker image\n\
: "${RIPTIDE_ENGINE_BIN:=/src/target/release/riptide-engine}"\n\
export RIPTIDE_ENGINE_BIN\n\
exec node /src/cli/dist/src/index.js "$@"\n' > /usr/local/bin/riptide \
 && chmod +x /usr/local/bin/riptide

# Engine binary resolution env — also set at the image level so users
# invoking `node /src/cli/dist/src/index.js` directly still hit the
# right engine.
ENV RIPTIDE_ENGINE_BIN=/src/target/release/riptide-engine

# Default to /src so run-config / policies / adapter relative paths
# like `fixtures/scenarios/solend-fork/...` resolve against the
# shipped fixture tree.
WORKDIR /src

# One entrypoint, all subcommands. `docker run <image> --help`,
# `docker run <image> run fixtures/scenarios/...`, etc.
ENTRYPOINT ["riptide"]
CMD ["--help"]

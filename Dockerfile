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
FROM rust:1.91.1-bookworm AS build

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

# --- Node 24.11.1 + npm 11.6.2 via NodeSource --------------------------------
# NodeSource ships the 24.x line; we then pin npm to 11.6.2 exactly.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g npm@11.6.2 \
 && node --version \
 && npm --version \
 && rm -rf /var/lib/apt/lists/*

# --- Solana CLI 3.0.13 via Anza installer ------------------------------------
# This lands `solana`, `cargo-build-sbf`, `platform-tools v1.51`, and the
# bundled SBF rustc 1.84.1 under ~/.local/share/solana.
RUN sh -c "$(curl -sSfL https://release.anza.xyz/v3.0.13/install)"

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
FROM node:24.11.1-bookworm-slim AS runtime

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

# --- Shipped Solana programs (.so artifacts only — not full cargo trees) -----
# Only the `target/deploy/*.so` files are load-bearing. The source
# trees, Cargo.lock, vendored crates are all build-time concerns.
COPY --from=build /src/programs/lending_pool/target/deploy/lending_pool.so \
                  /src/programs/lending_pool/target/deploy/lending_pool.so
COPY --from=build /src/programs/lending_pool/target/deploy/lending_pool-keypair.json \
                  /src/programs/lending_pool/target/deploy/lending_pool-keypair.json
COPY --from=build /src/programs/resource_grinder/target/deploy/resource_grinder.so \
                  /src/programs/resource_grinder/target/deploy/resource_grinder.so
COPY --from=build /src/programs/resource_grinder/target/deploy/resource_grinder-keypair.json \
                  /src/programs/resource_grinder/target/deploy/resource_grinder-keypair.json
COPY --from=build /src/programs/admin_mock_oracle/target/deploy/admin_mock_oracle.so \
                  /src/programs/admin_mock_oracle/target/deploy/admin_mock_oracle.so
COPY --from=build /src/programs/admin_mock_oracle/target/deploy/admin_mock_oracle-keypair.json \
                  /src/programs/admin_mock_oracle/target/deploy/admin_mock_oracle-keypair.json
COPY --from=build /src/programs/perps-fork/target/deploy/perps_fork.so \
                  /src/programs/perps-fork/target/deploy/perps_fork.so
COPY --from=build /src/programs/perps-fork/target/deploy/perps_fork-keypair.json \
                  /src/programs/perps-fork/target/deploy/perps_fork-keypair.json
COPY --from=build /src/programs/amm-fork/target/deploy/amm_fork.so \
                  /src/programs/amm-fork/target/deploy/amm_fork.so
COPY --from=build /src/programs/amm-fork/target/deploy/amm_fork-keypair.json \
                  /src/programs/amm-fork/target/deploy/amm_fork-keypair.json

# --- Fixtures + demo + scripts -----------------------------------------------
# Fixtures are read from disk by every engine invocation; demo/configs
# is referenced by the README; scripts/ carries the Sprint 5 + Sprint 6
# scratch runners.
COPY --from=build /src/fixtures /src/fixtures
COPY --from=build /src/demo     /src/demo
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

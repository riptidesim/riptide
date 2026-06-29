# syntax=docker/dockerfile:1.7
#
# Riptide Docker image.
#
# A ready-to-run Riptide CLI + Solana/Rust toolchain environment. The
# image ships the compiled Node/TypeScript CLI (with its vendored
# `sim-runtime`) plus the full Rust and Solana SBF toolchains a user
# needs to run the guided-sim flow against THEIR own program:
#
#   riptide init  ->  riptide sim generate  ->  riptide sim run  ->  riptide assess
#
# The user mounts or clones their Solana program into the container and
# drives that flow. `riptide sim run` generates a project-owned Rust
# crate that path-depends on the vendored `riptide-sim` runtime and
# compiles it per-run, so the runtime MUST carry cargo + the SBF
# toolchain — this is not a minimal node-slim image.
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
# Single stage: because guided sims compile per-run, the final image
# needs the entire Rust + Solana toolchain anyway — there is no compiled
# binary artifact to hand off to a slim runtime, so a multi-stage split
# would only copy the heavy toolchains forward for no size win.

# Base pinned via @sha256: digest instead of the mutable `rust:1.91.1-bookworm`
# tag, so the repo has full diff-visibility into which manifest the build
# actually resolves. The tag is kept for human readability; Docker uses the
# digest for resolution. Captured 2026-04-18 via `docker buildx imagetools
# inspect rust:1.91.1-bookworm`.
FROM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33

# Avoid interactive apt prompts and cap apt's cache footprint.
ENV DEBIAN_FRONTEND=noninteractive

# System deps:
#   - curl, ca-certificates, gnupg: fetch installers + verify TLS
#   - build-essential, pkg-config, libudev-dev, libssl-dev: native crates
#     (ring, ssl) the SBF/guided-sim build chain pulls in need these
#   - bzip2: Anza installer expands platform-tools archives
#   - git: solana installer + some cargo deps still expect git
#   - python3: cargo build-sbf invokes python for script steps
#   - jq: handy for any JSON parsing in follow-on scripts (small)
#   - xz-utils: node tarball extractor
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
# the bundled SBF rustc 1.84.1 under ~/.local/share/solana. These are
# load-bearing at runtime: `riptide sim run` shells out to the SBF
# toolchain to compile the user's program + the generated sim crate.
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

# --- Source needed to build the CLI ------------------------------------------
# Only the pieces the CLI build touches are copied, which keeps the image
# lean and avoids pulling in unrelated repo trees. The CLI's build step
# (copy-personas.mjs) vendors the `riptide-sim` + `riptide-sim-macros`
# crates and the workspace `Cargo.lock` into `cli/dist/sim-runtime`, so
# those must be present at the repo root during the build.
WORKDIR /src
COPY cli /src/cli
COPY riptide-sim /src/riptide-sim
COPY riptide-sim-macros /src/riptide-sim-macros
COPY Cargo.lock /src/Cargo.lock
COPY Cargo.toml /src/Cargo.toml
COPY TOOLCHAIN.md /src/TOOLCHAIN.md

# --- Build the TypeScript CLI ------------------------------------------------
# `npm ci` requires package-lock.json — the repo ships one. The build
# script runs tsc and then copy-personas.mjs, which copies personas, the
# dashboard assets, the bundled skills, and the vendored sim-runtime into
# cli/dist.
#
# `--ignore-scripts` skips the postinstall binary downloader (an artifact
# of the old engine-distribution model); the guided-sim flow needs no
# prebuilt binary, only the Rust + SBF toolchains installed above.
WORKDIR /src/cli
RUN npm ci --no-audit --no-fund --ignore-scripts \
 && npm run build \
 && test -f /src/cli/dist/src/index.js \
 && test -d /src/cli/dist/sim-runtime

# --- `riptide` launcher on $PATH --------------------------------------------
# Shim script matching the install.sh pattern: exec Node against the
# compiled CLI entry point so `riptide ...` works anywhere in the image.
RUN printf '#!/usr/bin/env bash\n\
# Riptide CLI launcher — baked into the Docker image\n\
exec node /src/cli/dist/src/index.js "$@"\n' > /usr/local/bin/riptide \
 && chmod +x /usr/local/bin/riptide

# Default working directory for the user's mounted/cloned program. The
# guided-sim flow is driven from inside the user's project root.
WORKDIR /workspace

# One entrypoint, all subcommands. `docker run <image> --help`,
# `docker run <image> init`, `docker run <image> sim run`, etc.
# Override with `--entrypoint bash` for an interactive dev shell.
ENTRYPOINT ["riptide"]
CMD ["--help"]

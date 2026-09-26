#!/usr/bin/env bash
# riptide-assess — Engine bootstrap.
#
# Installs the Riptide Engine if `riptide` is not already on PATH, then
# verifies it. Idempotent: safe to re-run. The Skill runs this itself on
# first use.
#
# Prerequisites: cargo + rustc, node >= 20, and the Solana SBF toolchain
# (cargo-build-sbf). Linux; macOS may work, untested.

set -euo pipefail

if command -v riptide >/dev/null 2>&1; then
  echo "riptide already installed: $(riptide --version 2>/dev/null || echo '(version check failed)')"
  exit 0
fi

echo "riptide not found on PATH — installing the Engine..."
curl -fsSL https://riptide.run/install | sh

# The installer drops a launcher into $HOME/.local/bin.
if ! command -v riptide >/dev/null 2>&1; then
  case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) : ;;
    *)
      echo "riptide installed, but \$HOME/.local/bin is not on PATH:"
      echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      exit 1
      ;;
  esac
fi

riptide --version

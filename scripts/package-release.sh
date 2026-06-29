#!/usr/bin/env bash
# Build the release archive consumed by scripts/install-release.sh and
# scripts/install-release.ps1.
#
# Output contract for each supported target:
#   dist/riptide-<target-triple>.tar.gz
#   dist/riptide-<target-triple>.tar.gz.sha256
#   dist/riptide-<target-triple>.zip
#   dist/riptide-<target-triple>.zip.sha256
#
# The archive includes a bundled Node runtime and the compiled TypeScript
# CLI with production npm dependencies (whose `dist/sim-runtime` carries
# the vendored `riptide-sim` guided-simulation runtime), plus the shipped
# skills, adapter fixtures, examples, and docs. End users who install this
# bundle do not need npm or Node; they bring their own Solana program and
# the SBF toolchain to build it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="${RIPTIDE_RELEASE_OUT_DIR:-$ROOT/dist}"
TARGET="${RIPTIDE_TARGET:-x86_64-unknown-linux-gnu}"
NODE_VERSION="${RIPTIDE_NODE_VERSION:-24.11.1}"
NODE_SHA256="${RIPTIDE_NODE_SHA256:-}"
SKIP_BUILDS=0

usage() {
  cat <<'EOF'
Usage:
  scripts/package-release.sh [options]

Options:
  --target <triple>   Target triple. Currently supported:
                      x86_64-unknown-linux-gnu
                      x86_64-apple-darwin
                      aarch64-apple-darwin
                      x86_64-pc-windows-msvc
  --out-dir <dir>     Output directory. Defaults to ./dist.
  --skip-builds       Reuse existing CLI build outputs.
  -h, --help          Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || { echo "--target requires a value" >&2; exit 1; }
      TARGET="$2"
      shift 2
      ;;
    --out-dir)
      [ "$#" -ge 2 ] || { echo "--out-dir requires a value" >&2; exit 1; }
      OUT_DIR="$2"
      shift 2
      ;;
    --skip-builds)
      SKIP_BUILDS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 1
      ;;
  esac
done

case "$TARGET" in
  x86_64-unknown-linux-gnu)
    NODE_PLATFORM="linux-x64"
    DEFAULT_NODE_SHA256="60e3b0a8500819514aca603487c254298cd776de0698d3cd08f11dba5b8289a8"
    NODE_ARCHIVE_EXT="tar.xz"
    RELEASE_ARCHIVE_EXT="tar.gz"
    ;;
  x86_64-apple-darwin)
    NODE_PLATFORM="darwin-x64"
    DEFAULT_NODE_SHA256="3793aa4aa52eb1f464d7848cd4e254880d9abca989c7cdc79a32c51bfeec1806"
    NODE_ARCHIVE_EXT="tar.xz"
    RELEASE_ARCHIVE_EXT="tar.gz"
    ;;
  aarch64-apple-darwin)
    NODE_PLATFORM="darwin-arm64"
    DEFAULT_NODE_SHA256="064b017da9efd6b5d2bd0fadd56d3b8a50fcb369af3ccf91102c7a07a6cf4deb"
    NODE_ARCHIVE_EXT="tar.xz"
    RELEASE_ARCHIVE_EXT="tar.gz"
    ;;
  x86_64-pc-windows-msvc)
    NODE_PLATFORM="win-x64"
    DEFAULT_NODE_SHA256="5355ae6d7c49eddcfde7d34ac3486820600a831bf81dc3bdca5c8db6a9bb0e76"
    NODE_ARCHIVE_EXT="zip"
    RELEASE_ARCHIVE_EXT="zip"
    ;;
  *)
    echo "unsupported target: $TARGET" >&2
    echo "supported targets: x86_64-unknown-linux-gnu, x86_64-apple-darwin, aarch64-apple-darwin, x86_64-pc-windows-msvc" >&2
    exit 1
    ;;
esac

NODE_SHA256="${NODE_SHA256:-$DEFAULT_NODE_SHA256}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required tool not found on PATH: $1" >&2
    exit 1
  }
}

require node
require npm
require curl
require tar
if [ "$NODE_ARCHIVE_EXT" = "zip" ]; then
  require unzip
fi
if [ "$RELEASE_ARCHIVE_EXT" = "zip" ]; then
  require zip
fi

verify_sha256() {
  local expected="$1"
  local file="$2"
  local actual

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{ print $1 }')"
    [ "$expected" = "$actual" ] || {
      echo "sha256 mismatch for $file: expected $expected, got $actual" >&2
      exit 1
    }
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{ print $1 }')"
    [ "$expected" = "$actual" ] || {
      echo "sha256 mismatch for $file: expected $expected, got $actual" >&2
      exit 1
    }
    return
  fi

  echo "required tool not found on PATH: sha256sum or shasum" >&2
  exit 1
}

write_sha256_file() {
  local file="$1"
  local output="$2"
  local name
  local actual

  name="$(basename "$file")"

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{ print $1 }')"
    printf '%s  %s\n' "$actual" "$name" > "$output"
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{ print $1 }')"
    printf '%s  %s\n' "$actual" "$name" > "$output"
    return
  fi

  echo "required tool not found on PATH: sha256sum or shasum" >&2
  exit 1
}

version="$(node -e "const fs=require('fs'); process.stdout.write(JSON.parse(fs.readFileSync('cli/package.json','utf8')).version)")"

if [ "$SKIP_BUILDS" -eq 0 ]; then
  (cd cli && npm ci --no-audit --no-fund --ignore-scripts && npm run build)
fi

[ -f "$ROOT/cli/dist/src/index.js" ] || {
  echo "missing cli/dist/src/index.js" >&2
  exit 1
}

rm -rf "$OUT_DIR/stage"
mkdir -p "$OUT_DIR/stage"

bundle_name="riptide-$version-$TARGET"
bundle="$OUT_DIR/stage/$bundle_name"
mkdir -p "$bundle/bin" "$bundle/cli" "$bundle/node"

node_archive="node-v$NODE_VERSION-$NODE_PLATFORM.$NODE_ARCHIVE_EXT"
node_url="https://nodejs.org/dist/v$NODE_VERSION/$node_archive"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/riptide-release"
mkdir -p "$cache_dir"
if [ ! -f "$cache_dir/$node_archive" ]; then
  curl -fsSL "$node_url" -o "$cache_dir/$node_archive"
fi
verify_sha256 "$NODE_SHA256" "$cache_dir/$node_archive"
if [ "$NODE_ARCHIVE_EXT" = "zip" ]; then
  unzip -q "$cache_dir/$node_archive" -d "$bundle/node"
  node_root="$(find "$bundle/node" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$node_root" ] || {
    echo "node archive did not extract a root directory" >&2
    exit 1
  }
  cp -R "$node_root/." "$bundle/node/"
  rm -rf "$node_root"
else
  tar -xJf "$cache_dir/$node_archive" -C "$bundle/node" --strip-components=1
fi

cp "$ROOT/cli/package.json" "$bundle/cli/package.json"
cp "$ROOT/cli/npm-shrinkwrap.json" "$bundle/cli/npm-shrinkwrap.json"
cp "$ROOT/cli/README.md" "$bundle/cli/README.md"
cp "$ROOT/cli/LICENSE-MIT" "$bundle/cli/LICENSE-MIT"
cp "$ROOT/cli/LICENSE-APACHE" "$bundle/cli/LICENSE-APACHE"
cp -R "$ROOT/cli/dist" "$bundle/cli/dist"
cp -R "$ROOT/cli/assets" "$bundle/cli/assets"
(cd "$bundle/cli" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts)

cp -R "$ROOT/fixtures" "$bundle/fixtures"
cp -R "$ROOT/examples" "$bundle/examples"
cp -R "$ROOT/skills" "$bundle/skills"
cp "$ROOT/README.md" "$bundle/README.md"
cp "$ROOT/TOOLCHAIN.md" "$bundle/TOOLCHAIN.md"
cp "$ROOT/LICENSE" "$bundle/LICENSE"

if [ "$TARGET" = "x86_64-pc-windows-msvc" ]; then
  cat > "$bundle/bin/riptide.cmd" <<'EOF'
@echo off
setlocal
set "ROOT=%~dp0.."
"%ROOT%\node\node.exe" "%ROOT%\cli\dist\src\index.js" %*
EOF
else
  cat > "$bundle/bin/riptide" <<'EOF'
#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$ROOT/node/bin/node" "$ROOT/cli/dist/src/index.js" "$@"
EOF
  chmod +x "$bundle/bin/riptide"
fi

asset="riptide-$TARGET.$RELEASE_ARCHIVE_EXT"
mkdir -p "$OUT_DIR"
if [ "$RELEASE_ARCHIVE_EXT" = "zip" ]; then
  (cd "$OUT_DIR/stage" && zip -qr "$OUT_DIR/$asset" "$bundle_name")
else
  tar -czf "$OUT_DIR/$asset" -C "$OUT_DIR/stage" "$bundle_name"
fi
write_sha256_file "$OUT_DIR/$asset" "$OUT_DIR/$asset.sha256"

echo "release bundle written:"
echo "  $OUT_DIR/$asset"
echo "  $OUT_DIR/$asset.sha256"

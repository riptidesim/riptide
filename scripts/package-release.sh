#!/usr/bin/env bash
# Build the release tarball consumed by scripts/install-release.sh.
#
# Output contract for each supported target:
#   dist/riptide-<target-triple>.tar.gz
#   dist/riptide-<target-triple>.tar.gz.sha256
#
# The tarball includes a bundled Node runtime, the compiled TypeScript
# CLI with production npm dependencies, the native engine, shipped
# fixtures/examples, and the shipped program .so files plus their
# fixture deploy keypairs. End users who install this bundle do not need
# Rust, npm, Node, or cargo-build-sbf.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="${RIPTIDE_RELEASE_OUT_DIR:-$ROOT/dist}"
TARGET="${RIPTIDE_TARGET:-x86_64-unknown-linux-gnu}"
NODE_VERSION="${RIPTIDE_NODE_VERSION:-24.11.1}"
NODE_SHA256="${RIPTIDE_NODE_SHA256:-60e3b0a8500819514aca603487c254298cd776de0698d3cd08f11dba5b8289a8}"
SKIP_BUILDS=0
SKIP_SBF=0

usage() {
  cat <<'EOF'
Usage:
  scripts/package-release.sh [options]

Options:
  --target <triple>   Target triple. Currently supported:
                      x86_64-unknown-linux-gnu
  --out-dir <dir>     Output directory. Defaults to ./dist.
  --skip-builds       Reuse existing engine/CLI build outputs.
  --skip-sbf          Reuse existing shipped program .so files.
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
    --skip-sbf)
      SKIP_SBF=1
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

if [ "$TARGET" != "x86_64-unknown-linux-gnu" ]; then
  echo "unsupported target: $TARGET" >&2
  echo "supported targets: x86_64-unknown-linux-gnu" >&2
  exit 1
fi

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required tool not found on PATH: $1" >&2
    exit 1
  }
}

require node
require npm
require cargo
require curl
require tar
require sha256sum

version="$(node -e "const fs=require('fs'); process.stdout.write(JSON.parse(fs.readFileSync('cli/package.json','utf8')).version)")"
engine_version="$(awk -F' = ' '$1 == "version" { gsub(/"/, "", $2); print $2; exit }' engine/Cargo.toml)"
if [ "$version" != "$engine_version" ]; then
  echo "version mismatch: cli/package.json=$version engine/Cargo.toml=$engine_version" >&2
  exit 1
fi

build_program_so() {
  local prog_dir="$1"
  local so_name="$2"
  local so_path="$ROOT/programs/$prog_dir/target/deploy/$so_name"
  local keypair_name="${so_name%.so}-keypair.json"
  local keypair_path="$ROOT/programs/$prog_dir/target/deploy/$keypair_name"

  if [ "$SKIP_SBF" -eq 0 ]; then
    if command -v cargo-build-sbf >/dev/null 2>&1; then
      cargo build-sbf --manifest-path "programs/$prog_dir/Cargo.toml"
    else
      cargo +solana build-sbf --manifest-path "programs/$prog_dir/Cargo.toml"
    fi
  fi

  [ -f "$so_path" ] || {
    echo "missing shipped program artifact: $so_path" >&2
    echo "build it with: cargo build-sbf --manifest-path programs/$prog_dir/Cargo.toml" >&2
    exit 1
  }
  [ -f "$keypair_path" ] || {
    echo "missing shipped program keypair: $keypair_path" >&2
    echo "build it with: cargo build-sbf --manifest-path programs/$prog_dir/Cargo.toml" >&2
    exit 1
  }
}

if [ "$SKIP_BUILDS" -eq 0 ]; then
  cargo build --release -p riptide-engine
  (cd cli && npm ci --no-audit --no-fund --ignore-scripts && npm run build)
fi

[ -x "$ROOT/target/release/riptide-engine" ] || {
  echo "missing target/release/riptide-engine" >&2
  exit 1
}
[ -f "$ROOT/cli/dist/src/index.js" ] || {
  echo "missing cli/dist/src/index.js" >&2
  exit 1
}

build_program_so lending_pool lending_pool.so
build_program_so resource_grinder resource_grinder.so
build_program_so admin_mock_oracle admin_mock_oracle.so
build_program_so perpetuals perpetuals.so
build_program_so amm amm.so
build_program_so liquid-staking liquid_staking.so
build_program_so stablecoin stablecoin.so

rm -rf "$OUT_DIR/stage"
mkdir -p "$OUT_DIR/stage"

bundle_name="riptide-$version-$TARGET"
bundle="$OUT_DIR/stage/$bundle_name"
mkdir -p "$bundle/bin" "$bundle/target/release" "$bundle/cli" "$bundle/node"

cp "$ROOT/target/release/riptide-engine" "$bundle/target/release/riptide-engine"
cp "$ROOT/target/release/riptide-engine" "$bundle/bin/riptide-engine"
chmod +x "$bundle/target/release/riptide-engine" "$bundle/bin/riptide-engine"

node_platform="linux-x64"
node_tar="node-v$NODE_VERSION-$node_platform.tar.xz"
node_url="https://nodejs.org/dist/v$NODE_VERSION/$node_tar"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/riptide-release"
mkdir -p "$cache_dir"
if [ ! -f "$cache_dir/$node_tar" ]; then
  curl -fsSL "$node_url" -o "$cache_dir/$node_tar"
fi
echo "$NODE_SHA256  $cache_dir/$node_tar" | sha256sum -c -
tar -xJf "$cache_dir/$node_tar" -C "$bundle/node" --strip-components=1

cp "$ROOT/cli/package.json" "$bundle/cli/package.json"
cp "$ROOT/cli/npm-shrinkwrap.json" "$bundle/cli/npm-shrinkwrap.json"
cp "$ROOT/cli/README.md" "$bundle/cli/README.md"
cp "$ROOT/cli/LICENSE-MIT" "$bundle/cli/LICENSE-MIT"
cp "$ROOT/cli/LICENSE-APACHE" "$bundle/cli/LICENSE-APACHE"
cp -R "$ROOT/cli/dist" "$bundle/cli/dist"
cp -R "$ROOT/cli/assets" "$bundle/cli/assets"
(cd "$bundle/cli" && "$bundle/node/bin/npm" ci --omit=dev --no-audit --no-fund --ignore-scripts)

copy_program_artifact() {
  local prog_dir="$1"
  local so_name="$2"
  local keypair_name="${so_name%.so}-keypair.json"
  mkdir -p "$bundle/programs/$prog_dir/target/deploy"
  cp "$ROOT/programs/$prog_dir/target/deploy/$so_name" \
     "$bundle/programs/$prog_dir/target/deploy/$so_name"
  # The shipped demo deploy keypairs are public fixture material, not
  # production authority keys. Owner-aware generic adapters derive local
  # sibling program owners from these companion files, so omitting them
  # makes release installs fail `riptide doctor` and engine boot.
  cp "$ROOT/programs/$prog_dir/target/deploy/$keypair_name" \
     "$bundle/programs/$prog_dir/target/deploy/$keypair_name"
}

copy_program_artifact lending_pool lending_pool.so
copy_program_artifact resource_grinder resource_grinder.so
copy_program_artifact admin_mock_oracle admin_mock_oracle.so
copy_program_artifact perpetuals perpetuals.so
copy_program_artifact amm amm.so
copy_program_artifact liquid-staking liquid_staking.so
copy_program_artifact stablecoin stablecoin.so

cp -R "$ROOT/fixtures" "$bundle/fixtures"
cp -R "$ROOT/examples" "$bundle/examples"
cp -R "$ROOT/scripts" "$bundle/scripts"
cp -R "$ROOT/skills" "$bundle/skills"
cp "$ROOT/README.md" "$bundle/README.md"
cp "$ROOT/TOOLCHAIN.md" "$bundle/TOOLCHAIN.md"
cp "$ROOT/LICENSE" "$bundle/LICENSE"

mkdir -p "$bundle/.riptide"
ln -s ../fixtures/scenarios "$bundle/.riptide/scenarios"

cat > "$bundle/bin/riptide" <<'EOF'
#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
: "${RIPTIDE_ENGINE_BIN:=$ROOT/bin/riptide-engine}"
export RIPTIDE_ENGINE_BIN
exec "$ROOT/node/bin/node" "$ROOT/cli/dist/src/index.js" "$@"
EOF
chmod +x "$bundle/bin/riptide"

asset="riptide-$TARGET.tar.gz"
mkdir -p "$OUT_DIR"
tar -czf "$OUT_DIR/$asset" -C "$OUT_DIR/stage" "$bundle_name"
(cd "$OUT_DIR" && sha256sum "$asset" > "$asset.sha256")

echo "release bundle written:"
echo "  $OUT_DIR/$asset"
echo "  $OUT_DIR/$asset.sha256"

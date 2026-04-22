#!/bin/sh
# Assert that a Riptide evidence pack's canonical_hash matches an
# expected SHA256.
#
# Usage:
#   scripts/ci/assert-canonical-hash.sh <pack-manifest.json> <expected-sha256>
#
# Exits 0 on match, 1 on mismatch (with a diagnostic naming expected,
# actual, and the pack manifest path), 2 on argument / read errors.
#
# POSIX sh only — no bashisms. Reviewers running on macOS stock /sh or
# Alpine /ash see the same behavior as Linux /dash.
#
# Dependencies: `jq`. Falls back to a grep+sed extraction if `jq` is
# missing so downstream adopters without jq still get a diagnostic
# (though jq is strongly recommended — the fallback assumes the engine
# writes the manifest with the canonical_hash key on its own line,
# which the current pack emitter does).

set -eu

if [ "$#" -ne 2 ]; then
    cat >&2 <<EOF
usage: $0 <pack-manifest.json> <expected-sha256>

Asserts that the pack's canonical_hash matches <expected-sha256>.
Exits 1 on mismatch with a diagnostic naming the pack manifest path.
EOF
    exit 2
fi

manifest="$1"
expected="$2"

if [ ! -f "$manifest" ]; then
    printf 'riptide: pack manifest not found at %s\n' "$manifest" >&2
    exit 2
fi

if command -v jq >/dev/null 2>&1; then
    actual=$(jq -r '.canonical_hash' <"$manifest")
else
    # Fallback: parse canonical_hash out of the manifest without jq.
    # The engine pack emitter writes pretty-printed JSON with one key
    # per line, so a line match + sed extraction is reliable.
    actual=$(
        sed -n 's/^[[:space:]]*"canonical_hash"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
            "$manifest" | head -n 1
    )
fi

if [ -z "$actual" ] || [ "$actual" = "null" ]; then
    printf 'riptide: could not read canonical_hash from %s\n' "$manifest" >&2
    exit 2
fi

if [ "$actual" = "$expected" ]; then
    printf 'riptide: canonical_hash OK (%s) at %s\n' "$actual" "$manifest"
    exit 0
fi

cat >&2 <<EOF
riptide: canonical_hash MISMATCH
  expected: $expected
  actual:   $actual
  pack manifest: $manifest

The replay produced a different byte-level result than the committed
expected hash. Investigate the drift before shipping — do not regenerate
the expected hash without understanding the change.
EOF
exit 1

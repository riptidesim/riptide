#!/usr/bin/env bash
# riptide-adapt skill wrapper (Sprint 3 · T09).
#
# Thin shell wrapper around `riptide adapt`. Not under 50 lines by
# accident — the whole point of this task is to be a distribution
# channel, not a second code path. If you find yourself editing prompts
# or adapter-generation logic here, STOP and edit
# `cli/src/commands/adapt.ts` in the riptide-monorepo instead.

set -euo pipefail

IDL_PATH="${1:-}"
if [[ -z "${IDL_PATH}" ]]; then
  IDL_PATH="$(find . -type f -name '*.json' -path '*/idl*' 2>/dev/null | head -1 || true)"
fi
if [[ -z "${IDL_PATH}" || ! -f "${IDL_PATH}" ]]; then
  echo "riptide-adapt: no IDL path given and none auto-detected under ./**/idl*" >&2
  echo "usage: riptide-adapt <idl.json>" >&2
  exit 2
fi

OUT_PATH="${2:-${IDL_PATH%.json}.adapter.toml}"

RIPTIDE_BIN="${RIPTIDE_BIN:-riptide}"
if ! command -v "${RIPTIDE_BIN}" >/dev/null 2>&1; then
  echo "riptide-adapt: \`${RIPTIDE_BIN}\` not on PATH — install the riptide CLI first" >&2
  exit 2
fi

exec "${RIPTIDE_BIN}" adapt \
  --idl "${IDL_PATH}" \
  --out "${OUT_PATH}" \
  ${RIPTIDE_LLM_ENDPOINT:+--endpoint "${RIPTIDE_LLM_ENDPOINT}"} \
  ${RIPTIDE_LLM_MODEL:+--model "${RIPTIDE_LLM_MODEL}"}

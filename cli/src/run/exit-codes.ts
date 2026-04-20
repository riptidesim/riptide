// Exit-code semantics for `riptide run`. Pinned by
// `cli/test/run-output.test.ts` — every change here must update the
// pin test intentionally.
//
// Contract (R4.3, Sprint 8):
// - 0   : all discovered scenarios ran + zero invariants fired
// - 1   : one or more scenarios had at least one invariant fire
// - 2   : setup error (discovery missing, file not found, adapter load
//         failure, engine binary missing)
// - 3   : internal partial-abort (engine crashed mid-sweep — NOT
//         signal-initiated)
// - 130 : SIGINT-aborted (Unix convention, matches jest)

import type { RunSummary } from "./loop.js";

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  INVARIANT_FIRE: 1,
  SETUP_ERROR: 2,
  PARTIAL_ABORT: 3,
  SIGINT: 130
});

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export function exitCodeFromSummary(summary: RunSummary): ExitCode {
  if (summary.signalAborted) return EXIT_CODES.SIGINT;
  if (summary.partialAbort) return EXIT_CODES.PARTIAL_ABORT;
  if (summary.fail > 0) return EXIT_CODES.INVARIANT_FIRE;
  return EXIT_CODES.SUCCESS;
}

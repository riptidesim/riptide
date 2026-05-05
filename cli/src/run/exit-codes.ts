// Exit-code semantics for `riptide run`. Pinned by
// `cli/test/run-output.test.ts` — every change here must update the
// pin test intentionally.
//
// Contract:
// - 0   : all discovered scenarios ran + zero observed failures, zero errors
// - 1   : one or more scenarios observed failure, either by invariant fire
//         or by scenario actions failing with zero successful executions
// - 2   : setup/runtime error — any scenario errored (wrong adapter,
//         missing binary, engine exit 2, etc.) OR a global setup
//         failure short-circuited the sweep before it started.
// - 3   : internal partial-abort — reserved for post-hoc rollback
//         scenarios the current run loop doesn't surface; kept in
//         the enum so external CI integrations pinning it don't
//         break, but never emitted by exitCodeFromSummary today.
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
  if (summary.error > 0) return EXIT_CODES.SETUP_ERROR;
  if (summary.fail > 0) return EXIT_CODES.INVARIANT_FIRE;
  return EXIT_CODES.SUCCESS;
}

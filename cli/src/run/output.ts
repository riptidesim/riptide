// Jest-style output formatter for `riptide run`.
//
// Subscribes to the RunEvent stream emitted by runScenarios() and
// writes per-scenario pass/fail lines, a summary line, and per-
// failure detail. Exact format pinned by `cli/test/run-output.test.ts`
// — do NOT change any literal below without updating the pin tests.
//
// FORMAT CONTRACT (Sprint 8 T04, frozen per R4.5):
//
// Per-scenario PASS line:   `✓ <name>  (<secs>s, 0 invariant fires)`
// Per-scenario FAIL line:   `✗ <name>  (<secs>s, <N> invariant fires: <first-inv> at tick <tick>)`
// Plain-ASCII fallback:     `ok` / `FAIL` replacing `✓` / `✗`
//   (triggers on `!process.stdout.isTTY` OR `NO_COLOR` set)
// Summary line (always):    `<P> pass · <F> fail · <K> skip`
// Per-failure block:        `  ✗ <name>` + one `    - <inv> at tick <tick>` per fire
// Dashboard echo:           printed only when `--serve` was passed
//
// Schema for `.riptide/last-run.json` that this formatter + the
// `--only-failing` filter both consume is documented at the top of
// `cli/src/run/last-run.ts` and is frozen from Sprint 8 T03 onward.

import type { Writable } from "node:stream";

import type { RunEvent, RunSummary } from "./loop.js";
import type { InvariantFire, ScenarioRecord } from "./last-run.js";

export interface FormatterOptions {
  stdout: Writable;
  stderr: Writable;
  /** Force plain-ASCII glyphs regardless of TTY / NO_COLOR detection. */
  plainAscii?: boolean;
  /** If set, echoed at end when a non-zero pass count wrote artifacts. */
  dashboardUrl?: string | null;
}

export interface Formatter {
  handle: (event: RunEvent) => void;
}

export function shouldUsePlainAscii(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return true;
  if (!isTTY) return true;
  return false;
}

export function createJestFormatter(opts: FormatterOptions): Formatter {
  const plain = opts.plainAscii ?? shouldUsePlainAscii(process.env, Boolean(process.stdout.isTTY));
  const okGlyph = plain ? "ok" : "✓";
  const failGlyph = plain ? "FAIL" : "✗";

  function handle(event: RunEvent): void {
    switch (event.type) {
      case "run_start":
      case "scenario_start":
      case "warning":
        return;
      case "scenario_end": {
        opts.stdout.write(formatScenarioLine(event.record, okGlyph, failGlyph) + "\n");
        return;
      }
      case "run_end": {
        writeSummary(opts.stdout, event.summary, failGlyph);
        if (opts.dashboardUrl) {
          opts.stdout.write(`Dashboard: ${opts.dashboardUrl}\n`);
        }
        return;
      }
    }
  }

  return { handle };
}

export function formatScenarioLine(
  record: ScenarioRecord,
  okGlyph: string,
  failGlyph: string
): string {
  const secs = record.wall_clock_s.toFixed(1);
  if (record.status === "pass") {
    return `${okGlyph} ${record.name}  (${secs}s, 0 invariant fires)`;
  }
  if (record.status === "fail") {
    const n = record.invariant_fires.length;
    const first = record.invariant_fires[0];
    const detail = first ? `: ${first.name} at tick ${first.tick}` : "";
    return `${failGlyph} ${record.name}  (${secs}s, ${n} invariant fire${n === 1 ? "" : "s"}${detail})`;
  }
  // aborted
  return `${failGlyph} ${record.name}  (${secs}s, aborted${record.error ? `: ${record.error}` : ""})`;
}

export function formatSummaryLine(summary: RunSummary): string {
  return `${summary.pass} pass · ${summary.fail} fail · ${summary.skipped + summary.aborted} skip`;
}

export function formatFailureBlock(record: ScenarioRecord, failGlyph: string): string {
  const lines: string[] = [];
  lines.push(`  ${failGlyph} ${record.name}`);
  if (record.status === "aborted" && record.error) {
    lines.push(`    - aborted: ${record.error}`);
  }
  for (const fire of record.invariant_fires) {
    lines.push(`    - ${fire.name} at tick ${fire.tick}`);
  }
  return lines.join("\n");
}

function writeSummary(stdout: Writable, summary: RunSummary, failGlyph: string): void {
  // blank separator line before summary so per-scenario list doesn't
  // collide with the totals visually. jest does the same.
  stdout.write("\n");
  stdout.write(formatSummaryLine(summary) + "\n");

  const failures = summary.scenarios.filter(
    (s) => s.status === "fail" || s.status === "aborted"
  );
  if (failures.length > 0) {
    stdout.write("\n");
    for (const record of failures) {
      stdout.write(formatFailureBlock(record, failGlyph) + "\n");
    }
  }
}

/** Convenience helper for plain-text extraction of invariant-fire detail. */
export function firstFireOrNull(fires: InvariantFire[]): InvariantFire | null {
  return fires.length > 0 ? fires[0]! : null;
}

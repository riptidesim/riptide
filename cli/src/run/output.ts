// Jest-style output formatter for `riptide run`.
//
// Subscribes to the RunEvent stream emitted by runScenarios() and
// writes per-scenario pass/fail/error lines, a summary line, and
// per-failure detail. Exact format pinned by `cli/test/run-output.test.ts`
// — do NOT change any literal below without updating the pin tests.
//
// FORMAT CONTRACT (R4.5 frozen + R9.2 expanded classifier):
//
// Per-scenario PASS line:    `✓ <name>  (<secs>s, 0 invariant fires)`
// Per-scenario FAIL line:    `✗ <name>  (<secs>s, <N> invariant fires: <first-inv> at tick <tick>)`
// Per-scenario ERROR line:   `! <name>  (<secs>s, error: <message-head>)`
// Plain-ASCII fallback:      `ok` / `FAIL` / `ERROR` replace glyphs
//   (triggers on `!process.stdout.isTTY` OR `NO_COLOR` set)
// Summary line (always):     `<P> pass · <F> fail · <E> error · <K> skip`
// Per-failure block (fail):  `  ✗ <name>` + one `    - <inv> at tick <tick>` per fire
// Per-failure block (error): `  ! <name>` + `    - error: <message>`
// Dashboard echo:            printed only when `--serve` was passed
//
// Schema for `.riptide/last-run.json` that this formatter + the
// `--only-failing` filter both consume is documented at the top of
// `cli/src/run/last-run.ts`.

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

export interface Glyphs {
  ok: string;
  fail: string;
  error: string;
}

export function glyphsForMode(plain: boolean): Glyphs {
  return plain
    ? { ok: "ok", fail: "FAIL", error: "ERROR" }
    : { ok: "✓", fail: "✗", error: "!" };
}

export function createJestFormatter(opts: FormatterOptions): Formatter {
  const plain = opts.plainAscii ?? shouldUsePlainAscii(process.env, Boolean(process.stdout.isTTY));
  const glyphs = glyphsForMode(plain);

  function handle(event: RunEvent): void {
    switch (event.type) {
      case "run_start":
      case "scenario_start":
      case "warning":
        return;
      case "scenario_end": {
        opts.stdout.write(formatScenarioLine(event.record, glyphs.ok, glyphs.fail, glyphs.error) + "\n");
        return;
      }
      case "run_end": {
        writeSummary(opts.stdout, event.summary, glyphs);
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
  failGlyph: string,
  errorGlyph: string = failGlyph
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
  if (record.status === "skipped") {
    return `- ${record.name}  (skipped${record.error ? `: ${record.error}` : ""})`;
  }
  // error
  const head = record.error ? firstLine(record.error) : "setup failed";
  return `${errorGlyph} ${record.name}  (${secs}s, error: ${head})`;
}

export function formatSummaryLine(summary: RunSummary): string {
  return (
    `${summary.pass} pass · ${summary.fail} fail · ${summary.error} error · ${summary.skipped} skip`
  );
}

export function formatFailureBlock(
  record: ScenarioRecord,
  failGlyph: string,
  errorGlyph: string = failGlyph
): string {
  const lines: string[] = [];
  if (record.status === "error") {
    lines.push(`  ${errorGlyph} ${record.name}`);
    if (record.error) {
      lines.push(`    - error: ${record.error}`);
    }
    return lines.join("\n");
  }
  lines.push(`  ${failGlyph} ${record.name}`);
  for (const fire of record.invariant_fires) {
    lines.push(`    - ${fire.name} at tick ${fire.tick}`);
  }
  return lines.join("\n");
}

function writeSummary(stdout: Writable, summary: RunSummary, glyphs: Glyphs): void {
  // blank separator line before summary so per-scenario list doesn't
  // collide with the totals visually. jest does the same.
  stdout.write("\n");
  stdout.write(formatSummaryLine(summary) + "\n");

  const interesting = summary.scenarios.filter(
    (s) => s.status === "fail" || s.status === "error"
  );
  if (interesting.length > 0) {
    stdout.write("\n");
    for (const record of interesting) {
      stdout.write(formatFailureBlock(record, glyphs.fail, glyphs.error) + "\n");
    }
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

/** Convenience helper for plain-text extraction of invariant-fire detail. */
export function firstFireOrNull(fires: InvariantFire[]): InvariantFire | null {
  return fires.length > 0 ? fires[0]! : null;
}

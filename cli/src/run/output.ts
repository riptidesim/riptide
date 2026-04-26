// Jest-style output formatter for `riptide run`.
//
// Subscribes to the RunEvent stream emitted by runScenarios() and
// writes per-scenario pass/fail/error lines, a summary line, and
// per-failure detail. Exact format pinned by `cli/test/run-output.test.ts`
// — do NOT change any literal below without updating the pin tests.
//
// FORMAT CONTRACT (R4.5 frozen + R9.2 classifier + R10 hygiene):
//
// Per-scenario PASS line:    `✓ <name>  (<secs>s, 0 invariant fires)`
// Per-scenario FAIL line:    `✗ <name>  (<secs>s, <N> invariant fires: <first-inv> at tick <tick>)`
// Per-scenario ERROR line:   `! <name>  (<secs>s, error: <message-head>)`
// Plain-ASCII fallback:      `ok` / `FAIL` / `ERROR` replace glyphs
//   (triggers on `!process.stdout.isTTY` OR `NO_COLOR` set)
// Summary line (always):     `<P> pass · <F> fail · <E> error · <K> skip`
// Per-failure block (fail):  `  ✗ <name>` + one `    - <inv> at tick <tick>` per fire
//                            + optional `    engine stderr:` tail (R10.4: never inline)
// Per-failure block (error): `  ! <name>` + `    - error: <message>` + stderr tail
// Dashboard echo:            printed only when `--serve` was passed
//
// Colors (R10.3): green ✓/pass · red ✗/fail · yellow !/error · bold summary.
// Paths displayed (either in the scenario line message or inside captured
// stderr) are CWD-relativized before print (R10.2). Stderr capture is a
// single source — no duplication between inline + summary (R10.4).
//
// Schema for `.riptide/last-run.json` that this formatter + the
// `--only-failing` filter both consume is documented at the top of
// `cli/src/run/last-run.ts`.

import type { Writable } from "node:stream";

import {
  pickColorizer,
  relativizePathsInBlob,
  shouldUseColor,
  type Colorizer
} from "../display/index.js";

import type { RunEvent, RunSummary } from "./loop.js";
import type { InvariantFire, ScenarioRecord } from "./last-run.js";
import type { Verdict } from "./interpretation.js";

export interface FormatterOptions {
  stdout: Writable;
  stderr: Writable;
  /** Force plain-ASCII glyphs regardless of TTY / NO_COLOR detection. */
  plainAscii?: boolean;
  /** Force color escape codes on/off regardless of env detection. Defaults to env-based. */
  color?: boolean;
  /** CWD used for path relativization in displayed paths and engine stderr. */
  cwd?: string;
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
  inconclusive: string;
  error: string;
}

export function glyphsForMode(plain: boolean): Glyphs {
  return plain
    ? { ok: "ok", fail: "FAIL", inconclusive: "?", error: "ERROR" }
    : { ok: "✓", fail: "✗", inconclusive: "?", error: "!" };
}

export function createJestFormatter(opts: FormatterOptions): Formatter {
  const plain = opts.plainAscii ?? shouldUsePlainAscii(process.env, Boolean(process.stdout.isTTY));
  const useColor = opts.color ?? shouldUseColor(process.env, Boolean(process.stdout.isTTY));
  const glyphs = glyphsForMode(plain);
  const c = pickColorizer(useColor);
  const cwd = opts.cwd ?? process.cwd();

  function handle(event: RunEvent): void {
    switch (event.type) {
      case "run_start":
      case "scenario_start":
      case "warning":
        return;
      case "scenario_end": {
        const raw = formatScenarioLine(
          event.record,
          glyphs.ok,
          glyphs.fail,
          glyphs.error,
          glyphs.inconclusive
        );
        const relativized = relativizePathsInBlob(raw, cwd);
        opts.stdout.write(colorizeScenarioLine(relativized, event.record, c) + "\n");
        return;
      }
      case "run_end": {
        writeSummary(opts.stdout, event.summary, glyphs, c, cwd);
        if (opts.dashboardUrl) {
          opts.stdout.write(c.cyan(`Dashboard: ${opts.dashboardUrl}`) + "\n");
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
  errorGlyph: string = failGlyph,
  inconclusiveGlyph: string = "?"
): string {
  const secs = record.wall_clock_s.toFixed(1);
  const interpretation = record.interpretation;
  if (interpretation) {
    const confidence = `confidence: ${interpretation.confidence}`;
    const coverage = `coverage: ${interpretation.coverage}`;
    if (interpretation.verdict === "no-failure-observed") {
      return `${okGlyph} ${record.name}  (${secs}s, no failure observed, ${confidence}, ${coverage})`;
    }
    if (interpretation.verdict === "failure-observed") {
      const fireDetail = invariantFireDetail(record.invariant_fires);
      return `${failGlyph} ${record.name}  (${secs}s, failure observed, ${confidence}, ${coverage}${fireDetail})`;
    }
    if (interpretation.verdict === "inconclusive") {
      const fireDetail = invariantFireDetail(record.invariant_fires);
      return `${inconclusiveGlyph} ${record.name}  (${secs}s, inconclusive, ${confidence}, ${coverage}${fireDetail})`;
    }
    const head = record.error ? firstLine(record.error) : setupHead(interpretation.summary);
    return `${errorGlyph} ${record.name}  (${secs}s, setup failed: ${head}, ${confidence}, ${coverage})`;
  }

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

export function formatVerdictTotalsLine(summary: RunSummary): string | null {
  const totals: Record<Verdict, number> = {
    "failure-observed": 0,
    "no-failure-observed": 0,
    inconclusive: 0,
    "setup-error": 0
  };
  for (const record of summary.scenarios) {
    const verdict = record.interpretation?.verdict;
    if (verdict) totals[verdict] += 1;
  }
  const parts = (Object.keys(totals) as Verdict[])
    .filter((verdict) => totals[verdict] > 0)
    .map((verdict) => `${totals[verdict]} ${verdict}`);
  return parts.length > 0 ? `verdicts: ${parts.join(" · ")}` : null;
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

export function formatNextActionBlock(summary: RunSummary): string | null {
  const records = summary.scenarios.filter((record) => {
    const verdict = record.interpretation?.verdict;
    return (
      verdict === "failure-observed" ||
      verdict === "inconclusive" ||
      verdict === "setup-error"
    );
  });
  if (records.length === 0) return null;

  const lines = ["Next action:"];
  for (const record of records) {
    const action =
      record.interpretation?.next_action ?? "Inspect the run artifacts, then rerun the scenario.";
    const inspectPath = record.artifacts_dir ?? summary.runCollectionPath;
    lines.push(`  - ${record.name}: ${action} Inspect ${inspectPath}.`);
  }
  return lines.join("\n");
}

function colorizeScenarioLine(line: string, record: ScenarioRecord, c: Colorizer): string {
  if (record.interpretation?.verdict === "failure-observed") return c.red(line);
  if (
    record.interpretation?.verdict === "inconclusive" ||
    record.interpretation?.verdict === "setup-error"
  ) {
    return c.yellow(line);
  }
  if (record.interpretation?.verdict === "no-failure-observed") return c.green(line);
  if (record.status === "pass") return c.green(line);
  if (record.status === "fail") return c.red(line);
  if (record.status === "error") return c.yellow(line);
  return c.dim(line);
}

function colorizeFailureHeader(
  record: ScenarioRecord,
  headerLine: string,
  c: Colorizer
): string {
  if (record.status === "error") return c.yellow(headerLine);
  return c.red(headerLine);
}

function writeSummary(
  stdout: Writable,
  summary: RunSummary,
  glyphs: Glyphs,
  c: Colorizer,
  cwd: string
): void {
  stdout.write("\n");
  stdout.write(c.bold(formatSummaryLine(summary)) + "\n");
  const verdictTotals = formatVerdictTotalsLine(summary);
  if (verdictTotals) {
    stdout.write(c.bold(verdictTotals) + "\n");
  }

  const interesting = summary.scenarios.filter(
    (s) => s.status === "fail" || s.status === "error"
  );
  if (interesting.length > 0) {
    stdout.write("\n");
    for (const record of interesting) {
      const block = formatFailureBlock(record, glyphs.fail, glyphs.error);
      const firstNewline = block.indexOf("\n");
      const header = firstNewline === -1 ? block : block.slice(0, firstNewline);
      const body = firstNewline === -1 ? "" : block.slice(firstNewline + 1);
      stdout.write(colorizeFailureHeader(record, header, c) + "\n");
      if (body) {
        stdout.write(relativizePathsInBlob(body, cwd) + "\n");
      }
      if (record.engine_stderr && record.engine_stderr.trim().length > 0) {
        stdout.write(c.dim("    engine stderr:") + "\n");
        const rewritten = relativizePathsInBlob(record.engine_stderr, cwd);
        for (const raw of rewritten.split("\n")) {
          if (raw.length === 0) continue;
          stdout.write(c.dim(`      ${raw}`) + "\n");
        }
      }
    }
  }

  const nextAction = formatNextActionBlock(summary);
  if (nextAction) {
    stdout.write("\n");
    stdout.write(relativizePathsInBlob(nextAction, cwd) + "\n");
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

function invariantFireDetail(fires: InvariantFire[]): string {
  const n = fires.length;
  if (n === 0) return "";
  const first = fires[0];
  const firstDetail = first ? `: ${first.name} at tick ${first.tick}` : "";
  return `, ${n} invariant fire${n === 1 ? "" : "s"}${firstDetail}`;
}

function setupHead(summary: string): string {
  const prefix = "Setup failed:";
  const line = firstLine(summary);
  return line.startsWith(prefix) ? line.slice(prefix.length).trim().replace(/\.$/, "") : line;
}

/** Convenience helper for plain-text extraction of invariant-fire detail. */
export function firstFireOrNull(fires: InvariantFire[]): InvariantFire | null {
  return fires.length > 0 ? fires[0]! : null;
}

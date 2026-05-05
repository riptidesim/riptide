// `.riptide/last-run.json` schema + read/write helpers.
//
// schema_version = 1 — consumed by `--only-failing` and the output
// formatter. Every `riptide run` invocation writes this file at the
// end (including SIGINT-aborted runs). Documented here as the single
// source of truth for the formatter.
//
// ----------------------------------------------------------------------
// SCHEMA v1:
//
// {
//   "schema_version": 1,
//   "started_at": "<ISO-8601 UTC>",
//   "finished_at": "<ISO-8601 UTC>",
//   "signal_aborted": <boolean>,   // true if SIGINT landed mid-sweep
//   "partial_abort": <boolean>,    // true if engine crashed mid-scenario (non-signal)
//   "scenarios": [
//     {
//       "name": "hero-grid/w25-s40",       // discovery-derived name
//       "run_config_path": "/abs/path/run-config.json",
//       "status": "pass" | "fail" | "error" | "skipped",
//       "wall_clock_s": <number>,          // 3-decimal seconds
//       "invariant_fires": [
//         { "name": "<invariant-name>", "tick": <number> }
//       ],
//       "artifacts_dir": "<abs-or-rel path>",  // omitted when no result was produced
//       "error": "<string>"                    // omitted unless setup/runtime error
//     },
//     ...
//   ]
// }
//
// Status mapping:
// - "pass"    — scenario completed, zero observed failures
// - "fail"    — scenario completed, and an invariant fired or all
//               scenario actions were rejected
// - "error"   — engine exited non-zero mid-setup or mid-run, or the
//               orchestrator itself failed (missing binary, wrong
//               adapter, etc.). No trustworthy SimulationResult.
// - "skipped" — not executed because SIGINT landed before it started.
//
// Back-compat: readLastRun normalizes stale `status: "aborted"` values to
// `"error"`, so --only-failing keeps matching the same scenarios without
// forcing a rerun.
//
// ----------------------------------------------------------------------

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RunInterpretation } from "./interpretation.js";

export const LAST_RUN_FILE_REL = path.join(".riptide", "last-run.json");
export const LAST_RUN_SCHEMA_VERSION = 1 as const;

export interface InvariantFire {
  name: string;
  tick: number;
}

export type ScenarioStatus = "pass" | "fail" | "error" | "skipped";

export interface ScenarioSweepRecord {
  size: number;
  seed_root: number;
  fired_count: number;
  engine_error_count: number;
  summary_path: string;
  report_path: string;
  first_fire_cell?: string;
  fail_fast: boolean;
  status: "all_pass" | "fired" | "engine_error" | "interrupted";
}

export interface ScenarioRecord {
  name: string;
  run_config_path: string;
  status: ScenarioStatus;
  wall_clock_s: number;
  invariant_fires: InvariantFire[];
  artifacts_dir?: string;
  /** Additive sweep metadata for `riptide run` stress sweeps. */
  sweep?: ScenarioSweepRecord;
  error?: string;
  /** Additive run-evidence interpretation attached by `runScenarios()`. */
  interpretation?: RunInterpretation;
  /**
   * Captured engine stderr, populated when the run loop ran in silent
   * mode. Transient — not serialized to `.riptide/last-run.json` — used
   * only for formatting per-failure detail blocks. This de-duplicates stderr
   * that otherwise appeared both pass-through live and in the failure block.
   */
  engine_stderr?: string;
}

export interface LastRun {
  schema_version: typeof LAST_RUN_SCHEMA_VERSION;
  started_at: string;
  finished_at: string;
  signal_aborted: boolean;
  partial_abort: boolean;
  scenarios: ScenarioRecord[];
}

export function lastRunPath(cwd: string): string {
  return path.join(cwd, LAST_RUN_FILE_REL);
}

export async function writeLastRun(cwd: string, payload: LastRun): Promise<string> {
  const target = lastRunPath(cwd);
  await mkdir(path.dirname(target), { recursive: true });
  // Strip the transient engine_stderr field so last-run.json stays a
  // stable, byte-small state file. The field is used by the in-memory
  // formatter for failure-block display only.
  const sanitized: LastRun = {
    ...payload,
    scenarios: payload.scenarios.map((s) => {
      const { engine_stderr, ...rest } = s;
      void engine_stderr;
      return rest;
    })
  };
  await writeFile(target, JSON.stringify(sanitized, null, 2) + "\n", "utf8");
  return target;
}

export async function readLastRun(cwd: string): Promise<LastRun | null> {
  try {
    const raw = await readFile(lastRunPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as LastRun & { scenarios: Array<ScenarioRecord & { status: string }> };
    if (parsed.schema_version !== LAST_RUN_SCHEMA_VERSION) {
      return null;
    }
    // Normalize stale "aborted" status to "error" so --only-failing keeps
    // working against old files.
    for (const s of parsed.scenarios) {
      if ((s.status as string) === "aborted") {
        s.status = "error";
      }
    }
    return parsed as LastRun;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Names of scenarios whose last run failed or errored. Used by `--only-failing`. */
export function failingNames(last: LastRun): Set<string> {
  const out = new Set<string>();
  for (const s of last.scenarios) {
    if (s.status === "fail" || s.status === "error") {
      out.add(s.name);
    }
  }
  return out;
}

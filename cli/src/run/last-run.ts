// `.riptide/last-run.json` schema + read/write helpers.
//
// Frozen schema (schema_version = 1) — consumed by `--only-failing`
// and T04's output formatter. Every `riptide run` invocation writes
// this file at the end (including aborted runs, with status="aborted"
// entries for incomplete scenarios). Documented here as the single
// source of truth; T04's output formatter references this shape.
//
// ----------------------------------------------------------------------
// SCHEMA v1 (FROZEN as of Sprint 8 T03 / 2026-04-19):
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
//       "status": "pass" | "fail" | "aborted",
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
// - "pass"    — scenario completed, zero invariant fires
// - "fail"    — scenario completed, one or more invariant fires
// - "aborted" — scenario either (a) skipped because a SIGINT landed
//               before it could start, or (b) engine crashed /
//               orchestrator failed to complete the scenario
//
// ----------------------------------------------------------------------

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const LAST_RUN_FILE_REL = path.join(".riptide", "last-run.json");
export const LAST_RUN_SCHEMA_VERSION = 1 as const;

export interface InvariantFire {
  name: string;
  tick: number;
}

export type ScenarioStatus = "pass" | "fail" | "aborted";

export interface ScenarioRecord {
  name: string;
  run_config_path: string;
  status: ScenarioStatus;
  wall_clock_s: number;
  invariant_fires: InvariantFire[];
  artifacts_dir?: string;
  error?: string;
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
  await writeFile(target, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return target;
}

export async function readLastRun(cwd: string): Promise<LastRun | null> {
  try {
    const raw = await readFile(lastRunPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as LastRun;
    if (parsed.schema_version !== LAST_RUN_SCHEMA_VERSION) {
      return null;
    }
    return parsed;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Names of scenarios whose last run failed or aborted. Used by `--only-failing`. */
export function failingNames(last: LastRun): Set<string> {
  const out = new Set<string>();
  for (const s of last.scenarios) {
    if (s.status === "fail" || s.status === "aborted") {
      out.add(s.name);
    }
  }
  return out;
}

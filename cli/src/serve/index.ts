import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SimulationResultSchema, type SimulationResult } from "../compiler/schema.js";
import {
  RUN_COLLECTION_SCHEMA_VERSION,
  metricPreviewFromSummary,
  type RunCollection,
  type RunCollectionScenario
} from "../run/collection.js";
import { interpretScenarioResult } from "../run/interpretation.js";
import { SEMANTIC_LABELS } from "./labels.js";

import type { InvariantFire, ScenarioRecord, ScenarioStatus } from "../run/last-run.js";

/**
 * Web Dashboard MVP.
 *
 * A tiny read-only HTTP server that renders a simulation's
 * `simulation-result.json` + `report.md` artifacts as a single-page
 * HTML dashboard. Invoked via the `--serve` flag on `riptide run`
 * and `riptide replay`.
 *
 * Design constraints (per ):
 * - No new npm deps. Uses `node:http` stdlib only. Chart.js is
 * loaded from a CDN by the HTML itself; the server does not
 * bundle it.
 * - Primitive-agnostic rendering: the HTML iterates over whatever
 * keys `summary` contains and derives a numeric-timeseries list
 * from `timeseries[]`, so lending/perps/AMM/replay runs all
 * render without special-casing.
 * - Read-only. The server only reads from the selected dashboard
 * source. It never writes.
 * - Clean Ctrl-C: the caller wires `close()` to SIGINT; idle
 * keep-alive sockets are tracked + destroyed so the process
 * exits without zombie connections.
 */

export interface DashboardHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface StartDashboardOptions {
  /**
   * Preferred starting port. Defaults to 4173. If taken, the server
   * tries port+1, port+2,... up to `maxAttempts-1` increments.
   */
  port?: number;
  /**
   * Max number of consecutive ports to try before giving up.
   * Defaults to 10.
   */
  maxAttempts?: number;
  /**
   * Host to bind on. Defaults to `127.0.0.1` (localhost-only; this
   * is a dev dashboard, not a production endpoint).
   */
  host?: string;
}

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_ATTEMPTS = 10;

export type DashboardSource =
  | { kind: "single"; artifactsDir: string; baseDir: string }
  | { kind: "collection"; collectionPath: string; baseDir: string };

type ScenarioSelection =
  | { ok: true; scenario: RunCollectionScenario }
  | { ok: false; status: number; payload: Record<string, unknown> };

interface FileSelection {
  filePath: string;
  missingMessage: string;
  displayBaseDir: string;
}

// The HTML template is shipped as a sibling `assets/` directory
// alongside the compiled CLI. At dev time it lives under
// `cli/assets/dashboard.html`; after `npm run build` + copy step it
// is also reachable from `cli/dist/assets/dashboard.html`. We probe
// both locations so the server works in both layouts without a
// bundler step.
function resolveAssetPath(filename: string): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Typical layouts:
  // dev (tsx/ts-node): <repo>/cli/src/serve/index.ts
  // → assets at <repo>/cli/assets/<filename>
  // built: <repo>/cli/dist/src/serve/index.js
  // → assets at <repo>/cli/dist/assets/<filename>
  // or <repo>/cli/assets/<filename>
  return [
    path.resolve(here, "..", "..", "..", "assets", filename),
    path.resolve(here, "..", "..", "assets", filename),
    path.resolve(here, "..", "assets", filename)
  ];
}

async function readFirstExistingAsset(filename: string): Promise<string> {
  const candidates = resolveAssetPath(filename);
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `riptide serve: could not find asset \"${filename}\" in any of:\n  ${candidates.join("\n  ")}\n  last error: ${(lastErr as Error)?.message ?? String(lastErr)}`
  );
}

export async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Strip the CWD prefix from absolute paths embedded in served artifacts so
 * the dashboard displays `fixtures/replays/…` instead of
 * `/home/…/riptide/fixtures/replays/…`. Engine writes absolute paths into
 * `simulation-result.json` and `report.md`; this is the display-layer fix.
 * The files on disk are untouched.
 */
export function relativizeDisplayPaths(raw: string, baseDir: string): string {
  const prefixes = new Set<string>([process.cwd(), baseDir].filter(Boolean));
  let out = raw;
  for (const prefix of prefixes) {
    out = out.split(path.resolve(prefix) + path.sep).join("");
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "content-type": `${contentType}; charset=utf-8`,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendNotFound(res: ServerResponse, pathname: string): void {
  sendJson(res, 404, {
    error: "not_found",
    message: `riptide dashboard: no route for ${pathname}`,
    routes: ["GET /", "GET /api/collection", "GET /api/result", "GET /api/report", "GET /api/labels"]
  });
}

export function makeDashboardSource(sourcePath: string): DashboardSource {
  const abs = path.resolve(sourcePath);
  if (path.extname(abs) === ".json") {
    return {
      kind: "collection",
      collectionPath: abs,
      baseDir: inferCollectionBaseDir(abs)
    };
  }
  return {
    kind: "single",
    artifactsDir: abs,
    baseDir: abs
  };
}

function inferCollectionBaseDir(collectionPath: string): string {
  const parts = collectionPath.split(path.sep);
  const markerIndex = parts.lastIndexOf(".riptide");
  if (markerIndex > 0) {
    return parts.slice(0, markerIndex).join(path.sep) || path.sep;
  }
  return path.dirname(collectionPath);
}

async function readCollection(
  source: Extract<DashboardSource, { kind: "collection" }>
): Promise<RunCollection> {
  const raw = await readFile(source.collectionPath, "utf8");
  return JSON.parse(raw) as RunCollection;
}

export async function collectionForSource(source: DashboardSource): Promise<RunCollection> {
  if (source.kind === "collection") {
    return readCollection(source);
  }
  return syntheticSingleRunCollection(source);
}

async function syntheticSingleRunCollection(
  source: Extract<DashboardSource, { kind: "single" }>
): Promise<RunCollection> {
  const resultPath = path.join(source.artifactsDir, "simulation-result.json");
  const reportPath = path.join(source.artifactsDir, "report.md");
  const raw = await readOptionalFile(resultPath);
  const reportExists = (await readOptionalFile(reportPath)) !== null;
  const timestamp = await fileTimestamp(resultPath);
  const artifactsDir = relativizeIfInside(process.cwd(), source.artifactsDir);
  const simulationResultPath = path.join(artifactsDir, "simulation-result.json");
  const reportRelPath = path.join(artifactsDir, "report.md");

  if (raw === null) {
    const record: ScenarioRecord = {
      name: path.basename(source.artifactsDir) || "single-run",
      run_config_path: "single-run source",
      status: "error",
      wall_clock_s: 0,
      invariant_fires: [],
      artifacts_dir: source.artifactsDir,
      error: `simulation-result.json not found in ${source.artifactsDir}`
    };
    const interpretation = interpretScenarioResult({ record, result: null });
    return {
      schema_version: RUN_COLLECTION_SCHEMA_VERSION,
      started_at: timestamp,
      finished_at: timestamp,
      allow_invariant_violations: false,
      total_scenarios: 1,
      totals_by_status: { pass: 0, fail: 0, error: 1, skipped: 0 },
      totals_by_verdict: {
        "failure-observed": 0,
        "no-failure-observed": 0,
        inconclusive: 0,
        "setup-error": 1,
        interrupted: 0
      },
      totals_by_coverage: { exercised: 0, partial: 0, unexercised: 0, unknown: 1 },
      scenarios: [
        {
          name: record.name,
          run_config_path: record.run_config_path,
          status: record.status,
          wall_clock_s: record.wall_clock_s,
          artifacts_dir: artifactsDir,
          invariant_fires: [],
          invariant_fire_count: 0,
          interpretation,
          coverage_checks: interpretation.coverage_checks,
          metric_preview: {},
          simulation_result_path: simulationResultPath,
          report_path: reportRelPath,
          error: record.error
        }
      ]
    };
  }

  let result: SimulationResult;
  try {
    const parsed = SimulationResultSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    result = parsed.data;
  } catch (err) {
    const record: ScenarioRecord = {
      name: path.basename(source.artifactsDir) || "single-run",
      run_config_path: "single-run source",
      status: "error",
      wall_clock_s: 0,
      invariant_fires: [],
      artifacts_dir: source.artifactsDir,
      error: `failed to parse simulation-result.json: ${(err as Error).message ?? String(err)}`
    };
    const interpretation = interpretScenarioResult({ record, result: null });
    return {
      schema_version: RUN_COLLECTION_SCHEMA_VERSION,
      started_at: timestamp,
      finished_at: timestamp,
      allow_invariant_violations: false,
      total_scenarios: 1,
      totals_by_status: { pass: 0, fail: 0, error: 1, skipped: 0 },
      totals_by_verdict: {
        "failure-observed": 0,
        "no-failure-observed": 0,
        inconclusive: 0,
        "setup-error": 1,
        interrupted: 0
      },
      totals_by_coverage: { exercised: 0, partial: 0, unexercised: 0, unknown: 1 },
      scenarios: [
        {
          name: record.name,
          run_config_path: record.run_config_path,
          status: record.status,
          wall_clock_s: record.wall_clock_s,
          artifacts_dir: artifactsDir,
          invariant_fires: [],
          invariant_fire_count: 0,
          interpretation,
          coverage_checks: interpretation.coverage_checks,
          metric_preview: {},
          simulation_result_path: simulationResultPath,
          report_path: reportRelPath,
          error: record.error
        }
      ]
    };
  }

  const fires = invariantFiresFromResult(result);
  const statusValue: ScenarioStatus = fires.length > 0 ? "fail" : "pass";
  const scenarioName =
    typeof result.run_config.scenario === "string" && result.run_config.scenario.length > 0
      ? result.run_config.scenario
      : path.basename(source.artifactsDir) || "single-run";
  const record: ScenarioRecord = {
    name: scenarioName,
    run_config_path: "single-run source",
    status: statusValue,
    wall_clock_s: 0,
    invariant_fires: fires,
    artifacts_dir: source.artifactsDir
  };
  const interpretation = interpretScenarioResult({
    record,
    result,
    artifactReadability: {
      simulationResultJson: true,
      reportMarkdown: reportExists
    }
  });
  const scenario: RunCollectionScenario = {
    name: record.name,
    run_config_path: record.run_config_path,
    status: record.status,
    wall_clock_s: record.wall_clock_s,
    artifacts_dir: artifactsDir,
    invariant_fires: fires,
    invariant_fire_count: fires.length,
    interpretation,
    coverage_checks: interpretation.coverage_checks,
    metric_preview: metricPreviewFromSummary(result.summary),
    simulation_result_path: simulationResultPath,
    report_path: reportRelPath
  };

  return {
    schema_version: RUN_COLLECTION_SCHEMA_VERSION,
    started_at: timestamp,
    finished_at: timestamp,
    allow_invariant_violations: false,
    total_scenarios: 1,
    totals_by_status: {
      pass: statusValue === "pass" ? 1 : 0,
      fail: statusValue === "fail" ? 1 : 0,
      error: 0,
      skipped: 0
    },
    totals_by_verdict: {
      "failure-observed": interpretation.verdict === "failure-observed" ? 1 : 0,
      "no-failure-observed": interpretation.verdict === "no-failure-observed" ? 1 : 0,
      inconclusive: interpretation.verdict === "inconclusive" ? 1 : 0,
      "setup-error": interpretation.verdict === "setup-error" ? 1 : 0,
      interrupted: interpretation.verdict === "interrupted" ? 1 : 0
    },
    totals_by_coverage: {
      exercised: interpretation.coverage === "exercised" ? 1 : 0,
      partial: interpretation.coverage === "partial" ? 1 : 0,
      unexercised: interpretation.coverage === "unexercised" ? 1 : 0,
      unknown: interpretation.coverage === "unknown" ? 1 : 0
    },
    scenarios: [scenario]
  };
}

async function fileTimestamp(filePath: string): Promise<string> {
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function invariantFiresFromResult(result: SimulationResult): InvariantFire[] {
  const fires: InvariantFire[] = [];
  for (const event of result.events) {
    if (
      event &&
      typeof event.action === "string" &&
      event.action.startsWith("invariant_violation:")
    ) {
      const name = event.action.slice("invariant_violation:".length) || "invariant";
      fires.push({ name, tick: typeof event.tick === "number" ? event.tick : result.total_ticks });
    }
  }
  if (fires.length > 0) return fires;

  const rows = Array.isArray(result.summary.invariants_fired)
    ? result.summary.invariants_fired
    : [];
  for (const row of rows) {
    const firings = typeof row.firings === "number" ? row.firings : 0;
    if (firings <= 0) continue;
    fires.push({
      name: typeof row.name === "string" && row.name.length > 0 ? row.name : "invariant",
      tick: result.total_ticks
    });
  }
  return fires;
}

function selectScenario(collection: RunCollection, searchParams: URLSearchParams): ScenarioSelection {
  const requested = searchParams.get("scenario");
  if (requested && requested.length > 0) {
    const scenario = collection.scenarios.find((entry) => entry.name === requested);
    if (!scenario) {
      return {
        ok: false,
        status: 404,
        payload: {
          error: "scenario_not_found",
          message: `scenario ${JSON.stringify(requested)} not found in run collection`,
          scenarios: collection.scenarios.map((entry) => entry.name)
        }
      };
    }
    return { ok: true, scenario };
  }

  const first = collection.scenarios[0];
  if (!first) {
    return {
      ok: false,
      status: 404,
      payload: {
        error: "collection_empty",
        message: "run collection has no scenarios"
      }
    };
  }
  return { ok: true, scenario: first };
}

export async function selectFileFromSource(
  source: DashboardSource,
  searchParams: URLSearchParams,
  kind: "result" | "report"
): Promise<FileSelection | { error: true; status: number; payload: Record<string, unknown> }> {
  if (source.kind === "single") {
    return {
      filePath: path.join(
        source.artifactsDir,
        kind === "result" ? "simulation-result.json" : "report.md"
      ),
      missingMessage: `${kind === "result" ? "simulation-result.json" : "report.md"} not found in ${source.artifactsDir}`,
      displayBaseDir: source.baseDir
    };
  }

  const collection = await readCollection(source);
  const selection = selectScenario(collection, searchParams);
  if (!selection.ok) {
    return { error: true, status: selection.status, payload: selection.payload };
  }

  const scenario = selection.scenario;
  const relPath =
    kind === "result"
      ? scenario.simulation_result_path ??
        (scenario.artifacts_dir ? path.join(scenario.artifacts_dir, "simulation-result.json") : undefined)
      : scenario.report_path ??
        (scenario.artifacts_dir ? path.join(scenario.artifacts_dir, "report.md") : undefined);

  if (!relPath) {
    return {
      error: true,
      status: 404,
      payload: {
        error: kind === "result" ? "result_missing" : "report_missing",
        message: `${kind === "result" ? "simulation-result.json" : "report.md"} path is missing for scenario ${scenario.name}`,
        scenario: scenario.name
      }
    };
  }

  return {
    filePath: resolveFromBase(source.baseDir, relPath),
    missingMessage: `${kind === "result" ? "simulation-result.json" : "report.md"} not found for scenario ${scenario.name}`,
    displayBaseDir: source.baseDir
  };
}

function resolveFromBase(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function relativizeIfInside(baseDir: string, value: string): string {
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(baseDir, value);
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return value;
}

function makeRequestHandler(source: DashboardSource) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    try {
      if (pathname === "/" || pathname === "/index.html") {
        const html = await readFirstExistingAsset("dashboard.html");
        sendText(res, 200, html, "text/html");
        return;
      }
      if (pathname === "/api/collection") {
        sendJson(res, 200, await collectionForSource(source));
        return;
      }
      if (pathname === "/api/result") {
        const selection = await selectFileFromSource(source, url.searchParams, "result");
        if ("error" in selection) {
          sendJson(res, selection.status, selection.payload);
          return;
        }
        const raw = await readOptionalFile(selection.filePath);
        if (raw === null) {
          sendJson(res, 404, {
            error: "result_missing",
            message: selection.missingMessage
          });
          return;
        }
        // Strip local absolute prefixes for display only. Files on disk
        // are unchanged.
        sendText(res, 200, relativizeDisplayPaths(raw, selection.displayBaseDir), "application/json");
        return;
      }
      if (pathname === "/api/report") {
        const selection = await selectFileFromSource(source, url.searchParams, "report");
        if ("error" in selection) {
          sendJson(res, selection.status, selection.payload);
          return;
        }
        const raw = await readOptionalFile(selection.filePath);
        if (raw === null) {
          sendJson(res, 404, {
            error: "report_missing",
            message: selection.missingMessage
          });
          return;
        }
        sendText(res, 200, relativizeDisplayPaths(raw, selection.displayBaseDir), "text/markdown");
        return;
      }
      if (pathname === "/api/labels") {
        sendJson(res, 200, SEMANTIC_LABELS);
        return;
      }
      if (pathname === "/api/health") {
        sendJson(res, 200, { ok: true, source });
        return;
      }
      sendNotFound(res, pathname);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      sendJson(res, 500, { error: "internal", message: msg });
    }
  };
}

function listenOnPort(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    function onError(err: NodeJS.ErrnoException) {
      server.off("listening", onListening);
      reject(err);
    }
    function onListening() {
      server.off("error", onError);
      resolve();
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Starts the dashboard server. Finds the first free port in
 * `[port, port + maxAttempts)` (default 4173..4183), binds on `host`
 * (default 127.0.0.1), and returns a handle with a `close()` that
 * shuts the server down cleanly (including any idle keep-alive
 * sockets).
 *
 * The server is purely read-only; it reads the source files on every
 * request so any rerun that updates those files on disk shows up on
 * refresh without restarting the server.
 */
export async function startDashboardServer(
  sourcePath: string,
  options: StartDashboardOptions = {}
): Promise<DashboardHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const startPort = options.port ?? DEFAULT_PORT;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  const source = makeDashboardSource(sourcePath);
  const handle = makeRequestHandler(source);
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Last-resort catch: makeRequestHandler already wraps its own
      // body in try/catch, but a handler rejection before writeHead
      // would otherwise leak.
      const msg = (err as Error)?.message ?? String(err);
      try {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "internal", message: msg }));
      } catch {
        // response already committed — give up silently
      }
    });
  });
  // Short keep-alive so Ctrl-C isn't held up waiting for browsers
  // to close idle connections. 2s matches `node:http` defaults for
  // a dev-ergonomic shutdown.
  server.keepAliveTimeout = 2000;
  // Track open sockets so `close()` can hard-destroy them on SIGINT
  // instead of hanging on keep-alives — `server.close()` alone waits
  // for every live socket to drain, which is the classic zombie-on-
  // Ctrl-C pitfall.
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let lastErr: NodeJS.ErrnoException | null = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    const port = startPort + i;
    try {
      // eslint-disable-next-line no-await-in-loop
      await listenOnPort(server, host, port);
      const actualPort = (() => {
        const address = server.address();
        return typeof address === "object" && address ? address.port : port;
      })();
      const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}`;
      return {
        url,
        port: actualPort,
        close: () =>
          new Promise<void>((resolve) => {
            for (const sock of sockets) {
              try {
                sock.destroy();
              } catch {
                // ignore — socket may already be closed
              }
            }
            sockets.clear();
            server.close(() => resolve());
          })
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e && (e.code === "EADDRINUSE" || e.code === "EACCES")) {
        lastErr = e;
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `riptide serve: could not bind any port in [${startPort}, ${startPort + maxAttempts}) on ${host}` +
      (lastErr ? ` (last error: ${lastErr.code ?? lastErr.message})` : "")
  );
}

/**
 * Convenience helper: block on SIGINT / SIGTERM, calling `close()`
 * before resolving. Used by the CLI commands so `--serve` blocks
 * the command until the user hits Ctrl-C, then exits cleanly.
 */
export function blockUntilSignal(handle: DashboardHandle): Promise<void> {
  return new Promise((resolve) => {
    let closing = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (closing) return;
      closing = true;
      process.stderr.write(`\nriptide serve: received ${signal}, shutting down...\n`);
      try {
        await handle.close();
      } catch {
        // swallow — we're exiting anyway
      }
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}

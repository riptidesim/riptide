// Studio HTTP server.
//
// Localhost-only, file-backed dev server for the Riptide Studio app.
// Serves the React + Vite production bundle when present, falls back
// to the legacy `studio.html` migration shell otherwise.
//
// Trust boundary:
// - Bind defaults to `127.0.0.1`.
// - No generic shell endpoint.
// - The job launcher accepts only structured allowlisted payloads.
// - The config-intent endpoint never mutates files.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverStudioWorkspaces,
  type StudioWorkspace
} from "./workspaces.js";
import { indexWorkspaceArtifacts } from "./artifacts.js";
import { buildStudioGraph } from "./graph.js";
import { resolveStudioReport } from "./report.js";
import {
  dashboardLabels,
  readCollectionPayload,
  readReportBody,
  readResultBody,
  resolveDashboardSource
} from "./dashboard-mount.js";
import { StudioJobQueue, type JobKind, type JobPlanPreview, type JobValidationError } from "./jobs.js";
import { generateConfigIntent } from "./config-intent.js";
import { probeAgents } from "./agents.js";
import { detectProgramForStudio } from "./program-detect.js";
import {
  RiptideDirExistsError,
  ProgramDetectionError,
  scaffold,
  type ScaffoldOptions
} from "../init/index.js";
import { PROTOCOL_CHOICES, type Protocol } from "../init/personas-catalog.js";

export interface StudioServerHandle {
  url: string;
  port: number;
  host: string;
  jobs: StudioJobQueue;
  close: () => Promise<void>;
}

export interface StartStudioServerOptions {
  /** Workspace root (current repo). Defaults to `process.cwd()`. */
  workspace?: string;
  /** Optional case-studies parent directory. */
  caseStudiesRoot?: string;
  /** Preferred port. Defaults to 4173. */
  port?: number;
  /** How many sequential ports to try if the preferred one is taken. Defaults to 10. */
  maxAttempts?: number;
  /** Bind address. Defaults to 127.0.0.1. */
  host?: string;
  /** Optional pre-built job queue (used by tests). */
  jobQueue?: StudioJobQueue;
}

interface StudioContext {
  workspace: string;
  caseStudiesRoot?: string;
  workspaces: StudioWorkspace[];
  workspacesById: Map<string, StudioWorkspace>;
  startedAt: string;
  jobs: StudioJobQueue;
}

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_ATTEMPTS = 10;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".txt": "text/plain"
};

function studioBundleRoots(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Possible layouts:
  //   dev:    cli/src/studio/server.ts -> cli/assets/studio/
  //   built:  cli/dist/src/studio/server.js -> cli/dist/assets/studio/
  //                                       and cli/assets/studio/
  return [
    path.resolve(here, "..", "..", "..", "assets", "studio"),
    path.resolve(here, "..", "..", "assets", "studio"),
    path.resolve(here, "..", "assets", "studio")
  ];
}

function legacyAssetCandidates(filename: string): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, "..", "..", "..", "assets", filename),
    path.resolve(here, "..", "..", "assets", filename),
    path.resolve(here, "..", "assets", filename)
  ];
}

async function findStudioBundleRoot(): Promise<string | null> {
  for (const candidate of studioBundleRoots()) {
    try {
      const s = await stat(path.join(candidate, "index.html"));
      if (s.isFile()) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

async function readFirstExistingLegacyAsset(filename: string): Promise<string> {
  const candidates = legacyAssetCandidates(filename);
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `riptide studio: could not find asset \"${filename}\" in any of:\n  ${candidates.join("\n  ")}\n  last error: ${(lastErr as Error)?.message ?? String(lastErr)}`
  );
}

async function readBundleFile(bundleRoot: string, relPath: string): Promise<{ body: Buffer; type: string } | null> {
  const candidate = path.resolve(bundleRoot, relPath.replace(/^\/+/, ""));
  const rel = path.relative(bundleRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    const body = await readFile(candidate);
    const ext = path.extname(candidate).toLowerCase();
    const type = STATIC_MIME[ext] ?? "application/octet-stream";
    return { body, type };
  } catch {
    return null;
  }
}

async function serveStudioRoot(res: ServerResponse): Promise<void> {
  const bundleRoot = await findStudioBundleRoot();
  if (bundleRoot) {
    const file = await readBundleFile(bundleRoot, "index.html");
    if (file) {
      sendBuffer(res, 200, file.body, file.type);
      return;
    }
  }
  const html = await readFirstExistingLegacyAsset("studio.html");
  sendText(res, 200, html, "text/html");
}

async function serveStudioAssetIfPresent(
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  const bundleRoot = await findStudioBundleRoot();
  if (!bundleRoot) return false;
  const file = await readBundleFile(bundleRoot, pathname);
  if (!file) return false;
  sendBuffer(res, 200, file.body, file.type);
  return true;
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

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string
): void {
  res.writeHead(status, {
    "content-type": `${contentType}; charset=utf-8`,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  const headers: Record<string, string | number> = {
    "content-length": body.byteLength,
    "cache-control": "no-store"
  };
  if (contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/javascript") {
    headers["content-type"] = `${contentType}; charset=utf-8`;
  } else {
    headers["content-type"] = contentType;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendNotFound(res: ServerResponse, pathname: string): void {
  sendJson(res, 404, {
    error: "not_found",
    message: `riptide studio: no route for ${pathname}`,
    routes: [
      "GET /",
      "GET /dashboard",
      "GET /api/studio/health",
      "GET /api/studio/workspaces",
      "GET /api/studio/agents",
      "GET /api/studio/protocols",
      "GET /api/studio/detect-program",
      "GET /api/studio/artifacts",
      "GET /api/studio/graph",
      "GET /api/studio/report",
      "GET /api/studio/jobs",
      "POST /api/studio/init",
      "POST /api/studio/jobs",
      "POST /api/studio/jobs/plan",
      "POST /api/studio/jobs/:id/cancel",
      "POST /api/studio/config/intent",
      "GET /api/collection",
      "GET /api/result",
      "GET /api/report",
      "GET /api/labels"
    ]
  });
}

function selectWorkspace(
  ctx: StudioContext,
  searchParams: URLSearchParams
): StudioWorkspace | { error: { status: number; payload: Record<string, unknown> } } {
  const requested = searchParams.get("workspace");
  if (requested) {
    const found = ctx.workspacesById.get(requested);
    if (!found) {
      return {
        error: {
          status: 404,
          payload: {
            error: "workspace_not_found",
            message: `workspace ${JSON.stringify(requested)} is not registered`,
            workspaces: ctx.workspaces.map((w) => w.id)
          }
        }
      };
    }
    return found;
  }
  const primary = ctx.workspaces[0];
  if (!primary) {
    return {
      error: {
        status: 404,
        payload: {
          error: "no_workspace",
          message: "no workspace is currently registered"
        }
      }
    };
  }
  return primary;
}

async function readBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error(`request body exceeded ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

async function refreshWorkspaces(ctx: StudioContext): Promise<void> {
  const next = await discoverStudioWorkspaces({
    cwd: ctx.workspace,
    caseStudiesRoot: ctx.caseStudiesRoot
  });
  ctx.workspaces = next;
  ctx.workspacesById = new Map(next.map((w) => [w.id, w]));
  ctx.jobs.setWorkspaces(next);
}

const PROGRAM_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PROTOCOL_VALUES: ReadonlySet<Protocol> = new Set(
  PROTOCOL_CHOICES.map((c) => c.value)
);

function asInitInput(
  body: unknown
):
  | { programName: string; protocol: Protocol }
  | { error: { status: number; payload: Record<string, unknown> } } {
  if (!body || typeof body !== "object") {
    return { error: { status: 400, payload: { error: "invalid_body", message: "expected JSON object" } } };
  }
  const o = body as Record<string, unknown>;
  const rawName =
    typeof o.program_name === "string" ? o.program_name :
    typeof o.programName === "string" ? o.programName : "";
  const programName = rawName.trim();
  if (!programName) {
    return { error: { status: 400, payload: { error: "missing_program_name", message: "program_name is required" } } };
  }
  if (!PROGRAM_NAME_RE.test(programName)) {
    return {
      error: {
        status: 400,
        payload: {
          error: "invalid_program_name",
          message: "program_name must be lowercase letters, numbers, or dashes; must start with a letter"
        }
      }
    };
  }
  const rawProtocol = typeof o.protocol === "string" ? o.protocol : "";
  if (!PROTOCOL_VALUES.has(rawProtocol as Protocol)) {
    return {
      error: {
        status: 400,
        payload: {
          error: "invalid_protocol",
          message: `protocol must be one of: ${Array.from(PROTOCOL_VALUES).join(", ")}`
        }
      }
    };
  }
  return { programName, protocol: rawProtocol as Protocol };
}

function isJobValidationError(value: unknown): value is JobValidationError {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "payload" in value &&
    typeof (value as { status: unknown }).status === "number"
  );
}

function asJobLaunchInput(body: unknown): { workspaceId: string; kind: JobKind; params: Record<string, string> } | { error: { status: number; payload: Record<string, unknown> } } {
  if (!body || typeof body !== "object") {
    return { error: { status: 400, payload: { error: "invalid_body", message: "expected JSON object" } } };
  }
  const o = body as Record<string, unknown>;
  const workspaceId = typeof o.workspace === "string" ? o.workspace : "";
  const kind = typeof o.kind === "string" ? (o.kind as JobKind) : ("" as JobKind);
  const rawParams = (o.params ?? {}) as Record<string, unknown>;
  if (!workspaceId) {
    return { error: { status: 400, payload: { error: "missing_workspace", message: "workspace is required" } } };
  }
  if (!kind) {
    return { error: { status: 400, payload: { error: "missing_kind", message: "kind is required" } } };
  }
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawParams)) {
    if (typeof v !== "string") {
      return { error: { status: 400, payload: { error: "invalid_params", message: `params.${k} must be a string` } } };
    }
    params[k] = v;
  }
  return { workspaceId, kind, params };
}

function makeRequestHandler(ctx: StudioContext) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    try {
      // ---- Routes that allow POST ----
      const jobCancelMatch = /^\/api\/studio\/jobs\/([^/]+)\/cancel$/.exec(pathname);
      if (pathname === "/api/studio/jobs" && method === "POST") {
        const body = await readBody(req);
        const parsed = asJobLaunchInput(body);
        if ("error" in parsed) {
          sendJson(res, parsed.error.status, parsed.error.payload);
          return;
        }
        let result: Awaited<ReturnType<typeof ctx.jobs.launch>>;
        try {
          result = await ctx.jobs.launch(parsed);
        } catch (err) {
          sendJson(res, 400, { error: "invalid_launch", message: (err as Error).message });
          return;
        }
        if (isJobValidationError(result)) {
          sendJson(res, result.status, result.payload);
          return;
        }
        sendJson(res, 201, { schema_version: "studio-job.v1", job: result });
        return;
      }
      if (pathname === "/api/studio/jobs/plan" && method === "POST") {
        const body = await readBody(req);
        const parsed = asJobLaunchInput(body);
        if ("error" in parsed) {
          sendJson(res, parsed.error.status, parsed.error.payload);
          return;
        }
        let plan: JobPlanPreview | JobValidationError;
        try {
          plan = ctx.jobs.plan(parsed);
        } catch (err) {
          sendJson(res, 400, { error: "invalid_plan", message: (err as Error).message });
          return;
        }
        if (isJobValidationError(plan)) {
          sendJson(res, plan.status, plan.payload);
          return;
        }
        sendJson(res, 200, { schema_version: "studio-job-plan.v1", plan });
        return;
      }
      if (jobCancelMatch && method === "POST") {
        const id = jobCancelMatch[1] as string;
        const job = await ctx.jobs.cancel(id);
        if (!job) {
          sendJson(res, 404, { error: "job_not_found", message: `no job with id ${id}` });
          return;
        }
        sendJson(res, 200, { schema_version: "studio-job.v1", job });
        return;
      }
      if (pathname === "/api/studio/config/intent" && method === "POST") {
        const body = await readBody(req);
        const result = generateConfigIntent(body);
        if ("status" in result && typeof result.status === "number") {
          sendJson(res, result.status, result.payload);
          return;
        }
        sendJson(res, 200, result);
        return;
      }
      if (pathname === "/api/studio/init" && method === "POST") {
        const body = await readBody(req);
        const parsed = asInitInput(body);
        if ("error" in parsed) {
          sendJson(res, parsed.error.status, parsed.error.payload);
          return;
        }
        const scaffoldOptions: ScaffoldOptions = {
          cwd: ctx.workspace,
          force: false,
          mode: "minimal",
          blank: true,
          programName: parsed.programName,
          protocol: parsed.protocol
        };
        try {
          const result = await scaffold(scaffoldOptions);
          await refreshWorkspaces(ctx);
          sendJson(res, 201, {
            schema_version: "studio-init.v1",
            program_name: result.programName,
            protocol: parsed.protocol,
            created: result.created,
            warnings: result.warnings,
            workspaces: ctx.workspaces
          });
          return;
        } catch (err) {
          if (err instanceof RiptideDirExistsError) {
            sendJson(res, 409, { error: "riptide_dir_exists", message: err.message });
            return;
          }
          if (err instanceof ProgramDetectionError) {
            sendJson(res, 400, { error: "program_detection", message: err.message });
            return;
          }
          sendJson(res, 500, { error: "scaffold_failed", message: (err as Error).message });
          return;
        }
      }

      // ---- Everything else is GET/HEAD only ----
      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" });
        res.end();
        return;
      }

      if (pathname === "/" || pathname === "/index.html") {
        await serveStudioRoot(res);
        return;
      }
      if (pathname === "/dashboard" || pathname === "/dashboard/") {
        const html = await readFirstExistingLegacyAsset("dashboard.html");
        sendText(res, 200, html, "text/html");
        return;
      }
      if (pathname === "/api/studio/health") {
        sendJson(res, 200, {
          ok: true,
          schema_version: "studio-health.v1",
          started_at: ctx.startedAt,
          workspace: ctx.workspace,
          case_studies_root: ctx.caseStudiesRoot ?? null,
          workspace_count: ctx.workspaces.length
        });
        return;
      }
      if (pathname === "/api/studio/workspaces") {
        sendJson(res, 200, {
          schema_version: "studio-workspaces.v1",
          workspaces: ctx.workspaces
        });
        return;
      }
      if (pathname === "/api/studio/agents") {
        const agents = await probeAgents();
        sendJson(res, 200, { schema_version: "studio-agents.v1", agents });
        return;
      }
      if (pathname === "/api/studio/protocols") {
        sendJson(res, 200, { schema_version: "studio-protocols.v1", protocols: PROTOCOL_CHOICES });
        return;
      }
      if (pathname === "/api/studio/detect-program") {
        const detection = detectProgramForStudio(ctx.workspace);
        sendJson(res, 200, { schema_version: "studio-detect-program.v1", ...detection });
        return;
      }
      if (pathname === "/api/studio/artifacts") {
        const selection = selectWorkspace(ctx, url.searchParams);
        if ("error" in selection) {
          sendJson(res, selection.error.status, selection.error.payload);
          return;
        }
        const index = await indexWorkspaceArtifacts({
          workspaceId: selection.id,
          workspacePath: selection.path
        });
        sendJson(res, 200, {
          schema_version: "studio-artifacts.v1",
          ...index
        });
        return;
      }
      if (pathname === "/api/studio/graph") {
        const selection = selectWorkspace(ctx, url.searchParams);
        if ("error" in selection) {
          sendJson(res, selection.error.status, selection.error.payload);
          return;
        }
        const graph = await buildStudioGraph({
          workspaceId: selection.id,
          workspacePath: selection.path,
          adapter: url.searchParams.get("adapter") ?? undefined,
          scenario: url.searchParams.get("scenario") ?? undefined,
          campaign: url.searchParams.get("campaign") ?? undefined,
          run: url.searchParams.get("run") ?? undefined,
          pack: url.searchParams.get("pack") ?? undefined
        });
        sendJson(res, 200, graph);
        return;
      }
      if (pathname === "/api/studio/report") {
        const selection = selectWorkspace(ctx, url.searchParams);
        if ("error" in selection) {
          sendJson(res, selection.error.status, selection.error.payload);
          return;
        }
        const artifactId = url.searchParams.get("artifact");
        if (!artifactId) {
          sendJson(res, 400, {
            error: "missing_artifact",
            message: "the `artifact` query parameter is required"
          });
          return;
        }
        const payload = await resolveStudioReport({
          workspaceId: selection.id,
          workspacePath: selection.path,
          artifactId
        });
        if (!payload) {
          sendJson(res, 404, {
            error: "report_not_found",
            message: `no readable report found for artifact ${JSON.stringify(artifactId)}`
          });
          return;
        }
        sendJson(res, 200, payload);
        return;
      }
      if (pathname === "/api/collection") {
        const selection = selectWorkspace(ctx, url.searchParams);
        if ("error" in selection) {
          sendJson(res, selection.error.status, selection.error.payload);
          return;
        }
        const dashboard = await resolveDashboardSource(
          selection.path,
          url.searchParams.get("source")
        );
        if ("status" in dashboard) {
          sendJson(res, dashboard.status, dashboard.payload);
          return;
        }
        const payload = await readCollectionPayload(dashboard.source);
        sendJson(res, 200, payload);
        return;
      }
      if (pathname === "/api/result") {
        const selection = selectWorkspace(ctx, url.searchParams);
        if ("error" in selection) {
          sendJson(res, selection.error.status, selection.error.payload);
          return;
        }
        const dashboard = await resolveDashboardSource(
          selection.path,
          url.searchParams.get("source")
        );
        if ("status" in dashboard) {
          sendJson(res, dashboard.status, dashboard.payload);
          return;
        }
        const out = await readResultBody(dashboard.source, url.searchParams);
        if (!out.ok) {
          sendJson(res, out.status, out.payload);
          return;
        }
        sendText(res, 200, out.body, "application/json");
        return;
      }
      if (pathname === "/api/report") {
        const selection = selectWorkspace(ctx, url.searchParams);
        if ("error" in selection) {
          sendJson(res, selection.error.status, selection.error.payload);
          return;
        }
        const dashboard = await resolveDashboardSource(
          selection.path,
          url.searchParams.get("source")
        );
        if ("status" in dashboard) {
          sendJson(res, dashboard.status, dashboard.payload);
          return;
        }
        const out = await readReportBody(dashboard.source, url.searchParams);
        if (!out.ok) {
          sendJson(res, out.status, out.payload);
          return;
        }
        sendText(res, 200, out.body, "text/markdown");
        return;
      }
      if (pathname === "/api/labels") {
        sendJson(res, 200, dashboardLabels());
        return;
      }
      if (pathname === "/api/studio/jobs") {
        sendJson(res, 200, {
          schema_version: "studio-jobs.v1",
          jobs: ctx.jobs.list()
        });
        return;
      }
      const jobIdMatch = /^\/api\/studio\/jobs\/([^/]+)$/.exec(pathname);
      if (jobIdMatch) {
        const id = jobIdMatch[1] as string;
        const job = ctx.jobs.get(id);
        if (!job) {
          sendJson(res, 404, { error: "job_not_found", message: `no job with id ${id}` });
          return;
        }
        sendJson(res, 200, { schema_version: "studio-job.v1", job });
        return;
      }
      // Static asset fallback for the React bundle (assets/, vite/, etc.).
      if (pathname.startsWith("/assets/") || pathname.startsWith("/vite.svg") || pathname.endsWith(".js") || pathname.endsWith(".css") || pathname.endsWith(".map")) {
        const served = await serveStudioAssetIfPresent(res, pathname);
        if (served) return;
      }
      sendNotFound(res, pathname);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      sendJson(res, 500, { error: "internal", message });
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

export async function startStudioServer(
  options: StartStudioServerOptions = {}
): Promise<StudioServerHandle> {
  const host = normalizeLoopbackHost(options.host ?? DEFAULT_HOST);
  const startPort = options.port ?? DEFAULT_PORT;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const caseStudiesRoot = options.caseStudiesRoot
    ? path.resolve(options.caseStudiesRoot)
    : undefined;

  const workspaces = await discoverStudioWorkspaces({
    cwd: workspace,
    caseStudiesRoot
  });
  const jobQueue = options.jobQueue ?? new StudioJobQueue();
  jobQueue.setWorkspaces(workspaces);
  for (const ws of workspaces) {
    try {
      await jobQueue.hydrate(ws);
    } catch {
      // ignore hydration errors per workspace; surface in job records elsewhere.
    }
  }

  const ctx: StudioContext = {
    workspace,
    caseStudiesRoot,
    workspaces,
    workspacesById: new Map(workspaces.map((w) => [w.id, w])),
    startedAt: new Date().toISOString(),
    jobs: jobQueue
  };

  const handle = makeRequestHandler(ctx);
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const message = (err as Error)?.message ?? String(err);
      try {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "internal", message }));
      } catch {
        // response already committed
      }
    });
  });
  server.keepAliveTimeout = 2000;

  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let lastErr: NodeJS.ErrnoException | null = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    const port = startPort === 0 ? 0 : startPort + i;
    try {
      // eslint-disable-next-line no-await-in-loop
      await listenOnPort(server, host, port);
      const actualPort = (() => {
        const address = server.address();
        return typeof address === "object" && address ? address.port : port;
      })();
      const url = `http://${urlHost(host)}:${actualPort}`;
      return {
        url,
        port: actualPort,
        host,
        jobs: jobQueue,
        close: () =>
          new Promise<void>((resolve) => {
            for (const sock of sockets) {
              try {
                sock.destroy();
              } catch {
                // ignore
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
        if (startPort === 0) break;
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `riptide studio: could not bind any port in [${startPort}, ${startPort + maxAttempts}) on ${host}` +
      (lastErr ? ` (last error: ${lastErr.code ?? lastErr.message})` : "")
  );
}

function normalizeLoopbackHost(raw: string): string {
  const host = raw.trim();
  if (host === "[::1]") return "::1";
  if (LOOPBACK_HOSTS.has(host)) return host;
  throw new Error(
    `riptide studio: invalid --host ${JSON.stringify(raw)}; Studio is localhost-only (use 127.0.0.1, localhost, or ::1).`
  );
}

function urlHost(host: string): string {
  return host === "::1" ? "[::1]" : host;
}

export function blockUntilSignal(handle: StudioServerHandle): Promise<void> {
  return new Promise((resolve) => {
    let closing = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (closing) return;
      closing = true;
      process.stderr.write(`\nriptide studio: received ${signal}, shutting down...\n`);
      try {
        await handle.close();
      } catch {
        // swallow — exiting anyway
      }
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}

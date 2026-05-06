// Studio HTTP server.
//
// Localhost-only, read-only, file-backed dev server for the Riptide
// Studio app. Mirrors the existing dashboard server's stdlib-only
// shape (see `cli/src/serve/index.ts`) but is tightly scoped to the
// `/api/studio/*` surface and the `studio.html` shell.
//
// Trust boundary:
// - Bind defaults to `127.0.0.1`.
// - No generic shell endpoint.
// - The server only reads from the configured workspace and the
//   optional case-studies root. There is no write path in Phase 1.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
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

export interface StudioServerHandle {
  url: string;
  port: number;
  host: string;
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
}

interface StudioContext {
  workspace: string;
  caseStudiesRoot?: string;
  workspaces: StudioWorkspace[];
  workspacesById: Map<string, StudioWorkspace>;
  startedAt: string;
}

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_ATTEMPTS = 10;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function resolveAssetPath(filename: string): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dev: cli/src/studio/server.ts → cli/assets/<file>
  // built: cli/dist/src/studio/server.js → cli/dist/assets/<file> or cli/assets/<file>
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
    `riptide studio: could not find asset \"${filename}\" in any of:\n  ${candidates.join("\n  ")}\n  last error: ${(lastErr as Error)?.message ?? String(lastErr)}`
  );
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

function sendNotFound(res: ServerResponse, pathname: string): void {
  sendJson(res, 404, {
    error: "not_found",
    message: `riptide studio: no route for ${pathname}`,
    routes: [
      "GET /",
      "GET /dashboard",
      "GET /api/studio/health",
      "GET /api/studio/workspaces",
      "GET /api/studio/artifacts",
      "GET /api/studio/graph",
      "GET /api/studio/report",
      "GET /api/studio/jobs",
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

function makeRequestHandler(ctx: StudioContext) {
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
        const html = await readFirstExistingAsset("studio.html");
        sendText(res, 200, html, "text/html");
        return;
      }
      if (pathname === "/dashboard" || pathname === "/dashboard/") {
        const html = await readFirstExistingAsset("dashboard.html");
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
        // Phase 1 placeholder: empty job list until T08 lands the
        // launcher. Surface the route so the shell knows the contract.
        sendJson(res, 200, {
          schema_version: "studio-jobs.v1",
          jobs: [],
          warnings: [
            {
              message: "job launcher is queued for Sprint 31 T08",
              next_action: "Run jobs from the CLI for now (`riptide run`, `riptide campaign run`)."
            }
          ]
        });
        return;
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
  const ctx: StudioContext = {
    workspace,
    caseStudiesRoot,
    workspaces,
    workspacesById: new Map(workspaces.map((w) => [w.id, w])),
    startedAt: new Date().toISOString()
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

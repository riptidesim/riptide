import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sprint 6 T07 — Web Dashboard MVP.
 *
 * A tiny read-only HTTP server that renders a simulation's
 * `simulation-result.json` + `report.md` artifacts as a single-page
 * HTML dashboard. Invoked via the `--serve` flag on `riptide run`,
 * `riptide simulate`, and `riptide replay`.
 *
 * Design constraints (per T07):
 *  - No new npm deps. Uses `node:http` stdlib only. Chart.js is
 *    loaded from a CDN by the HTML itself; the server does not
 *    bundle it.
 *  - Primitive-agnostic rendering: the HTML iterates over whatever
 *    keys `summary` contains and derives a numeric-timeseries list
 *    from `timeseries[]`, so lending/perps/AMM/replay runs all
 *    render without special-casing.
 *  - Read-only. The server only reads from `runArtifactsDir`. It
 *    never writes.
 *  - Clean Ctrl-C: the caller wires `close()` to SIGINT; idle
 *    keep-alive sockets are tracked + destroyed so the process
 *    exits without zombie connections.
 */

export interface DashboardHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface StartDashboardOptions {
  /**
   * Preferred starting port. Defaults to 4173. If taken, the server
   * tries port+1, port+2, ... up to `maxAttempts-1` increments.
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

// The HTML template is shipped as a sibling `assets/` directory
// alongside the compiled CLI. At dev time it lives under
// `cli/assets/dashboard.html`; after `npm run build` + copy step it
// is also reachable from `cli/dist/assets/dashboard.html`. We probe
// both locations so the server works in both layouts without a
// bundler step.
function resolveAssetPath(filename: string): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Typical layouts:
  //   dev (tsx/ts-node): <repo>/cli/src/serve/index.ts
  //     → assets at <repo>/cli/assets/<filename>
  //   built:             <repo>/cli/dist/src/serve/index.js
  //     → assets at <repo>/cli/dist/assets/<filename>
  //                 or <repo>/cli/assets/<filename>
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

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
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
    routes: ["GET /", "GET /api/result", "GET /api/report"]
  });
}

function makeRequestHandler(runArtifactsDir: string) {
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
      if (pathname === "/api/result") {
        const raw = await readOptionalFile(path.join(runArtifactsDir, "simulation-result.json"));
        if (raw === null) {
          sendJson(res, 404, {
            error: "result_missing",
            message: `simulation-result.json not found in ${runArtifactsDir}`
          });
          return;
        }
        // Pass the raw bytes through instead of JSON.parse + stringify
        // so (a) we avoid O(n) re-encoding cost on large runs and (b)
        // the served bytes stay byte-identical to what the CLI wrote
        // to disk — handy for anyone diffing.
        sendText(res, 200, raw, "application/json");
        return;
      }
      if (pathname === "/api/report") {
        const raw = await readOptionalFile(path.join(runArtifactsDir, "report.md"));
        if (raw === null) {
          sendJson(res, 404, {
            error: "report_missing",
            message: `report.md not found in ${runArtifactsDir}`
          });
          return;
        }
        sendText(res, 200, raw, "text/markdown");
        return;
      }
      if (pathname === "/api/health") {
        sendJson(res, 200, { ok: true, runArtifactsDir });
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
 * The server is purely read-only; it reads `simulation-result.json`
 * and `report.md` from `runArtifactsDir` on every request so any
 * rerun that updates those files on disk shows up on refresh
 * without restarting the server.
 */
export async function startDashboardServer(
  runArtifactsDir: string,
  options: StartDashboardOptions = {}
): Promise<DashboardHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const startPort = options.port ?? DEFAULT_PORT;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  const handle = makeRequestHandler(path.resolve(runArtifactsDir));
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
      const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
      return {
        url,
        port,
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

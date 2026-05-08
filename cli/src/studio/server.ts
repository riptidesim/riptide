// Studio HTTP server.
//
// Localhost-only, file-backed dev server for the Riptide Studio app.
// Serves the React + Vite production bundle.
//
// Trust boundary:
// - Bind defaults to `127.0.0.1`.
// - No generic shell endpoint.
// - The job launcher accepts only structured allowlisted payloads.
// - The config-intent endpoint never mutates files.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
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
import { probeAgents, type AgentProbeResult } from "./agents.js";
import { detectProgramForStudio } from "./program-detect.js";
import { ChatStore } from "./chat/store.js";
import { ChatService } from "./chat/runner.js";
import { handleChatRoute, type ChatRouteServiceError } from "./chat/route.js";
import type { AgentId } from "./chat/types.js";
import {
  RiptideDirExistsError,
  ProgramDetectionError,
  scaffold,
  type ScaffoldOptions
} from "../init/index.js";
import { PROTOCOL_CHOICES, type Protocol } from "../init/personas-catalog.js";
import {
  listProjects,
  rememberProject,
  registerProject,
  removeProject,
  type RegistryPaths
} from "./registry.js";
import { homedir } from "node:os";

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
  /** Optional native directory picker override (used by tests). */
  directoryPicker?: StudioDirectoryPicker;
  /** Optional registry overrides (tests). */
  registryPaths?: RegistryPaths;
}

export interface StudioDirectoryPickResult {
  path: string | null;
  cancelled: boolean;
  message?: string;
}

export type StudioDirectoryPicker = () => Promise<StudioDirectoryPickResult>;

interface StudioContext {
  workspace: string;
  caseStudiesRoot?: string;
  workspaces: StudioWorkspace[];
  workspacesById: Map<string, StudioWorkspace>;
  startedAt: string;
  jobs: StudioJobQueue;
  chatServices: Map<string, ChatService>;
  agentProbeCache: AgentProbeResult[];
  directoryPicker: StudioDirectoryPicker;
  registryPaths?: RegistryPaths;
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

function packagedAssetCandidates(filename: string): string[] {
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

async function readFirstExistingPackagedAsset(filename: string): Promise<string> {
  const candidates = packagedAssetCandidates(filename);
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
  sendText(
    res,
    500,
    "Riptide Studio bundle is missing. Run `npm --prefix cli run build` to regenerate cli/assets/studio/.",
    "text/plain"
  );
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
      "GET /api/studio/browse-directory",
      "GET /api/studio/detect-program",
      "GET /api/studio/artifacts",
      "GET /api/studio/graph",
      "GET /api/studio/report",
      "GET /api/studio/jobs",
      "GET /api/studio/registry",
      "POST /api/studio/registry",
      "DELETE /api/studio/registry/:id",
      "POST /api/studio/init",
      "POST /api/studio/pick-directory",
      "POST /api/studio/jobs",
      "POST /api/studio/jobs/plan",
      "POST /api/studio/jobs/:id/cancel",
      "POST /api/studio/config/intent",
      "GET /api/studio/chat/threads",
      "POST /api/studio/chat/threads",
      "GET /api/studio/chat/threads/:id",
      "DELETE /api/studio/chat/threads/:id",
      "POST /api/studio/chat/threads/:id/runs",
      "GET /api/studio/chat/runs/:runId/stream",
      "POST /api/studio/chat/runs/:runId/abort",
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
    caseStudiesRoot: ctx.caseStudiesRoot,
    registryPaths: ctx.registryPaths
  });
  await rememberDiscoveredWorkspaces(next, ctx.registryPaths);
  ctx.workspaces = next;
  ctx.workspacesById = new Map(next.map((w) => [w.id, w]));
  ctx.jobs.setWorkspaces(next);
}

async function rememberDiscoveredWorkspaces(
  workspaces: StudioWorkspace[],
  registryPaths: RegistryPaths | undefined
): Promise<void> {
  for (const workspace of workspaces) {
    if (!workspace.has_riptide) continue;
    try {
      await rememberProject(
        {
          label: workspace.label,
          path: workspace.path
        },
        registryPaths
      );
    } catch {
      // The registry is convenience state. Studio should still launch if
      // the user-level file is temporarily unwritable or malformed.
    }
  }
}

const PROGRAM_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PROTOCOL_VALUES: ReadonlySet<Protocol> = new Set(
  PROTOCOL_CHOICES.map((c) => c.value)
);

function asInitInput(
  body: unknown
):
  | { programName: string; protocol: Protocol; targetPath: string | null; label: string | null }
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
  const rawPath =
    typeof o.path === "string" ? o.path :
    typeof o.target_path === "string" ? o.target_path : "";
  let targetPath: string | null = null;
  if (rawPath.trim().length > 0) {
    const expanded = expandHome(rawPath.trim());
    if (!path.isAbsolute(expanded)) {
      return {
        error: {
          status: 400,
          payload: { error: "invalid_path", message: "path must be absolute (starting with / or ~)" }
        }
      };
    }
    targetPath = path.resolve(expanded);
  }
  const rawLabel = typeof o.label === "string" ? o.label.trim() : "";
  return {
    programName,
    protocol: rawProtocol as Protocol,
    targetPath,
    label: rawLabel.length > 0 ? rawLabel : null
  };
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
  return input;
}

async function browseDirectory(
  requestedPath: string | null
): Promise<
  | {
      schema_version: "studio-directory-list.v1";
      path: string;
      parent: string | null;
      entries: Array<{ name: string; path: string }>;
    }
  | { status: number; payload: Record<string, unknown> }
> {
  const target = resolveBrowsePath(requestedPath);
  if (!target) {
    return {
      status: 400,
      payload: {
        error: "invalid_path",
        message: "directory path must be absolute or start with ~"
      }
    };
  }

  let targetStat;
  try {
    targetStat = await stat(target);
  } catch (err) {
    return {
      status: 404,
      payload: {
        error: "directory_not_found",
        message: `cannot read ${target}: ${(err as Error).message}`
      }
    };
  }
  if (!targetStat.isDirectory()) {
    return {
      status: 400,
      payload: {
        error: "not_a_directory",
        message: `${target} is not a directory`
      }
    };
  }

  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (err) {
    return {
      status: 403,
      payload: {
        error: "directory_unreadable",
        message: `cannot list ${target}: ${(err as Error).message}`
      }
    };
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(target, entry.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(target);
  return {
    schema_version: "studio-directory-list.v1",
    path: target,
    parent: parent === target ? null : parent,
    entries: dirs.slice(0, 250)
  };
}

function resolveBrowsePath(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return homedir();
  const expanded = expandHome(trimmed);
  if (!path.isAbsolute(expanded)) return null;
  return path.resolve(expanded);
}

async function pickDirectoryWithNativeDialog(): Promise<StudioDirectoryPickResult> {
  if (process.platform === "darwin") {
    return runFirstDirectoryPicker([
      {
        command: "osascript",
        args: [
          "-e",
          'POSIX path of (choose folder with prompt "Select Riptide workspace folder")'
        ]
      }
    ]);
  }

  if (process.platform === "win32") {
    return runFirstDirectoryPicker([
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-STA",
          "-Command",
          [
            "Add-Type -AssemblyName System.Windows.Forms;",
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
            "$d.Description = 'Select Riptide workspace folder';",
            "$d.ShowNewFolderButton = $true;",
            "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
            "  [Console]::Out.WriteLine($d.SelectedPath)",
            "} else {",
            "  exit 1",
            "}"
          ].join(" ")
        ]
      }
    ]);
  }

  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return {
      path: null,
      cancelled: false,
      message: "No graphical session is available; paste an absolute path manually."
    };
  }

  const portalResult = await runGjsXdgDesktopPortalDirectoryPicker();
  if (portalResult.kind === "success") {
    return { path: path.resolve(portalResult.path), cancelled: false };
  }
  if (portalResult.kind === "cancelled") {
    return { path: null, cancelled: true };
  }

  const home = homedir();
  return runFirstDirectoryPicker([
    {
      command: "zenity",
      args: [
        "--file-selection",
        "--directory",
        "--title=Select Riptide workspace folder",
        `--filename=${home}${path.sep}`
      ]
    },
    {
      command: "kdialog",
      args: [
        "--title",
        "Select Riptide workspace folder",
        "--getexistingdirectory",
        home
      ]
    },
    {
      command: "yad",
      args: [
        "--file",
        "--directory",
        "--title=Select Riptide workspace folder",
        `--filename=${home}${path.sep}`
      ]
    }
  ], [portalResult.message]);
}

interface DirectoryPickerCommand {
  command: string;
  args: string[];
}

async function runFirstDirectoryPicker(
  candidates: DirectoryPickerCommand[],
  initialErrors: string[] = []
): Promise<StudioDirectoryPickResult> {
  const errors: string[] = [...initialErrors];
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runDirectoryPickerCommand(candidate);
    if (result.kind === "success") {
      return { path: path.resolve(result.path), cancelled: false };
    }
    if (result.kind === "cancelled") {
      return { path: null, cancelled: true };
    }
    errors.push(result.message);
  }
  return {
    path: null,
    cancelled: false,
    message: `No supported native folder picker is available (${errors.join("; ")}). Paste an absolute path manually.`
  };
}

async function runGjsXdgDesktopPortalDirectoryPicker(): Promise<DirectoryPickerRunResult> {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
    return { kind: "unavailable", message: "xdg-desktop-portal: no session bus" };
  }

  try {
    const result = await execFilePromise("gjs", ["-c", GJS_XDG_PORTAL_DIRECTORY_PICKER]);
    return parseGjsPortalDirectoryPickerOutput(result.stdout);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === "ENOENT") {
      return { kind: "unavailable", message: "gjs not found" };
    }
    const parsed = typeof e.stdout === "string"
      ? parseGjsPortalDirectoryPickerOutput(e.stdout)
      : null;
    if (parsed && parsed.kind !== "unavailable") {
      return parsed;
    }
    const stderr = typeof e.stderr === "string" && e.stderr.trim().length > 0
      ? `: ${e.stderr.trim()}`
      : "";
    return { kind: "unavailable", message: `xdg-desktop-portal failed${stderr || `: ${e.message}`}` };
  }
}

export function parseGjsPortalDirectoryPickerOutput(output: string): DirectoryPickerRunResult {
  const line = output
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((entry) => /^(OK|CANCEL|UNAVAILABLE)(\t|$)/.test(entry));
  if (!line) {
    return { kind: "unavailable", message: "xdg-desktop-portal helper returned no result" };
  }
  if (line === "CANCEL") {
    return { kind: "cancelled" };
  }
  if (line.startsWith("OK\t")) {
    const picked = line.slice(3);
    return picked.length > 0
      ? { kind: "success", path: picked }
      : { kind: "unavailable", message: "xdg-desktop-portal helper returned an empty path" };
  }
  return {
    kind: "unavailable",
    message: line.startsWith("UNAVAILABLE\t")
      ? line.slice("UNAVAILABLE\t".length)
      : "xdg-desktop-portal helper returned an unknown result"
  };
}

type DirectoryPickerRunResult =
  | { kind: "success"; path: string }
  | { kind: "cancelled" }
  | { kind: "unavailable"; message: string };

const GJS_XDG_PORTAL_DIRECTORY_PICKER = `
const { Gio, GLib } = imports.gi;

const DEST = "org.freedesktop.portal.Desktop";
const OBJECT = "/org/freedesktop/portal/desktop";
let loop = null;

function finish(kind, value = "") {
  print(value ? kind + "\\t" + value : kind);
  if (loop) loop.quit();
}

try {
  const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
  const token = "riptide_" + GLib.uuid_string_random().replace(/-/g, "_");
  let handle = null;
  let done = false;

  loop = GLib.MainLoop.new(null, false);
  const subscription = bus.signal_subscribe(
    DEST,
    "org.freedesktop.portal.Request",
    "Response",
    null,
    null,
    Gio.DBusSignalFlags.NONE,
    (_connection, _sender, objectPath, _iface, _signal, params) => {
      if (handle && objectPath !== handle) return;
      done = true;
      bus.signal_unsubscribe(subscription);

      const unpacked = params.deepUnpack();
      const response = Number(unpacked[0]);
      const results = unpacked[1] || {};
      if (response === 1) {
        finish("CANCEL");
        return;
      }
      if (response !== 0) {
        finish("CANCEL");
        return;
      }

      let uris = results.uris;
      if (uris instanceof GLib.Variant) uris = uris.deepUnpack();
      if (!uris || uris.length === 0) {
        finish("UNAVAILABLE", "portal returned no URI");
        return;
      }

      const uri = String(uris[0]);
      try {
        const [filename] = GLib.filename_from_uri(uri);
        finish("OK", filename);
      } catch (err) {
        finish("UNAVAILABLE", "unsupported URI " + uri + ": " + err.message);
      }
    }
  );

  const result = bus.call_sync(
    DEST,
    OBJECT,
    "org.freedesktop.portal.FileChooser",
    "OpenFile",
    new GLib.Variant("(ssa{sv})", ["", "Select Riptide workspace folder", {
      "directory": GLib.Variant.new_boolean(true),
      "modal": GLib.Variant.new_boolean(true),
      "handle_token": GLib.Variant.new_string(token)
    }]),
    new GLib.VariantType("(o)"),
    Gio.DBusCallFlags.NONE,
    -1,
    null
  );
  handle = result.deepUnpack()[0];

  GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 600, () => {
    if (!done) {
      bus.signal_unsubscribe(subscription);
      finish("UNAVAILABLE", "portal request timed out");
    }
    return GLib.SOURCE_REMOVE;
  });
  loop.run();
} catch (err) {
  finish("UNAVAILABLE", err.message || String(err));
}
`;

async function runDirectoryPickerCommand(
  candidate: DirectoryPickerCommand
): Promise<DirectoryPickerRunResult> {
  try {
    const { stdout } = await execFilePromise(candidate.command, candidate.args);
    const picked = stdout.trim();
    if (picked.length === 0) return { kind: "cancelled" };
    return { kind: "success", path: picked };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown };
    const picked = typeof e.stdout === "string" ? e.stdout.trim() : "";
    if (picked.length > 0) return { kind: "success", path: picked };
    if (e.code === "ENOENT") {
      return { kind: "unavailable", message: `${candidate.command} not found` };
    }
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    if (/cannot open display|failed to open display|no display|could not connect/i.test(stderr)) {
      return {
        kind: "unavailable",
        message: `${candidate.command}: ${stderr || "display unavailable"}`
      };
    }
    return { kind: "cancelled" };
  }
}

function execFilePromise(
  file: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 10 * 60 * 1000,
        windowsHide: false
      },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stdout, stderr });
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
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
      // ---- Chat routes (own their own dispatch + method handling) ----
      if (pathname.startsWith("/api/studio/chat/")) {
        const handled = await handleChatRoute(
          {
            getService: (workspaceId) => getChatService(ctx, workspaceId),
            findRunService: (runId) => findChatServiceByRun(ctx, runId)
          },
          { readBody, sendJson },
          { req, res, pathname, method }
        );
        if (handled) return;
      }
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
      if (pathname === "/api/studio/pick-directory" && method === "POST") {
        try {
          const picked = await ctx.directoryPicker();
          sendJson(res, 200, {
            schema_version: "studio-pick-directory.v1",
            path: picked.path,
            cancelled: picked.cancelled,
            ...(picked.message ? { message: picked.message } : {})
          });
        } catch (err) {
          sendJson(res, 500, {
            error: "directory_picker_failed",
            message: (err as Error).message
          });
        }
        return;
      }
      if (pathname === "/api/studio/browse-directory" && method === "GET") {
        const result = await browseDirectory(url.searchParams.get("path"));
        if ("status" in result) {
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
        const targetCwd = parsed.targetPath ?? ctx.workspace;
        if (parsed.targetPath) {
          try {
            await mkdir(parsed.targetPath, { recursive: true });
          } catch (err) {
            sendJson(res, 400, {
              error: "invalid_path",
              message: `could not create directory ${parsed.targetPath}: ${(err as Error).message}`
            });
            return;
          }
          let pathStat;
          try {
            pathStat = await stat(parsed.targetPath);
          } catch (err) {
            sendJson(res, 400, {
              error: "invalid_path",
              message: `cannot stat ${parsed.targetPath}: ${(err as Error).message}`
            });
            return;
          }
          if (!pathStat.isDirectory()) {
            sendJson(res, 400, { error: "invalid_path", message: `${parsed.targetPath} is not a directory` });
            return;
          }
        }
        const scaffoldOptions: ScaffoldOptions = {
          cwd: targetCwd,
          force: false,
          mode: "minimal",
          blank: true,
          programName: parsed.programName,
          protocol: parsed.protocol
        };
        try {
          const result = await scaffold(scaffoldOptions);
          // Persist every scaffolded project to the user-level registry
          // so the workspace rail can show it on future Studio launches
          // from any directory.
          try {
            const registeredPath = parsed.targetPath ?? targetCwd;
            const fallbackLabel = path.basename(registeredPath) || parsed.programName;
            await registerProject(
              {
                label: parsed.label ?? fallbackLabel,
                path: registeredPath
              },
              ctx.registryPaths
            );
          } catch (err) {
            result.warnings.push(`could not save project to registry: ${(err as Error).message}`);
          }
          await refreshWorkspaces(ctx);
          sendJson(res, 201, {
            schema_version: "studio-init.v1",
            program_name: result.programName,
            protocol: parsed.protocol,
            target_path: parsed.targetPath,
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
      if (pathname === "/api/studio/registry" && method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body !== "object") {
          sendJson(res, 400, { error: "invalid_body", message: "expected JSON object" });
          return;
        }
        const o = body as Record<string, unknown>;
        const rawPath = typeof o.path === "string" ? o.path.trim() : "";
        if (rawPath.length === 0) {
          sendJson(res, 400, { error: "missing_path", message: "path is required" });
          return;
        }
        const expanded = expandHome(rawPath);
        if (!path.isAbsolute(expanded)) {
          sendJson(res, 400, { error: "invalid_path", message: "path must be absolute" });
          return;
        }
        const absolute = path.resolve(expanded);
        const label = typeof o.label === "string" && o.label.trim().length > 0
          ? o.label.trim()
          : path.basename(absolute);
        try {
          const project = await registerProject({ label, path: absolute }, ctx.registryPaths);
          await refreshWorkspaces(ctx);
          sendJson(res, 201, {
            schema_version: "studio-registry-entry.v1",
            project,
            workspaces: ctx.workspaces
          });
        } catch (err) {
          sendJson(res, 500, { error: "registry_failed", message: (err as Error).message });
        }
        return;
      }
      const registryDeleteMatch = /^\/api\/studio\/registry\/([^/]+)$/.exec(pathname);
      if (registryDeleteMatch && method === "DELETE") {
        const id = registryDeleteMatch[1] as string;
        try {
          const removed = await removeProject(id, ctx.registryPaths);
          if (!removed) {
            sendJson(res, 404, { error: "not_found", message: `no registered project with id ${id}` });
            return;
          }
          await refreshWorkspaces(ctx);
          sendJson(res, 200, {
            schema_version: "studio-registry-removed.v1",
            workspaces: ctx.workspaces
          });
        } catch (err) {
          sendJson(res, 500, { error: "registry_failed", message: (err as Error).message });
        }
        return;
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
        const html = await readFirstExistingPackagedAsset("dashboard.html");
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
      if (pathname === "/api/studio/registry") {
        try {
          const projects = await listProjects(ctx.registryPaths);
          sendJson(res, 200, {
            schema_version: "studio-registry.v1",
            projects
          });
        } catch (err) {
          sendJson(res, 500, { error: "registry_failed", message: (err as Error).message });
        }
        return;
      }
      if (pathname === "/api/studio/agents") {
        const agents = await probeAgents();
        ctx.agentProbeCache = agents;
        sendJson(res, 200, { schema_version: "studio-agents.v1", agents });
        return;
      }
      if (pathname === "/api/studio/protocols") {
        sendJson(res, 200, { schema_version: "studio-protocols.v1", protocols: PROTOCOL_CHOICES });
        return;
      }
      if (pathname === "/api/studio/detect-program") {
        const selection = selectWorkspace(ctx, url.searchParams);
        if ("error" in selection) {
          sendJson(res, selection.error.status, selection.error.payload);
          return;
        }
        const detection = detectProgramForStudio(selection.path);
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
      if (pathname === "/api/studio/source") {
        const selection = selectWorkspace(ctx, url.searchParams);
        if ("error" in selection) {
          sendJson(res, selection.error.status, selection.error.payload);
          return;
        }
        const requested = url.searchParams.get("path");
        if (!requested) {
          sendJson(res, 400, {
            error: "missing_path",
            message: "the `path` query parameter is required"
          });
          return;
        }
        const workspaceRoot = path.resolve(selection.path);
        const resolved = path.resolve(workspaceRoot, requested);
        if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
          sendJson(res, 403, {
            error: "path_outside_workspace",
            message: "requested path is outside the workspace"
          });
          return;
        }
        try {
          const stats = await stat(resolved);
          if (!stats.isFile()) {
            sendJson(res, 415, {
              error: "not_a_file",
              message: "requested path is not a regular file"
            });
            return;
          }
          const MAX_BYTES = 256 * 1024;
          if (stats.size > MAX_BYTES) {
            sendJson(res, 413, {
              error: "file_too_large",
              message: `file exceeds ${MAX_BYTES} byte limit`,
              bytes: stats.size
            });
            return;
          }
          const content = await readFile(resolved, "utf8");
          sendJson(res, 200, {
            schema_version: "studio-source.v1",
            workspace_id: selection.id,
            path: path.relative(workspaceRoot, resolved) || path.basename(resolved),
            absolute_path: resolved,
            bytes: stats.size,
            content
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            sendJson(res, 404, {
              error: "file_not_found",
              message: `no file at ${requested}`
            });
            return;
          }
          throw err;
        }
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
    caseStudiesRoot,
    registryPaths: options.registryPaths
  });
  await rememberDiscoveredWorkspaces(workspaces, options.registryPaths);
  const jobQueue = options.jobQueue ?? new StudioJobQueue();
  jobQueue.setWorkspaces(workspaces);
  for (const ws of workspaces) {
    try {
      await jobQueue.hydrate(ws);
    } catch {
      // ignore hydration errors per workspace; surface in job records elsewhere.
    }
  }

  // Probe agents once at startup so the chat service can resolve binaryPath
  // without re-spawning version probes on every POST /runs. The cache is
  // refreshed whenever the UI hits GET /api/studio/agents.
  let initialProbe: AgentProbeResult[] = [];
  try {
    initialProbe = await probeAgents();
  } catch {
    initialProbe = [];
  }

  const ctx: StudioContext = {
    workspace,
    caseStudiesRoot,
    workspaces,
    workspacesById: new Map(workspaces.map((w) => [w.id, w])),
    startedAt: new Date().toISOString(),
    jobs: jobQueue,
    chatServices: new Map<string, ChatService>(),
    agentProbeCache: initialProbe,
    directoryPicker: options.directoryPicker ?? pickDirectoryWithNativeDialog,
    registryPaths: options.registryPaths
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

function getChatService(
  ctx: StudioContext,
  workspaceId?: string | null
): ChatService | ChatRouteServiceError {
  const workspace =
    workspaceId && workspaceId.length > 0
      ? ctx.workspacesById.get(workspaceId)
      : ctx.workspaces[0];
  if (!workspace) {
    return {
      status: workspaceId ? 404 : 400,
      payload: {
        error: workspaceId ? "workspace_not_found" : "no_workspace",
        message: workspaceId
          ? `workspace ${JSON.stringify(workspaceId)} is not registered`
          : "no workspace is currently registered",
        details: { workspaces: ctx.workspaces.map((w) => w.id) }
      }
    };
  }
  const existing = ctx.chatServices.get(workspace.id);
  if (existing) return existing;
  const service = new ChatService({
    store: new ChatStore({ workspacePath: workspace.path }),
    resolveAgent: (id: AgentId) => ctx.agentProbeCache.find((a) => a.id === id) ?? null
  });
  ctx.chatServices.set(workspace.id, service);
  return service;
}

function findChatServiceByRun(ctx: StudioContext, runId: string): ChatService | null {
  for (const service of ctx.chatServices.values()) {
    if (service.getRun(runId)) return service;
  }
  return null;
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

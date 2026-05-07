// PATH probe for coding-agent CLIs the Studio first-run wizard offers.
//
// Detection has to survive Studio being launched from a context with a
// stripped PATH — e.g. a desktop launcher or systemd user unit that never
// sourced the user's shell rc, so version managers like mise/asdf/nvm
// haven't installed their shim directories. We try three layers in order:
//
//   1. The in-process PATH (cheap, exact).
//   2. A small allow-list of common install locations (mise/asdf shims,
//      ~/.local/bin, ~/.cargo/bin, /opt/homebrew/bin, /usr/local/bin).
//   3. The user's login shell via `$SHELL -lic 'command -v <bin>'`, which
//      fully sources the user's interactive PATH.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface AgentDescriptor {
  id: string;
  label: string;
  binary: string;
  recommended: boolean;
}

export interface AgentProbeResult extends AgentDescriptor {
  detected: boolean;
  version: string | null;
  path: string | null;
}

export const AGENT_DESCRIPTORS: AgentDescriptor[] = [
  { id: "claude-code", label: "Claude Code", binary: "claude", recommended: true },
  { id: "codex", label: "Codex", binary: "codex", recommended: true },
  { id: "gemini", label: "Gemini CLI", binary: "gemini", recommended: false },
  { id: "cursor", label: "Cursor", binary: "cursor-agent", recommended: false },
  { id: "opencode", label: "OpenCode", binary: "opencode", recommended: false }
];

const PROBE_TIMEOUT_MS = 4000;

export async function probeAgents(): Promise<AgentProbeResult[]> {
  return Promise.all(AGENT_DESCRIPTORS.map(probeOne));
}

async function probeOne(desc: AgentDescriptor): Promise<AgentProbeResult> {
  const resolvedPath =
    resolveOnPath(desc.binary) ??
    resolveInCommonDirs(desc.binary) ??
    (await resolveViaLoginShell(desc.binary));
  if (!resolvedPath) {
    return { ...desc, detected: false, version: null, path: null };
  }
  // Version-probe the resolved absolute path — it doesn't depend on PATH being
  // set up in the spawned env, which matters when we found the binary via
  // step 2 or 3 above.
  const versionRes = await runCapture(resolvedPath, ["--version"]);
  const version = versionRes.ok ? parseVersion(versionRes.stdout) ?? null : null;
  return { ...desc, detected: versionRes.ok, version, path: resolvedPath };
}

function resolveOnPath(binary: string): string | null {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function resolveInCommonDirs(binary: string): string | null {
  if (process.platform === "win32") return null;
  const home = homedir();
  const candidates = [
    `${home}/.local/share/mise/shims`,
    `${home}/.asdf/shims`,
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    `${home}/.bun/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin"
  ];
  for (const dir of candidates) {
    const c = path.join(dir, binary);
    if (isExecutable(c)) return c;
  }
  return null;
}

async function resolveViaLoginShell(binary: string): Promise<string | null> {
  if (process.platform === "win32") return null;
  const shell = process.env.SHELL || "/bin/bash";
  const res = await runCapture(shell, ["-lic", `command -v ${shellQuote(binary)}`]);
  if (!res.ok) return null;
  const out = res.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!out || !path.isAbsolute(out)) return null;
  return isExecutable(out) ? out : null;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface CaptureResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runCapture(bin: string, args: string[]): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finalize = (result: CaptureResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finalize({ ok: false, stdout: "", stderr: "" });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finalize({ ok: false, stdout: Buffer.concat(out).toString("utf8"), stderr: "timed out" });
    }, PROBE_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      finalize({ ok: false, stdout: "", stderr: "" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      finalize({
        ok: code === 0,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8")
      });
    });
  });
}

function parseVersion(s: string): string | null {
  const m = s.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return m ? m[0] : null;
}

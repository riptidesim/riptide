// PATH probe for coding-agent CLIs the Studio first-run wizard offers.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
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

const PROBE_TIMEOUT_MS = 1500;

export async function probeAgents(): Promise<AgentProbeResult[]> {
  return Promise.all(AGENT_DESCRIPTORS.map(probeOne));
}

async function probeOne(desc: AgentDescriptor): Promise<AgentProbeResult> {
  const resolvedPath = resolveOnPath(desc.binary);
  if (!resolvedPath) {
    return { ...desc, detected: false, version: null, path: null };
  }
  const versionRes = await runCapture(desc.binary, ["--version"]);
  const version = versionRes.ok ? parseVersion(versionRes.stdout) ?? null : null;
  return { ...desc, detected: versionRes.ok, version, path: resolvedPath };
}

function resolveOnPath(binary: string): string | null {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
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

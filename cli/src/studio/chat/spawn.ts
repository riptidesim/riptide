// Spawn primitive for arbitrary detected agent CLIs.
//
// Trust contract:
// - shell:false, no PATH lookup — caller supplies the absolute binaryPath.
// - Prompt is delivered via stdin; argv carries only flags + values that
//   the calling adapter validates against its own ALLOWED_FLAGS set.
// - cwd is anchored to the active workspace by the caller; this file does
//   not validate it. Adapters and the runner own that policy.
//
// Concurrency: one process per call. Lifetime is bounded by an
// AbortSignal + a hard timeout. SIGTERM first, SIGKILL after grace.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const STDERR_TAIL_BYTES = 4 * 1024;
const STDOUT_TAIL_BYTES = 4 * 1024;
// Agentic configuration runs (riptide-config and similar) routinely take
// 15–40 minutes when they include cargo builds + smoke runs. Default 1
// hour; override via RIPTIDE_STUDIO_CHAT_TIMEOUT_MS for longer runs.
export const DEFAULT_TIMEOUT_MS = readTimeoutOverride() ?? 60 * 60 * 1000;
export const DEFAULT_GRACE_MS = 2_500;

function readTimeoutOverride(): number | null {
  const raw = process.env.RIPTIDE_STUDIO_CHAT_TIMEOUT_MS;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export interface SpawnInput {
  binaryPath: string;
  args: string[];
  cwd: string;
  stdin: string;
  abortSignal: AbortSignal;
  timeoutMs?: number;
  graceMs?: number;
  extraEnv?: Record<string, string>;
  onStdoutLine: (line: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stderrTail: string;
  stdoutTail: string;
  startedAt: string;
  finishedAt: string;
}

export async function runAgent(input: SpawnInput): Promise<SpawnResult> {
  if (!path.isAbsolute(input.binaryPath)) {
    throw new Error(`agent binary path must be absolute: ${input.binaryPath}`);
  }
  const env: Record<string, string> = filterStringEnv({
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    CI: "1",
    ...input.extraEnv
  });

  const startedAt = new Date().toISOString();
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(input.binaryPath, input.args, {
      cwd: input.cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    const finishedAt = new Date().toISOString();
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      stderrTail: (err as Error).message,
      stdoutTail: "",
      startedAt,
      finishedAt
    };
  }

  let stderrTail = "";
  let stdoutTail = "";
  let timedOut = false;
  let aborted = false;
  let killed = false;

  const stdoutLines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  stdoutLines.on("line", (line: string) => {
    stdoutTail = appendTail(stdoutTail, line + "\n", STDOUT_TAIL_BYTES);
    try {
      input.onStdoutLine(line);
    } catch {
      // Adapter callbacks must not crash the spawn loop.
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderrTail = appendTail(stderrTail, chunk, STDERR_TAIL_BYTES);
    if (input.onStderrChunk) {
      try {
        input.onStderrChunk(chunk);
      } catch {
        // Same — never let user callbacks break IO.
      }
    }
  });

  // Stdin: write the prompt then close so the agent stops waiting on EOF.
  try {
    proc.stdin.write(input.stdin);
  } catch {
    // If stdin is already closed (rare), the agent will exit nonzero.
  }
  try {
    proc.stdin.end();
  } catch {
    // Best effort; ignore.
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;

  const cleanupTokens: Array<() => void> = [];
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    sendTermThenKill(proc, graceMs).then((wasKilled) => {
      if (wasKilled) killed = true;
    });
  }, timeoutMs);
  timeoutHandle.unref?.();
  cleanupTokens.push(() => clearTimeout(timeoutHandle));

  const onAbort = () => {
    aborted = true;
    sendTermThenKill(proc, graceMs).then((wasKilled) => {
      if (wasKilled) killed = true;
    });
  };
  if (input.abortSignal.aborted) {
    onAbort();
  } else {
    input.abortSignal.addEventListener("abort", onAbort, { once: true });
    cleanupTokens.push(() => input.abortSignal.removeEventListener("abort", onAbort));
  }

  const closeResult: { exitCode: number | null; signal: NodeJS.Signals | null } = await new Promise(
    (resolve) => {
      proc.once("error", (err) => {
        stderrTail = appendTail(stderrTail, `\nspawn error: ${err.message}`, STDERR_TAIL_BYTES);
        resolve({ exitCode: null, signal: null });
      });
      proc.once("close", (code, signal) => {
        resolve({ exitCode: code, signal });
      });
    }
  );

  for (const fn of cleanupTokens) fn();

  void killed; // referenced via stderrTail update only

  const finishedAt = new Date().toISOString();
  return {
    exitCode: closeResult.exitCode,
    signal: closeResult.signal,
    timedOut,
    aborted,
    stderrTail,
    stdoutTail,
    startedAt,
    finishedAt
  };
}

async function sendTermThenKill(
  proc: ChildProcessWithoutNullStreams,
  graceMs: number
): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return false;
  try {
    proc.kill("SIGTERM");
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      resolve(true);
    }, graceMs);
    timer.unref?.();
    proc.once("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function appendTail(prev: string, chunk: string, capBytes: number): string {
  const next = prev + chunk;
  if (Buffer.byteLength(next, "utf8") <= capBytes) return next;
  // Drop from the front until we fit. Cheap and bounded.
  const buf = Buffer.from(next, "utf8");
  return buf.subarray(buf.length - capBytes).toString("utf8");
}

function filterStringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

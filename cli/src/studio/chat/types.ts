// Shared types for the Studio agent-chat subsystem.
//
// Adapters, runner, store, and route all depend on these. No node-API
// imports here — keeps the file safe to reference from tests and from
// any new tooling that wants to type-check chat payloads.

export type ChatErrorFamily =
  | "login_required"
  | "rate_limited"
  | "transient_upstream"
  | "unknown_session"
  | "prompt_too_large"
  | "binary_missing"
  | "spawn_failed"
  | "nonzero_exit"
  | "aborted"
  | "internal";

export interface AdapterCapabilities {
  supportsResume: boolean;
  supportsModelOverride: boolean;
  /** Adapter-declared cap; runner enforces min(this, 64KB). */
  promptByteLimit: number;
}

export interface AdapterUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface AdapterError {
  family: ChatErrorFamily;
  message: string;
  /** ISO timestamp; UI surfaces, no auto-retry in v1. */
  retryNotBefore?: string;
  /** Set when family === "login_required". */
  loginUrl?: string;
  /** Last 4KB of stderr, redacted. */
  raw?: string;
}

export type AdapterDelta =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; role: "assistant"; text: string }
  | { kind: "tool_use"; name: string; summary: string }
  | {
      kind: "usage";
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }
  | { kind: "cost"; usd: number };

export interface AdapterStartInput {
  prompt: string;
  /** "default"/null => no --model flag. */
  model: string | null;
  resumeSessionId: string | null;
  cwd: string;
  abortSignal: AbortSignal;
  /** Absolute path from probeAgents(). */
  binaryPath: string;
  onLog: (chan: "stdout" | "stderr", line: string) => void;
  onDelta: (delta: AdapterDelta) => void;
}

export interface AdapterRunResult {
  sessionId: string | null;
  finalText: string;
  usage: AdapterUsage | null;
  costUsd: number | null;
  exitCode: number | null;
  error: AdapterError | null;
}

export interface AgentAdapter {
  agentId: string;
  capabilities: AdapterCapabilities;
  /** Build argv without spawning — used for the SSE `meta` event. */
  buildArgv(input: Pick<AdapterStartInput, "model" | "resumeSessionId">): string[];
  startRun(input: AdapterStartInput): Promise<AdapterRunResult>;
}

// ---------------------------------------------------------------------------
// Persistence shapes
// ---------------------------------------------------------------------------

export type AgentId = "claude-code" | "codex";

export interface ThreadMeta {
  schemaVersion: "studio-chat-thread.v1";
  id: string;
  title: string;
  agentId: AgentId;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastError: { family: ChatErrorFamily; message: string } | null;
}

export interface ChatThreadSummary {
  id: string;
  title: string;
  agentId: AgentId;
  model: string;
  updatedAt: string;
  messageCount: number;
  lastError: { family: ChatErrorFamily; message: string } | null;
}

export type JsonlLine =
  | { kind: "user"; ts: string; runId: string; text: string }
  | {
      kind: "assistant";
      ts: string;
      runId: string;
      text: string;
      sessionId: string | null;
      usage?: AdapterUsage;
      costUsd?: number;
      restarted?: boolean;
    }
  | {
      kind: "system";
      ts: string;
      runId: string;
      subkind: "thread_restarted" | "login_required" | "rate_limited";
      detail: string;
    }
  | {
      kind: "error";
      ts: string;
      runId: string;
      family: ChatErrorFamily;
      message: string;
    };

export interface SessionRecord {
  agentId: AgentId;
  model: string;
  sessionId: string | null;
  updatedAt: string;
}

export interface SessionsFile {
  schemaVersion: "studio-chat-sessions.v1";
  threads: Record<string, SessionRecord>;
}

// ---------------------------------------------------------------------------
// SSE event shape (server → browser)
// ---------------------------------------------------------------------------

export type ChatStreamEvent =
  | {
      name: "meta";
      data: {
        runId: string;
        threadId: string;
        agentId: AgentId;
        model: string;
        argv: string[];
        cwd: string;
        resumeSessionId: string | null;
        startedAt: string;
      };
    }
  | { name: "delta"; data: { role: "assistant"; text: string; seq: number } }
  | { name: "tool"; data: { name: string; summary: string; seq: number } }
  | { name: "usage"; data: AdapterUsage }
  | { name: "cost"; data: { usd: number } }
  | {
      name: "done";
      data: {
        runId: string;
        sessionId: string | null;
        finalText: string;
        durationMs: number;
        restarted: boolean;
      };
    }
  | {
      name: "error";
      data: {
        runId: string;
        family: ChatErrorFamily;
        message: string;
        retryNotBefore?: string;
        loginUrl?: string;
      };
    };

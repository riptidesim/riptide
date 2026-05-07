// Glue between routes, store, spawn, and adapters.
//
// Owns:
//   - The in-memory RunRegistry: holds active and recently-finished runs
//     so a slow EventSource can attach after POST /runs returns.
//   - Per-thread concurrency (one in-flight run per thread).
//   - Global concurrency (one in-flight run total in v1).
//   - The "retry without --resume on unknown_session" pattern.
//
// runTurn() emits SSE-shaped events into a buffer + any attached sinks,
// persists user/assistant lines on terminal events, and updates
// sessions.json with the freshest sessionId.

import type {
  AdapterUsage,
  AgentAdapter,
  AgentId,
  ChatStreamEvent,
  JsonlLine,
  ThreadMeta
} from "./types.js";
import type { AgentProbeResult } from "../agents.js";
import { ChatStore, isValidThreadId } from "./store.js";
import { getAdapter } from "./adapters/index.js";
import type { SseSink } from "./sse.js";
import { redact } from "./adapters/normalize.js";

const RUN_GC_RETENTION_MS = 60_000;
const GLOBAL_CONCURRENCY = 1;

export interface RunRecord {
  runId: string;
  threadId: string;
  agentId: AgentId;
  model: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  resumeSessionId: string | null;
  controller: AbortController;
  buffered: ChatStreamEvent[];
  sinks: Set<SseSink>;
  finished: boolean;
  finishedAt: number | null;
  completion: Promise<void>;
}

export interface PostRunInput {
  threadId: string;
  prompt: string;
  modelOverride?: string;
}

export interface PostRunOutcome {
  runId: string;
  streamUrl: string;
}

export type AgentResolver = (agentId: AgentId) => AgentProbeResult | null;

export class ChatService {
  private readonly store: ChatStore;
  private readonly resolveAgent: AgentResolver;
  private readonly runs = new Map<string, RunRecord>();
  /** Thread id -> active runId. */
  private readonly activeByThread = new Map<string, string>();
  private activeCount = 0;
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(opts: { store: ChatStore; resolveAgent: AgentResolver }) {
    this.store = opts.store;
    this.resolveAgent = opts.resolveAgent;
  }

  getStore(): ChatStore {
    return this.store;
  }

  getRun(runId: string): RunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  attachSink(runId: string, sink: SseSink): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    // Replay buffered events first.
    for (const evt of run.buffered) sink.writeEvent(evt);
    if (run.finished) {
      sink.close();
      return true;
    }
    run.sinks.add(sink);
    return true;
  }

  async abort(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.finished) return false;
    run.controller.abort();
    return true;
  }

  /** Abort any in-flight run on this thread. Used by DELETE /threads/:id. */
  abortByThread(threadId: string): void {
    const runId = this.activeByThread.get(threadId);
    if (!runId) return;
    const run = this.runs.get(runId);
    if (run && !run.finished) run.controller.abort();
  }

  async postRun(input: PostRunInput): Promise<
    | { kind: "ok"; outcome: PostRunOutcome }
    | { kind: "error"; status: number; body: { error: string; message: string; details?: unknown } }
  > {
    if (!isValidThreadId(input.threadId)) {
      return { kind: "error", status: 400, body: { error: "invalid_thread", message: "thread id is malformed" } };
    }
    const meta = this.store.getThread(input.threadId);
    if (!meta) {
      return { kind: "error", status: 404, body: { error: "thread_not_found", message: input.threadId } };
    }
    const adapter = getAdapter(meta.agentId);
    if (!adapter) {
      return {
        kind: "error",
        status: 400,
        body: { error: "agent_unsupported", message: `Studio does not support ${meta.agentId} chat in v1` }
      };
    }
    const probe = this.resolveAgent(meta.agentId);
    if (!probe || !probe.detected || !probe.path) {
      return {
        kind: "error",
        status: 400,
        body: {
          error: "binary_missing",
          message: `${meta.agentId} CLI not found on PATH`,
          details: { binary: probe?.binary ?? null }
        }
      };
    }
    const promptBytes = Buffer.byteLength(input.prompt, "utf8");
    const promptCap = Math.min(adapter.capabilities.promptByteLimit, 64 * 1024);
    if (promptBytes > promptCap) {
      return {
        kind: "error",
        status: 400,
        body: {
          error: "prompt_too_large",
          message: `prompt is ${promptBytes} bytes; cap is ${promptCap}`
        }
      };
    }
    if (this.activeByThread.has(input.threadId)) {
      return {
        kind: "error",
        status: 409,
        body: { error: "thread_busy", message: "another run is already in flight on this thread" }
      };
    }
    if (this.activeCount >= GLOBAL_CONCURRENCY) {
      return {
        kind: "error",
        status: 409,
        body: {
          error: "studio_busy",
          message: "Studio is already running an agent turn — try again in a moment"
        }
      };
    }
    const modelOverride =
      input.modelOverride && input.modelOverride.length > 0 ? input.modelOverride : null;
    const effectiveModel = modelOverride ?? meta.model;
    const session = this.store.getSession(input.threadId);
    const resumeSessionId = adapter.capabilities.supportsResume ? session?.sessionId ?? null : null;

    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const argv = adapter.buildArgv({ model: effectiveModel, resumeSessionId });
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    const cwd = this.store.workspacePath();

    const record: RunRecord = {
      runId,
      threadId: input.threadId,
      agentId: meta.agentId,
      model: effectiveModel,
      argv,
      cwd,
      startedAt,
      resumeSessionId,
      controller,
      buffered: [],
      sinks: new Set<SseSink>(),
      finished: false,
      finishedAt: null,
      // Filled in immediately below.
      completion: Promise.resolve()
    };
    this.runs.set(runId, record);
    this.activeByThread.set(input.threadId, runId);
    this.activeCount++;

    record.completion = this.executeTurn({
      record,
      adapter,
      meta,
      binaryPath: probe.path,
      prompt: input.prompt,
      effectiveModel,
      resumeSessionId
    }).catch((err) => {
      // Last-resort safety net — should not be reachable.
      this.emitAndPersist(record, {
        name: "error",
        data: {
          runId,
          family: "internal",
          message: (err as Error).message
        }
      });
    }).finally(() => {
      this.finishRun(record);
    });

    return {
      kind: "ok",
      outcome: { runId, streamUrl: `/api/studio/chat/runs/${runId}/stream` }
    };
  }

  private async executeTurn(input: {
    record: RunRecord;
    adapter: AgentAdapter;
    meta: ThreadMeta;
    binaryPath: string;
    prompt: string;
    effectiveModel: string;
    resumeSessionId: string | null;
  }): Promise<void> {
    const { record, adapter, meta, binaryPath, prompt, effectiveModel } = input;
    let resumeSessionId = input.resumeSessionId;
    let restarted = false;

    // First emit the meta event with the exact argv we are about to run.
    this.emit(record, {
      name: "meta",
      data: {
        runId: record.runId,
        threadId: record.threadId,
        agentId: meta.agentId,
        model: effectiveModel,
        argv: record.argv,
        cwd: record.cwd,
        resumeSessionId,
        startedAt: record.startedAt
      }
    });

    let seq = 0;
    let liveSessionId: string | null = resumeSessionId;
    const startedMs = Date.now();
    const onDelta = (kind: "delta" | "tool", payload: { text?: string; name?: string; summary?: string }) => {
      seq++;
      if (kind === "delta") {
        this.emit(record, {
          name: "delta",
          data: { role: "assistant", text: payload.text ?? "", seq }
        });
      } else {
        this.emit(record, {
          name: "tool",
          data: { name: payload.name ?? "tool", summary: payload.summary ?? "", seq }
        });
      }
    };

    const runOnce = async (resumeId: string | null) => {
      const argvForAttempt = adapter.buildArgv({ model: effectiveModel, resumeSessionId: resumeId });
      // Update the record so attach replays carry the latest argv.
      record.argv = argvForAttempt;
      const result = await adapter.startRun({
        prompt,
        model: effectiveModel,
        resumeSessionId: resumeId,
        cwd: record.cwd,
        abortSignal: record.controller.signal,
        binaryPath,
        onLog: () => {
          // Already mirrored to spawn's tail buffer; no SSE forwarding in v1.
        },
        onDelta: (delta) => {
          if (delta.kind === "session") liveSessionId = delta.sessionId;
          else if (delta.kind === "text") onDelta("delta", { text: delta.text });
          else if (delta.kind === "tool_use") onDelta("tool", { name: delta.name, summary: delta.summary });
          else if (delta.kind === "usage") {
            this.emit(record, {
              name: "usage",
              data: {
                inputTokens: delta.inputTokens ?? 0,
                outputTokens: delta.outputTokens ?? 0,
                cacheReadTokens: delta.cacheReadTokens,
                cacheCreationTokens: delta.cacheCreationTokens
              }
            });
          } else if (delta.kind === "cost") {
            this.emit(record, { name: "cost", data: { usd: delta.usd } });
          }
        }
      });
      return result;
    };

    let result = await runOnce(resumeSessionId);

    if (
      result.error?.family === "unknown_session" &&
      resumeSessionId !== null &&
      adapter.capabilities.supportsResume
    ) {
      restarted = true;
      // Persist the system notice ahead of the second attempt.
      const restartLine: JsonlLine = {
        kind: "system",
        ts: new Date().toISOString(),
        runId: record.runId,
        subkind: "thread_restarted",
        detail: `session ${redact(resumeSessionId)} is no longer valid — starting fresh`
      };
      await this.store.appendLines(record.threadId, [restartLine]);
      await this.store.updateSession(record.threadId, null);
      resumeSessionId = null;
      liveSessionId = null;
      result = await runOnce(null);
    }

    const linesToAppend: JsonlLine[] = [];
    const userLine: JsonlLine = {
      kind: "user",
      ts: record.startedAt,
      runId: record.runId,
      text: prompt
    };
    linesToAppend.push(userLine);

    if (result.error) {
      const errLine: JsonlLine = {
        kind: "error",
        ts: new Date().toISOString(),
        runId: record.runId,
        family: result.error.family,
        message: result.error.message
      };
      linesToAppend.push(errLine);
      await this.store.appendLines(record.threadId, linesToAppend);
      await this.store.updateMetaAfterTurn({
        threadId: record.threadId,
        addedMessages: linesToAppend.length,
        titleFromUser: meta.title === "New conversation" ? prompt : undefined,
        lastError: { family: result.error.family, message: result.error.message }
      });
      this.emit(record, {
        name: "error",
        data: {
          runId: record.runId,
          family: result.error.family,
          message: result.error.message,
          retryNotBefore: result.error.retryNotBefore,
          loginUrl: result.error.loginUrl
        }
      });
      return;
    }

    const finalSessionId = liveSessionId ?? result.sessionId ?? null;
    const finalText = result.finalText.trim();
    if (finalText) {
      const assistantLine: JsonlLine = {
        kind: "assistant",
        ts: new Date().toISOString(),
        runId: record.runId,
        text: finalText,
        sessionId: finalSessionId,
        usage: usageOrUndefined(result.usage),
        costUsd: result.costUsd ?? undefined,
        restarted: restarted ? true : undefined
      };
      linesToAppend.push(assistantLine);
    }
    await this.store.appendLines(record.threadId, linesToAppend);
    if (finalSessionId !== null) {
      await this.store.updateSession(record.threadId, finalSessionId);
    }
    await this.store.updateMetaAfterTurn({
      threadId: record.threadId,
      addedMessages: linesToAppend.length,
      titleFromUser: meta.title === "New conversation" ? prompt : undefined,
      lastError: null
    });

    this.emit(record, {
      name: "done",
      data: {
        runId: record.runId,
        sessionId: finalSessionId,
        finalText,
        durationMs: Date.now() - startedMs,
        restarted
      }
    });
  }

  private emit(record: RunRecord, evt: ChatStreamEvent): void {
    if (record.finished) return;
    record.buffered.push(evt);
    for (const sink of record.sinks) {
      try {
        sink.writeEvent(evt);
      } catch {
        // A bad sink shouldn't poison the run; the registry GC will reap it.
      }
    }
  }

  /**
   * Used by the catch path in postRun — emits an error event AND records it
   * so subsequent attaches still see it. Does not finalize the run; the
   * finally() in postRun calls finishRun().
   */
  private emitAndPersist(record: RunRecord, evt: ChatStreamEvent): void {
    this.emit(record, evt);
  }

  private finishRun(record: RunRecord): void {
    if (record.finished) return;
    record.finished = true;
    record.finishedAt = Date.now();
    for (const sink of record.sinks) sink.close();
    record.sinks.clear();
    if (this.activeByThread.get(record.threadId) === record.runId) {
      this.activeByThread.delete(record.threadId);
    }
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.scheduleGc();
  }

  private scheduleGc(): void {
    if (this.gcTimer) return;
    const timer = setTimeout(() => {
      this.gcTimer = null;
      const cutoff = Date.now() - RUN_GC_RETENTION_MS;
      for (const [id, record] of this.runs) {
        if (record.finished && record.finishedAt !== null && record.finishedAt < cutoff) {
          this.runs.delete(id);
        }
      }
      const pending = Array.from(this.runs.values()).some(
        (r) => r.finished && r.finishedAt !== null && r.finishedAt >= cutoff
      );
      if (pending) this.scheduleGc();
    }, RUN_GC_RETENTION_MS);
    timer.unref?.();
    this.gcTimer = timer;
  }
}

function usageOrUndefined(usage: AdapterUsage | null): AdapterUsage | undefined {
  if (!usage) return undefined;
  return usage;
}

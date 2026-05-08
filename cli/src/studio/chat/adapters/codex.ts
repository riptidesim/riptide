// Codex adapter.
//
// Invocation:
//   codex exec --json --skip-git-repo-check --sandbox danger-full-access
//        [--model <id>] [-c model_reasoning_effort="..."]
//        [--dangerously-bypass-approvals-and-sandbox] [resume <id> -] | -
//
// The trailing "-" tells codex to read the prompt from stdin. When
// resuming, the positional pair `resume <id>` precedes the dash.
//
// The Codex --json stream uses event objects with shapes that have
// shifted across versions. We parse defensively: we look for a
// session id under common keys, and we accumulate any string field
// that looks like assistant content. Unknown events are ignored —
// classifyError() handles failures via stdout/stderr regex.

import type {
  AdapterDelta,
  AdapterError,
  AdapterRunResult,
  AdapterStartInput,
  AdapterUsage,
  AgentAdapter
} from "../types.js";
import { runAgent } from "../spawn.js";
import { classifyError } from "./normalize.js";

const ALLOWED_FLAGS = new Set([
  "--json",
  "--skip-git-repo-check",
  "--sandbox",
  "--model",
  "-c",
  "--dangerously-bypass-approvals-and-sandbox"
]);

const VALID_MODEL_RE = /^[A-Za-z0-9._-]+$/;
const VALID_SESSION_RE = /^[A-Za-z0-9._-]+$/;

interface CodexStreamState {
  sessionId: string | null;
  assistantTexts: string[];
  usage: AdapterUsage | null;
  costUsd: number | null;
  finalText: string | null;
}

function buildArgvInternal(input: { model: string | null; resumeSessionId: string | null }): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "danger-full-access"];
  if (input.model && input.model !== "default" && VALID_MODEL_RE.test(input.model)) {
    args.push("--model", input.model);
  }
  if (input.resumeSessionId && VALID_SESSION_RE.test(input.resumeSessionId)) {
    args.push("resume", input.resumeSessionId, "-");
  } else {
    args.push("-");
  }
  return args;
}

function isAllowedToken(arg: string, idx: number): boolean {
  // Positional verbs that the adapter itself emitted.
  if (arg === "exec") return idx === 0;
  if (arg === "resume") return true;
  if (arg === "-") return true;
  if (!arg.startsWith("-")) {
    // Value tokens follow flags that take values; we can't verify here so we
    // accept and rely on the model/session regex validators above.
    return true;
  }
  return ALLOWED_FLAGS.has(arg);
}

export const codexAdapter: AgentAdapter = {
  agentId: "codex",
  capabilities: {
    supportsResume: true,
    supportsModelOverride: true,
    promptByteLimit: 64 * 1024
  },
  buildArgv(input) {
    return buildArgvInternal(input);
  },
  async startRun(input: AdapterStartInput): Promise<AdapterRunResult> {
    const args = buildArgvInternal({
      model: input.model,
      resumeSessionId: input.resumeSessionId
    });
    for (let i = 0; i < args.length; i++) {
      if (!isAllowedToken(args[i], i)) {
        return errorResult({
          family: "internal",
          message: `codex adapter produced disallowed token: ${args[i]}`
        });
      }
    }

    const state: CodexStreamState = {
      sessionId: null,
      assistantTexts: [],
      usage: null,
      costUsd: null,
      finalText: null
    };

    const result = await runAgent({
      binaryPath: input.binaryPath,
      args,
      cwd: input.cwd,
      stdin: input.prompt,
      abortSignal: input.abortSignal,
      onStdoutLine: (line) => {
        input.onLog("stdout", line);
        consumeLine(line, state, input.onDelta);
      },
      onStderrChunk: (chunk) => input.onLog("stderr", chunk)
    });

    const finalText = state.finalText ?? state.assistantTexts.join("\n\n").trim();
    const error = classifyError({
      agentId: "codex",
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
      aborted: result.aborted,
      timedOut: result.timedOut,
      parsedFinalText: finalText
    });

    return {
      sessionId: state.sessionId,
      finalText,
      usage: state.usage,
      costUsd: state.costUsd,
      exitCode: result.exitCode,
      error
    };
  }
};

function consumeLine(line: string, state: CodexStreamState, onDelta: (d: AdapterDelta) => void): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  // Session id may be at top-level or nested.
  const sessionId =
    pickString(evt, ["thread_id", "session_id", "conversation_id", "sessionId", "conversationId"]) ??
    pickStringFromAny(evt.session, ["id", "session_id"]) ??
    pickStringFromAny(evt.conversation, ["id", "conversation_id"]);
  if (sessionId && sessionId !== state.sessionId) {
    state.sessionId = sessionId;
    onDelta({ kind: "session", sessionId });
  }

  const type = pickString(evt, ["type", "event", "kind"]);
  // Assistant text deltas — Codex sometimes emits "assistant"/"message"/"output_text".
  if (type && /^(assistant|message|response|output_text|delta)$/i.test(type)) {
    const text =
      pickString(evt, ["text", "content"]) ?? pickStringFromAny(evt.message, ["content", "text"]);
    if (text) {
      state.assistantTexts.push(text);
      onDelta({ kind: "text", role: "assistant", text });
    }
  }

  // Codex 0.128+ emits completed items, including agent messages, under
  // item.completed rather than assistant/delta events.
  if (type === "item.completed") {
    const item = asObject(evt.item);
    const itemType = item ? pickString(item, ["type"]) : null;
    if (item && itemType === "agent_message") {
      const text = pickString(item, ["text", "content"]) ?? textFromContent(item.content);
      if (text) {
        state.assistantTexts.push(text);
        onDelta({ kind: "text", role: "assistant", text });
      }
    } else if (item && itemType) {
      const summary = summarizeItem(itemType, item);
      if (summary) onDelta({ kind: "tool_use", name: itemType, summary });
    }
  }

  // Final summary event — try a few common shapes.
  if (type && /^(result|done|completed|final)$/i.test(type)) {
    const final = pickString(evt, ["text", "result", "final"]);
    if (final) state.finalText = final;
  }

  // Usage may show up on a separate event or alongside the final.
  const usageObj =
    asObject(evt.usage) ??
    (type && /usage/i.test(type) ? evt : null);
  if (usageObj) {
    const usage: AdapterUsage = {
      inputTokens: asNumber(pickAny(usageObj, ["input_tokens", "prompt_tokens"])) ?? 0,
      outputTokens: asNumber(pickAny(usageObj, ["output_tokens", "completion_tokens"])) ?? 0
    };
    const cacheRead = asNumber(pickAny(usageObj, ["cache_read_input_tokens", "cache_read_tokens", "cached_input_tokens"]));
    if (cacheRead !== null) usage.cacheReadTokens = cacheRead;
    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      state.usage = usage;
      onDelta({
        kind: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens
      });
    }
  }
  const costUsd = asNumber(pickAny(evt, ["total_cost_usd", "cost_usd", "cost"]));
  if (costUsd !== null && state.costUsd === null) {
    state.costUsd = costUsd;
    onDelta({ kind: "cost", usd: costUsd });
  }
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function pickStringFromAny(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return pickString(value as Record<string, unknown>, keys);
}

function pickAny(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj) return obj[k];
  }
  return undefined;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function textFromContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const chunks: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const block = entry as Record<string, unknown>;
    const text = typeof block.text === "string" ? block.text : null;
    if (text) chunks.push(text);
  }
  return chunks.length > 0 ? chunks.join("") : null;
}

function summarizeItem(itemType: string, item: Record<string, unknown>): string {
  if (itemType === "file_change" && Array.isArray(item.changes)) {
    const changes = item.changes
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
        const change = entry as Record<string, unknown>;
        const kind = typeof change.kind === "string" ? change.kind : "change";
        const filePath = typeof change.path === "string" ? change.path : "";
        return filePath ? `${kind}: ${filePath}` : kind;
      })
      .filter(Boolean);
    return changes.slice(0, 3).join(", ");
  }
  const status = typeof item.status === "string" ? item.status : "";
  const text = pickString(item, ["text", "command", "path"]) ?? "";
  return [status, text].filter(Boolean).join(": ").slice(0, 160);
}

function errorResult(error: AdapterError): AdapterRunResult {
  return {
    sessionId: null,
    finalText: "",
    usage: null,
    costUsd: null,
    exitCode: null,
    error
  };
}

// Claude Code adapter.
//
// Invocation:
//   claude --print - --output-format stream-json --verbose
//          --dangerously-skip-permissions [--resume <id>] [--model <id>]
//
// Prompt is delivered via stdin (the `-` positional). Output is parsed
// line-by-line as the documented stream-json events: system/init,
// assistant, result.

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
  "--print",
  "--output-format",
  "--verbose",
  "--resume",
  "--model",
  "--max-turns",
  "--dangerously-skip-permissions"
]);

interface ClaudeStreamState {
  sessionId: string | null;
  model: string;
  assistantTexts: string[];
  toolUses: Array<{ name: string; summary: string }>;
  usage: AdapterUsage | null;
  costUsd: number | null;
  finalResultText: string | null;
}

const VALID_MODEL_RE = /^[A-Za-z0-9._-]+$/;

function buildArgvInternal(input: { model: string | null; resumeSessionId: string | null }): string[] {
  const args = [
    "--print",
    "-",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions"
  ];
  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  }
  if (input.model && input.model !== "default" && VALID_MODEL_RE.test(input.model)) {
    args.push("--model", input.model);
  }
  return args;
}

function isAllowedFlag(arg: string): boolean {
  if (!arg.startsWith("-")) return false;
  // The bare "-" is the stdin positional that follows --print; not a flag.
  if (arg === "-") return true;
  return ALLOWED_FLAGS.has(arg);
}

export const claudeAdapter: AgentAdapter = {
  agentId: "claude-code",
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
    // Defense-in-depth: validate every flag-shaped arg against the allow-list.
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("-") && !isAllowedFlag(a)) {
        return errorResult({
          family: "internal",
          message: `claude adapter produced disallowed flag: ${a}`
        });
      }
    }

    const state: ClaudeStreamState = {
      sessionId: null,
      model: "",
      assistantTexts: [],
      toolUses: [],
      usage: null,
      costUsd: null,
      finalResultText: null
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

    const finalText = state.finalResultText ?? state.assistantTexts.join("\n\n").trim();

    const error = classifyError({
      agentId: "claude-code",
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

function consumeLine(line: string, state: ClaudeStreamState, onDelta: (d: AdapterDelta) => void): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = asString(evt.type);
  if (type === "system" && asString(evt.subtype) === "init") {
    const id = asString(evt.session_id);
    if (id && id !== state.sessionId) {
      state.sessionId = id;
      onDelta({ kind: "session", sessionId: id });
    }
    const model = asString(evt.model);
    if (model) state.model = model;
    return;
  }
  if (type === "assistant") {
    const id = asString(evt.session_id);
    if (id && id !== state.sessionId) {
      state.sessionId = id;
      onDelta({ kind: "session", sessionId: id });
    }
    const message = asObject(evt.message);
    const content = Array.isArray(message?.content) ? message!.content : [];
    for (const entry of content) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const block = entry as Record<string, unknown>;
      const blockType = asString(block.type);
      if (blockType === "text") {
        const text = asString(block.text);
        if (text) {
          state.assistantTexts.push(text);
          onDelta({ kind: "text", role: "assistant", text });
        }
      } else if (blockType === "tool_use") {
        const name = asString(block.name) || "tool";
        const inputObj = asObject(block.input);
        const summary = inputObj ? summarizeToolInput(inputObj) : "";
        state.toolUses.push({ name, summary });
        onDelta({ kind: "tool_use", name, summary });
      }
    }
    return;
  }
  if (type === "result") {
    const id = asString(evt.session_id);
    if (id && id !== state.sessionId) {
      state.sessionId = id;
      onDelta({ kind: "session", sessionId: id });
    }
    const usageObj = asObject(evt.usage);
    if (usageObj) {
      const usage: AdapterUsage = {
        inputTokens: asNumber(usageObj.input_tokens) ?? 0,
        outputTokens: asNumber(usageObj.output_tokens) ?? 0
      };
      const cacheRead = asNumber(usageObj.cache_read_input_tokens);
      if (cacheRead !== null) usage.cacheReadTokens = cacheRead;
      const cacheCreate = asNumber(usageObj.cache_creation_input_tokens);
      if (cacheCreate !== null) usage.cacheCreationTokens = cacheCreate;
      state.usage = usage;
      onDelta({
        kind: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens
      });
    }
    const cost = asNumber(evt.total_cost_usd);
    if (cost !== null) {
      state.costUsd = cost;
      onDelta({ kind: "cost", usd: cost });
    }
    const finalText = asString(evt.result);
    if (finalText) state.finalResultText = finalText;
  }
}

function summarizeToolInput(input: Record<string, unknown>): string {
  for (const key of ["command", "path", "file_path", "query", "pattern", "url"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return `${key}: ${v.slice(0, 120)}`;
  }
  return "";
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
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

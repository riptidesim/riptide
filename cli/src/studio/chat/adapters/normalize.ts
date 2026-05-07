// Shared regex catalog + helpers for adapter error classification.
//
// Each adapter calls into these so the runner sees one canonical
// ChatErrorFamily regardless of which CLI it spawned.

import { homedir } from "node:os";

import type { AdapterError, ChatErrorFamily } from "../types.js";

const HOME = homedir();
const HOME_PREFIX_RE = new RegExp(escapeRegex(HOME), "g");

const LOGIN_RE: Record<"claude-code" | "codex", RegExp[]> = {
  "claude-code": [
    /please run [`'"]?claude login/i,
    /not\s+(?:logged|authenticated)/i,
    /login\s+required/i,
    /unauthorized/i,
    /authentication\s+required/i,
    /no\s+(?:anthropic\s+)?api\s+key/i
  ],
  codex: [
    /please run [`'"]?codex login/i,
    /codex\s+login/i,
    /sign\s+in\s+(?:to|with)/i,
    /no\s+(?:openai\s+)?api\s+key/i,
    /unauthorized/i
  ]
};

const LOGIN_URL: Record<"claude-code" | "codex", string> = {
  "claude-code": "https://claude.ai/login",
  codex: "https://platform.openai.com/login"
};

const RATE_LIMIT_RE = /(?:rate[-\s]?limit(?:ed)?|\b429\b|too\s+many\s+requests|quota|usage\s+limit\s+reached|usage\s+cap\s+reached|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached)/i;

const TRANSIENT_RE = /(?:overloaded|service\s+unavailable|\b503\b|\b529\b|upstream|gateway\s+timeout|\b504\b|connection\s+(?:reset|closed|refused|aborted)|temporarily\s+unavailable|throttl(?:ed|ing))/i;

const UNKNOWN_SESSION_RE: Record<"claude-code" | "codex", RegExp[]> = {
  "claude-code": [
    /(?:session|conversation)(?:\s+id)?\s+(?:not\s+found|unknown|invalid|does\s+not\s+exist|expired)/i,
    /unknown\s+session/i,
    /cannot\s+resume\s+(?:session|conversation)/i,
    /no\s+such\s+session/i
  ],
  codex: [
    /no\s+such\s+session/i,
    /conversation\s+.+\s+not\s+found/i,
    /(?:session|conversation)\s+(?:expired|invalid|not\s+found)/i,
    /resume\s+failed/i
  ]
};

// "resets at HH:MM (TZ)" or ISO-ish hints in stderr/stdout.
const RETRY_RESET_HHMM_RE = /resets?\s+(?:at\s+)?(\d{1,2}:\d{2}(?:\s*[ap]m)?)\s*(?:\(([^)]+)\))?/i;
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;

export function classifyError(input: {
  agentId: "claude-code" | "codex";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  aborted: boolean;
  timedOut: boolean;
  parsedFinalText: string;
}): AdapterError | null {
  const { agentId, exitCode, signal, stdoutTail, stderrTail, aborted, timedOut, parsedFinalText } = input;
  if (aborted) {
    return { family: "aborted", message: "user cancelled" };
  }
  if (timedOut) {
    return {
      family: "transient_upstream",
      message:
        "agent run hit the per-turn timeout (set RIPTIDE_STUDIO_CHAT_TIMEOUT_MS or send a follow-up — the session id was captured)",
      raw: redact(stderrTail)
    };
  }
  const haystack = `${stdoutTail}\n${stderrTail}\n${parsedFinalText}`;
  const succeededExit = exitCode === 0 && signal === null;

  // Login-required can show up even in zero-exit replies — Claude prints a
  // friendly assistant message instead of failing in some cases.
  for (const re of LOGIN_RE[agentId]) {
    if (re.test(haystack)) {
      return {
        family: "login_required",
        message: "the agent CLI is not authenticated",
        loginUrl: LOGIN_URL[agentId],
        raw: succeededExit ? undefined : redact(stderrTail)
      };
    }
  }

  if (!succeededExit) {
    if (RATE_LIMIT_RE.test(haystack)) {
      return {
        family: "rate_limited",
        message: extractFirstLine(stderrTail) || "rate limit reached",
        retryNotBefore: extractRetryHint(haystack),
        raw: redact(stderrTail)
      };
    }
    if (TRANSIENT_RE.test(haystack)) {
      return {
        family: "transient_upstream",
        message: extractFirstLine(stderrTail) || "transient upstream error",
        raw: redact(stderrTail)
      };
    }
    for (const re of UNKNOWN_SESSION_RE[agentId]) {
      if (re.test(haystack)) {
        return {
          family: "unknown_session",
          message: "the resume session id is no longer valid",
          raw: redact(stderrTail)
        };
      }
    }
    return {
      family: "nonzero_exit",
      message:
        signal !== null
          ? `agent exited with signal ${signal}`
          : `agent exited with code ${exitCode ?? -1}`,
      raw: redact(stderrTail)
    };
  }
  return null;
}

export function isUnknownSessionError(family: ChatErrorFamily): boolean {
  return family === "unknown_session";
}

export function loginUrlFor(agentId: "claude-code" | "codex"): string {
  return LOGIN_URL[agentId];
}

export function redact(text: string): string {
  if (!text) return text;
  return text.replace(HOME_PREFIX_RE, "~");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFirstLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line.slice(0, 200);
  }
  return "";
}

function extractRetryHint(haystack: string): string {
  const iso = haystack.match(ISO_TS_RE);
  if (iso) return iso[0];
  const hhmm = haystack.match(RETRY_RESET_HHMM_RE);
  if (hhmm) {
    const today = new Date();
    const parsed = parseHhmm(hhmm[1]);
    if (parsed) {
      today.setHours(parsed.hours, parsed.minutes, 0, 0);
      // If the reset HH:MM is already in the past, assume it means tomorrow.
      if (today.getTime() < Date.now()) today.setDate(today.getDate() + 1);
      return today.toISOString();
    }
  }
  return new Date(Date.now() + 60_000).toISOString();
}

function parseHhmm(value: string): { hours: number; minutes: number } | null {
  const m = value.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap]m)?$/);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const meridiem = m[3];
  if (meridiem === "am" && hours === 12) hours = 0;
  else if (meridiem === "pm" && hours < 12) hours += 12;
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

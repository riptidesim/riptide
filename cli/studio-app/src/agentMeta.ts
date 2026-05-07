// Shared metadata for the coding agents the Studio knows how to talk to.
// Used by FirstRunWizard, SettingsPage, and HandoffPage so model lists,
// labels, and icons stay in sync.

import type { ChatAgentId } from "./api";
import type { IconName } from "./ui/Icon";

export interface AgentPreference {
  agentId: string;
  model: string;
}

const DEFAULT_MODEL: Record<ChatAgentId, string> = {
  "claude-code": "claude-opus-4-7",
  codex: "gpt-5"
};

export const AGENT_TAGLINE: Record<string, string> = {
  "claude-code": "Local Claude agent",
  codex: "Local Codex agent",
  gemini: "Local Gemini agent",
  cursor: "Local Cursor agent",
  opencode: "Local multi-provider agent"
};

export const AGENT_ICON: Record<string, IconName> = {
  "claude-code": "sparkles",
  codex: "code",
  gemini: "gem",
  cursor: "cursorArrow",
  opencode: "terminalSquare"
};

export const MODEL_OPTIONS: Record<string, string[]> = {
  "claude-code": [
    "claude-opus-4-7",
    "claude-haiku-4.5",
    "claude-haiku-4.6",
    "claude-opus-4.6",
    "default",
    "claude-sonnet-4.5",
    "claude-sonnet-4.6"
  ],
  codex: [
    "gpt-5",
    "default",
    "codex-mini",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "o3",
    "o3-mini",
    "o4-mini"
  ],
  gemini: [
    "default",
    "auto",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro"
  ],
  cursor: [
    "default",
    "auto",
    "composer-1",
    "composer-1.5",
    "gemini-3-flash",
    "gemini-3-pro",
    "gemini-3.1-pro",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-max-high",
    "gpt-5.1-codex-mini",
    "gpt-5.1-high",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.2-codex-fast",
    "gpt-5.2-codex-high",
    "gpt-5.2-codex-high-fast"
  ],
  opencode: [
    "default",
    "gpt-5-codex",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "big-pickle",
    "gpt-5-nano",
    "hy3-preview-free",
    "minimax-m2.5-free",
    "nemotron-3-super-free"
  ]
};

export const MODEL_LABEL: Record<string, string> = {
  default: "Default",
  auto: "Auto",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "claude-haiku-4.6": "Claude Haiku 4.6",
  "claude-opus-4.6": "Claude Opus 4.6",
  "claude-opus-4.7": "Claude Opus 4.7",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-sonnet-4.6": "Claude Sonnet 4.6",
  "codex-mini": "Codex Mini",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  "gemini-2.0-flash-lite": "Gemini 2.0 Flash Lite",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
  "gemini-2.5-pro": "Gemini 2.5 Pro"
};

export function modelOptionsFor(agentId: string): string[] {
  return MODEL_OPTIONS[agentId] ?? ["default"];
}

export function defaultModelFor(agentId: string): string {
  return DEFAULT_MODEL[agentId as ChatAgentId] ?? "default";
}

export function labelForModel(agentIdOrModel: string, maybeModel?: string): string {
  const model = maybeModel ?? agentIdOrModel;
  return MODEL_LABEL[model] ?? model;
}

// Adapter registry. v1 wires Claude Code + Codex; other agents
// (gemini, cursor, opencode) are intentionally absent until they
// have stream parsers — callers should treat null as "agent
// supported by Studio in the future, not now".

import type { AgentAdapter, AgentId } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";

const REGISTRY: Record<AgentId, AgentAdapter> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter
};

export function getAdapter(agentId: string): AgentAdapter | null {
  return (REGISTRY as Record<string, AgentAdapter | undefined>)[agentId] ?? null;
}

export function isSupportedAgentId(agentId: string): agentId is AgentId {
  return agentId === "claude-code" || agentId === "codex";
}

// Persists the user's chosen coding agent + model to localStorage,
// scoped per workspace path so different projects can prefer different
// agents independently. The hook returns the current effective preference
// (stored selection if present, otherwise an in-memory probe-based
// fallback) and a setter that writes through to localStorage.
//
// Only explicit user choices are persisted — never the fallback. That
// keeps the storage key empty until the user clicks "Use" or changes
// the model, so a stale "default" entry can't outvote a newer choice
// during the brief window where workspaces haven't loaded yet.

import { useCallback, useEffect, useState } from "react";

import { defaultModelFor, type AgentPreference } from "./agentMeta";
import type { AgentProbe } from "./api";

const STORAGE_NS = "riptide-studio:agent";
const LEGACY_STORAGE_NS = "riptide-studio:agent-pref";

function storageKey(workspacePath: string): string {
  return `${STORAGE_NS}:${workspacePath}`;
}

function readFromStorage(workspacePath: string): AgentPreference | null {
  if (!workspacePath) return null;
  try {
    const raw = localStorage.getItem(storageKey(workspacePath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AgentPreference>;
    if (typeof parsed.agentId !== "string" || typeof parsed.model !== "string") return null;
    return { agentId: parsed.agentId, model: parsed.model };
  } catch {
    return null;
  }
}

function writeToStorage(workspacePath: string, pref: AgentPreference): void {
  if (!workspacePath) return;
  try {
    localStorage.setItem(storageKey(workspacePath), JSON.stringify(pref));
  } catch {
    // Storage may be unavailable (private mode, quota). Preference simply
    // won't survive a refresh; in-memory state still works for this session.
  }
}

function pickDefault(agents: AgentProbe[]): AgentPreference | null {
  const detectedRecommended = agents.find((a) => a.detected && a.recommended);
  if (!detectedRecommended) return null;
  return { agentId: detectedRecommended.id, model: defaultModelFor(detectedRecommended.id) };
}

export interface UseAgentPreferenceResult {
  pref: AgentPreference | null;
  setPref: (next: AgentPreference) => void;
}

export function useAgentPreference(workspacePath: string, agents: AgentProbe[]): UseAgentPreferenceResult {
  // Stored = exactly what's in localStorage for this workspace, nothing more.
  const [stored, setStored] = useState<AgentPreference | null>(() => readFromStorage(workspacePath));

  // One-time cleanup: an earlier version of this hook could write a default
  // pref to the empty-string key before workspaces had loaded. That stale
  // entry doesn't get read by the new code, but evict it on first load so
  // it doesn't sit around forever.
  useEffect(() => {
    try {
      localStorage.removeItem(`${STORAGE_NS}:`);
      localStorage.removeItem(`${LEGACY_STORAGE_NS}:`);
    } catch {}
  }, []);

  // Re-read whenever the workspace identity changes (incl. "" → real path
  // once /api/studio/workspaces resolves).
  useEffect(() => {
    setStored(readFromStorage(workspacePath));
  }, [workspacePath]);

  // Effective preference = stored ?? probe-based fallback. The fallback is
  // computed inline and never persisted, so it can't shadow a real choice.
  const pref = stored ?? pickDefault(agents);

  const setPref = useCallback((next: AgentPreference) => {
    writeToStorage(workspacePath, next);
    setStored(next);
  }, [workspacePath]);

  return { pref, setPref };
}

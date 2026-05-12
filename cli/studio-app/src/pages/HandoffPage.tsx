import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

import {
  api,
  chatApi,
  type AgentProbe,
  type ChatAgentId,
  type ChatJsonlLine,
  type ChatThreadSummary
} from "../api";
import type { StudioWorkspaceChange } from "../studioTypes";

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text: string): string {
  if (!text) return "";
  try {
    const out = marked.parse(text, { async: false });
    return typeof out === "string" ? out : "";
  } catch {
    // Fall back to escaped plain text so we never break the page on malformed
    // markdown — the agent occasionally streams partial fences mid-token.
    return escapeHtml(text);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
import { labelForModel, modelOptionsFor, type AgentPreference } from "../agentMeta";
import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel } from "../ui/primitives";

const PRESETS: { label: string; prompt: string }[] = [
  {
    label: "Configure my project",
    prompt: "Use the riptide-config skill to configure this repo for Riptide end to end. If this session says the skill is unavailable, do not proceed from memory; read and follow the first existing local instructions file at .claude/skills/riptide-config/SKILL.md, .codex/skills/riptide-config/SKILL.md, ~/.codex/skills/riptide-config/SKILL.md, or ~/.claude/skills/riptide-config/SKILL.md. Detect the target program, repair or create the adapter, harness, starter scenarios, personas, and invariants, run the smallest smoke needed to prove the scaffold works, then add or validate a broad campaign plan with many agents, multiple personas, and multiple seeds. Do not stop at a 2-agent toy scenario unless the repo cannot support more; report campaign readiness with exact validation commands."
  },
  {
    label: "Add a campaign",
    prompt: "Add a broad Riptide campaign for this workspace. Inspect the existing adapter, scenarios, personas, and invariants; create or update the campaign TOML with a large multi-seed, multi-persona, high-agent stress matrix instead of a 2-agent smoke; validate the campaign plan and run a meaningful representative slice only when full execution would be too slow; then report changed files plus exact run and review commands."
  },
  {
    label: "Analyze a report",
    prompt: "Analyze the latest Riptide report in this workspace without editing files. Identify the scenario, failing seeds, invariant fires, root-cause evidence, and the next concrete adapter, harness, scenario, or protocol changes to make."
  },
  {
    label: "Tighten an invariant",
    prompt: "Tighten an existing invariant for this workspace. Inspect the adapter observations and recent report evidence, propose the smallest stronger invariant, apply it if safe, then run lint and a targeted smoke to prove it still evaluates."
  }
];

const SUPPORTED_AGENTS = new Set<string>(["claude-code", "codex"]);

interface HandoffPageProps {
  pref: AgentPreference | null;
  setPref: (next: AgentPreference) => void;
  agents: AgentProbe[];
  workspaceId: string;
  workspacePath: string;
}

interface RunState {
  runId: string;
  threadId: string;
  status: "streaming" | "aborting";
  source: EventSource;
  startedAt: number;
}

interface ToolEvent {
  name: string;
  summary: string;
  ts: number;
}

export function HandoffPage({ pref, setPref, agents, workspaceId, workspacePath }: HandoffPageProps) {
  const [draft, setDraft] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatJsonlLine[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingTools, setStreamingTools] = useState<ToolEvent[]>([]);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [transientNotice, setTransientNotice] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [changes, setChanges] = useState<StudioWorkspaceChange[]>([]);
  const [changesLoading, setChangesLoading] = useState(true);
  const [changesRefreshing, setChangesRefreshing] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [changesWarnings, setChangesWarnings] = useState<string[]>([]);
  const [changesGitReady, setChangesGitReady] = useState(true);

  const activeAgent = agents.find((a) => a.id === pref?.agentId) ?? null;
  const agentLabel = activeAgent?.label ?? "agent";
  const currentModel = pref?.model ?? "default";
  const modelChoices = pref ? modelOptionsFor(pref.agentId) : ["default"];
  const supported = !!pref && SUPPORTED_AGENTS.has(pref.agentId);
  const deleteConfirmThread = deleteConfirmId
    ? threads.find((t) => t.id === deleteConfirmId) ?? null
    : null;

  const modelWrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const refreshThreads = useCallback(async () => {
    try {
      const r = await chatApi.listThreads(workspaceId);
      setThreads(r.threads);
    } catch {
      // Surface in-place; nothing to render if the server isn't ready yet.
    }
  }, [workspaceId]);

  const refreshChanges = useCallback(async (opts: { quiet?: boolean; threadId?: string | null } = {}) => {
    const targetThreadId = opts.threadId ?? threadId;
    if (!targetThreadId) {
      setChanges([]);
      setChangesWarnings([]);
      setChangesGitReady(true);
      setChangesError(null);
      setChangesLoading(false);
      setChangesRefreshing(false);
      return;
    }
    if (!opts.quiet) setChangesLoading(true);
    setChangesRefreshing(true);
    try {
      const res = await api.changes({ workspaceId, threadId: targetThreadId });
      setChanges(res.changes);
      setChangesWarnings(res.warnings);
      setChangesGitReady(res.is_git_workspace);
      setChangesError(null);
    } catch (err) {
      setChangesError((err as Error).message);
    } finally {
      if (!opts.quiet) setChangesLoading(false);
      setChangesRefreshing(false);
    }
  }, [threadId, workspaceId]);

  // Initial thread list fetch + whenever the workspace identity changes.
  useEffect(() => {
    refreshThreads();
  }, [refreshThreads, workspacePath]);

  useEffect(() => {
    void refreshChanges();
  }, [refreshChanges, workspacePath, threadId]);

  useEffect(() => {
    if (runState?.source) runState.source.close();
    setThreadId(null);
    setMessages([]);
    setStreamingText("");
    setStreamingTools([]);
    setRunState(null);
    setTransientNotice(null);
    setDeleteConfirmId(null);
    setDeleteError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Scroll-to-bottom on new content.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  // Close model dropdown on outside click / Escape.
  useEffect(() => {
    if (!modelOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!modelWrapRef.current) return;
      if (!modelWrapRef.current.contains(e.target as Node)) setModelOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setModelOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [modelOpen]);

  useEffect(() => {
    if (!deleteConfirmId || deletingThreadId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setDeleteConfirmId(null);
      setDeleteError(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [deleteConfirmId, deletingThreadId]);

  // Tear down any open EventSource on unmount.
  useEffect(() => {
    return () => {
      if (runState?.source) runState.source.close();
    };
    // We intentionally only run on unmount; runState changes are handled inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick elapsed time during an active run so the user has a heartbeat.
  useEffect(() => {
    if (!runState) {
      setElapsedMs(0);
      return;
    }
    const start = runState.startedAt;
    const id = setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => clearInterval(id);
  }, [runState]);

  useEffect(() => {
    if (!runState) return;
    const id = window.setInterval(() => void refreshChanges({ quiet: true, threadId: runState.threadId }), 2500);
    return () => window.clearInterval(id);
  }, [refreshChanges, runState]);

  function onFilesChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    setAttachments((prev) => [...prev, ...Array.from(list)]);
    e.target.value = "";
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  async function loadThread(id: string) {
    try {
      const r = await chatApi.getThread(id, workspaceId);
      setThreadId(r.thread.id);
      setMessages(r.messages);
      setStreamingText("");
      setTransientNotice(null);
    } catch {
      // Thread vanished or server hiccup — drop back to fresh.
      setThreadId(null);
      setMessages([]);
    }
  }

  function newConversation() {
    if (runState) return;
    setThreadId(null);
    setMessages([]);
    setStreamingText("");
    setTransientNotice(null);
    textareaRef.current?.focus();
  }

  function requestDeleteThread(id: string) {
    setDeleteConfirmId(id);
    setDeleteError(null);
    setModelOpen(false);
  }

  function closeDeleteThreadDialog() {
    if (deletingThreadId) return;
    setDeleteConfirmId(null);
    setDeleteError(null);
  }

  async function confirmDeleteThread() {
    const id = deleteConfirmId;
    if (!id || deletingThreadId) return;
    setDeletingThreadId(id);
    setDeleteError(null);
    try {
      await chatApi.deleteThread(id, workspaceId);
      if (threadId === id) {
        if (runState) {
          runState.source.close();
          setRunState(null);
          setElapsedMs(0);
        }
        setThreadId(null);
        setMessages([]);
        setStreamingText("");
        setStreamingTools([]);
        setTransientNotice(null);
      }
      await refreshThreads();
      setDeleteConfirmId(null);
    } catch (err) {
      setDeleteError(`Could not delete this thread: ${(err as Error).message}`);
    } finally {
      setDeletingThreadId(null);
    }
  }

  function attachStream(runId: string, streamUrl: string, activeThreadId: string): EventSource {
    const source = new EventSource(streamUrl);
    let acc = "";
    source.addEventListener("meta", () => {
      // The server has accepted the run and is about to spawn — flip the
      // bubble from "starting…" to "thinking…" so the user sees movement
      // even while the agent is silent during init.
      setStreamingText("");
    });
    source.addEventListener("delta", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { text?: string };
        if (typeof data.text === "string") {
          acc += data.text;
          setStreamingText(acc);
        }
      } catch {
        // ignore malformed event
      }
    });
    source.addEventListener("tool", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { name?: string; summary?: string };
        setStreamingTools((prev) => [
          ...prev,
          { name: data.name ?? "tool", summary: data.summary ?? "", ts: Date.now() }
        ]);
      } catch {
        // ignore malformed event
      }
    });
    source.addEventListener("done", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { restarted?: boolean };
        if (data.restarted) {
          setTransientNotice("Conversation restarted — previous session expired.");
        }
      } catch {
        // ignore
      }
      source.close();
      setStreamingText("");
      setStreamingTools([]);
      setRunState(null);
      void refreshChanges({ quiet: true, threadId: activeThreadId });
      // Refetch canonical history so we see the persisted assistant line.
      if (activeThreadId) loadThread(activeThreadId);
      refreshThreads();
    });
    source.addEventListener("error", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data ?? "{}") as {
          family?: string;
          message?: string;
          loginUrl?: string;
        };
        if (data.family === "login_required" && data.loginUrl) {
          setTransientNotice(
            `Agent is not logged in. Authenticate at ${data.loginUrl}, then send your message again.`
          );
        } else if (data.family === "rate_limited") {
          setTransientNotice("Agent is rate limited. Try again in a minute.");
        } else if (data.family === "aborted") {
          setTransientNotice("Run cancelled.");
        } else if (data.message) {
          setTransientNotice(`Agent error: ${data.message}`);
        }
      } catch {
        setTransientNotice("Stream closed unexpectedly.");
      }
      source.close();
      setStreamingText("");
      setStreamingTools([]);
      setRunState(null);
      void refreshChanges({ quiet: true, threadId: activeThreadId });
      if (activeThreadId) loadThread(activeThreadId);
      refreshThreads();
    });
    void runId;
    return source;
  }

  async function submit() {
    if (!supported || runState) return;
    const prompt = draft.trim();
    if (!prompt || !pref) return;
    if (attachments.length > 0) {
      // Visual UI is preserved but uploads aren't wired in v1.
      console.warn("[studio chat] attachments are not uploaded in v1; dropping", attachments);
    }
    setTransientNotice(null);

    let activeThreadId = threadId;
    try {
      if (!activeThreadId) {
        const created = await chatApi.createThread({
          agentId: pref.agentId as ChatAgentId,
          model: pref.model,
          workspaceId
        });
        activeThreadId = created.thread.id;
        setThreadId(activeThreadId);
        setThreads((prev) => [created.thread, ...prev.filter((t) => t.id !== created.thread.id)]);
      }
    } catch (err) {
      setTransientNotice(`Could not start a thread: ${(err as Error).message}`);
      return;
    }

    const optimistic: ChatJsonlLine = {
      kind: "user",
      ts: new Date().toISOString(),
      runId: "pending",
      text: prompt
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");
    setStreamingText("");
    setStreamingTools([]);

    let runId = "";
    let streamUrl = "";
    try {
      const out = await chatApi.postRun(activeThreadId, { prompt, workspaceId });
      runId = out.runId;
      streamUrl = out.streamUrl;
    } catch (err) {
      setTransientNotice(`Could not start the run: ${(err as Error).message}`);
      return;
    }
    const source = attachStream(runId, streamUrl, activeThreadId);
    setRunState({ runId, threadId: activeThreadId, status: "streaming", source, startedAt: Date.now() });
  }

  async function abort() {
    if (!runState) return;
    setRunState((r) => (r ? { ...r, status: "aborting" } : r));
    try {
      await chatApi.abortRun(runState.runId);
    } catch {
      // ignore — the SSE error event will land regardless.
    }
  }

  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter") return;
    // Skip if the IME is composing (Japanese/Chinese/etc), otherwise we'd
    // submit mid-character.
    if (e.nativeEvent.isComposing) return;
    if (e.shiftKey) {
      // Shift+Enter inserts a newline — let the textarea handle it.
      return;
    }
    e.preventDefault();
    submit();
  }

  const renderedMessages = useMemo(() => {
    const out: JSX.Element[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      out.push(<MessageBubble key={`${m.runId}-${i}`} msg={m} />);
    }
    return out;
  }, [messages]);

  return (
    <div>
      <PageLabel>AGENT CHAT</PageLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "240px 1fr 280px",
          gap: 0,
          height: "calc(100vh - 110px)",
          background: "var(--rt-slate-panel)",
          border: "1px solid var(--rt-slate-line)",
          borderRadius: 12,
          overflow: "hidden"
        }}
      >
        {/* Thread list */}
        <div style={{ borderRight: "1px solid var(--rt-slate-line)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 14, borderBottom: "1px solid var(--rt-slate-line)" }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={newConversation}
              disabled={runState !== null}
            >
              <Icon name="plus" size={13} /> New conversation
            </button>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {threads.length === 0 ? (
              <div
                style={{
                  padding: 18,
                  font: "400 12px/1.5 Inter",
                  color: "var(--rt-fog-dim)",
                  textAlign: "center"
                }}
              >
                No conversations yet.
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 6 }}>
                {threads.map((t) => {
                  const active = t.id === threadId;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => loadThread(t.id)}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 10px",
                          marginBottom: 2,
                          borderRadius: 6,
                          border: "none",
                          background: active ? "var(--rt-slate-3)" : "transparent",
                          color: active ? "var(--rt-off-white)" : "var(--rt-fog)",
                          font: "400 12.5px Inter",
                          cursor: "pointer"
                        }}
                      >
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t.title}
                        </div>
                        <div
                          style={{
                            font: "400 11px Inter",
                            color: "var(--rt-fog-dim)",
                            marginTop: 2,
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 8
                          }}
                        >
                          <span>
                            {t.agentId} · {labelForModel(t.model)}
                          </span>
                          <span>{t.messageCount} msg</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Chat center */}
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, height: "100%" }}>
          <div
            ref={transcriptRef}
            style={{
              flex: "1 1 0",
              minHeight: 0,
              overflowY: "auto",
              padding: 24
            }}
          >
            {messages.length === 0 && !streamingText && !runState ? (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                <EmptyState
                  iconImage="assets/logo-icon.png"
                  title="Hand off to your coding agent"
                  body="Describe a change in plain English — a new persona, an invariant tweak, an adapter wire-up — and Studio briefs your coding agent to apply it in the repo."
                />
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {renderedMessages}
                {runState && (
                  <RunActivity
                    runState={runState}
                    streamingText={streamingText}
                    tools={streamingTools}
                    elapsedMs={elapsedMs}
                  />
                )}
                {transientNotice && (
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: "var(--rt-slate-2)",
                      border: "1px solid var(--rt-slate-line)",
                      color: "var(--rt-fog)",
                      font: "400 12px Inter"
                    }}
                  >
                    {transientNotice}
                  </div>
                )}
              </div>
            )}
          </div>
          <div style={{ padding: "14px 18px 18px", borderTop: "1px solid var(--rt-slate-line)" }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setDraft(p.prompt)}
                  className="handoff-preset"
                  disabled={runState !== null}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div
              style={{
                background: "var(--rt-slate-2)",
                border: "1px solid var(--rt-slate-line)",
                borderRadius: 14,
                padding: "14px 16px 12px",
                transition: "border-color 120ms"
              }}
            >
              {attachments.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                  {attachments.map((f, i) => (
                    <span key={`${f.name}-${i}`} className="handoff-attach">
                      <Icon name="paperclip" size={11} color="var(--rt-fog-dim)" />
                      <span className="handoff-attach__name">{f.name}</span>
                      <button
                        type="button"
                        className="handoff-attach__rm"
                        title="Remove"
                        onClick={() => removeAttachment(i)}
                      >
                        <Icon name="x" size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                placeholder={
                  supported
                    ? "Message your agent — Enter to send, Shift+Enter for newline"
                    : `${agentLabel} chat is coming in Studio v2 — pick Claude Code or Codex.`
                }
                rows={3}
                className="textarea"
                style={{
                  background: "transparent",
                  border: "none",
                  resize: "none",
                  padding: 0,
                  width: "100%",
                  color: "var(--rt-off-white)",
                  font: "400 14px/1.5 Inter",
                  outline: "none",
                  minHeight: 66,
                  maxHeight: 150,
                  overflowY: "auto"
                }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleTextareaKeyDown}
                disabled={!supported || runState !== null}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={onFilesChosen}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
                <button
                  type="button"
                  title="Attach file"
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 28, height: 28, borderRadius: 999,
                    background: "transparent", border: "none",
                    color: "var(--rt-fog-dim)", cursor: "pointer"
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--rt-off-white)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--rt-fog-dim)"; }}
                >
                  <Icon name="paperclip" size={16} />
                </button>
                <div style={{ flex: 1 }} />
                <div ref={modelWrapRef} style={{ position: "relative" }}>
                  <button
                    type="button"
                    title="Change model"
                    onClick={() => setModelOpen((v) => !v)}
                    aria-haspopup="listbox"
                    aria-expanded={modelOpen}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      background: modelOpen ? "var(--rt-slate-3)" : "transparent",
                      border: "1px solid",
                      borderColor: modelOpen ? "var(--rt-slate-strong)" : "transparent",
                      padding: "4px 8px",
                      color: "var(--rt-fog)", cursor: "pointer",
                      font: "400 12.5px Inter", borderRadius: 6
                    }}
                  >
                    <span style={{ color: "var(--rt-off-white)" }}>{agentLabel}</span>
                    <span style={{ color: "var(--rt-fog-dim)" }}>{labelForModel(currentModel)}</span>
                    <Icon name="chevronDown" size={11} color="var(--rt-fog-dim)" />
                  </button>
                  {modelOpen && pref && (
                    <ul role="listbox" aria-label="Model" className="handoff-model-menu">
                      {agents.map((a) => (
                        <li key={`agent-${a.id}`}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={a.id === pref.agentId}
                            className={`handoff-model-opt${a.id === pref.agentId ? " is-active" : ""}`}
                            disabled={!SUPPORTED_AGENTS.has(a.id)}
                            title={SUPPORTED_AGENTS.has(a.id) ? undefined : "Available in Studio v2"}
                            style={SUPPORTED_AGENTS.has(a.id) ? undefined : { opacity: 0.5, cursor: "not-allowed" }}
                            onClick={() => {
                              if (!SUPPORTED_AGENTS.has(a.id)) return;
                              setPref({ agentId: a.id, model: "default" });
                              setModelOpen(false);
                            }}
                          >
                            <span className="handoff-model-opt__name">{a.label}</span>
                            {a.id === pref.agentId && <Icon name="check" size={12} color="var(--rt-teal)" />}
                          </button>
                        </li>
                      ))}
                      {modelChoices.length > 0 && (
                        <li
                          style={{
                            borderTop: "1px solid var(--rt-slate-line)",
                            margin: "4px 0",
                            padding: "4px 8px 0",
                            color: "var(--rt-fog-dim)",
                            font: "500 11px Inter",
                            textTransform: "uppercase",
                            letterSpacing: 0.5
                          }}
                        >
                          Model
                        </li>
                      )}
                      {modelChoices.map((m) => {
                        const active = m === currentModel;
                        return (
                          <li key={m}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={active}
                              className={`handoff-model-opt${active ? " is-active" : ""}`}
                              onClick={() => {
                                setPref({ agentId: pref.agentId, model: m });
                                setModelOpen(false);
                              }}
                            >
                              <span className="handoff-model-opt__name">{labelForModel(m)}</span>
                              {active && <Icon name="check" size={12} color="var(--rt-teal)" />}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                {runState ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={abort}
                    disabled={runState.status === "aborting"}
                  >
                    {runState.status === "aborting" ? "Stopping…" : "Stop"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    onClick={submit}
                    disabled={!supported || draft.trim().length === 0}
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Workspace changes */}
        <WorkspaceChangesPanel
          changes={changes}
          loading={changesLoading}
          refreshing={changesRefreshing}
          error={changesError}
          warnings={changesWarnings}
          gitReady={changesGitReady}
          hasThread={threadId !== null}
          onRefresh={() => void refreshChanges()}
        />
      </div>

      {threadId && (
        <DeleteThreadInline id={threadId} onRequestDelete={requestDeleteThread} />
      )}

      {deleteConfirmId && (
        <DeleteThreadConfirmDialog
          thread={deleteConfirmThread}
          busy={deletingThreadId === deleteConfirmId}
          error={deleteError}
          onCancel={closeDeleteThreadDialog}
          onConfirm={confirmDeleteThread}
        />
      )}
    </div>
  );
}

function WorkspaceChangesPanel({
  changes,
  loading,
  refreshing,
  error,
  warnings,
  gitReady,
  hasThread,
  onRefresh
}: {
  changes: StudioWorkspaceChange[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  warnings: string[];
  gitReady: boolean;
  hasThread: boolean;
  onRefresh: () => void;
}) {
  return (
    <div style={{ borderLeft: "1px solid var(--rt-slate-line)", display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, height: "100%" }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--rt-slate-line)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <Kicker>WORKSPACE CHANGES</Kicker>
            <div style={{ font: "500 13px Inter", color: "var(--rt-fog-dim)", marginTop: 6 }}>
              {changes.length} {changes.length === 1 ? "file" : "files"}
            </div>
          </div>
          <button
            type="button"
            className="side__icon-btn"
            title="Refresh workspace changes"
            aria-label="Refresh workspace changes"
            onClick={onRefresh}
            disabled={refreshing || !hasThread}
          >
            <Icon name="refresh" size={12} />
          </button>
        </div>
      </div>
      <div style={{ flex: "1 1 0", minHeight: 0, overflowY: "auto", padding: 10 }}>
        {!hasThread ? (
          <WorkspaceChangesEmpty icon="chat" body="Start or select a conversation to track its file changes." />
        ) : loading && changes.length === 0 ? (
          <WorkspaceChangesEmpty icon="refresh" body="Reading git status..." />
        ) : error ? (
          <WorkspaceChangesEmpty icon="plug" body={error} />
        ) : !gitReady ? (
          <WorkspaceChangesEmpty icon="branch" body={warnings[0] ?? "Workspace changes need a git repository."} />
        ) : changes.length === 0 ? (
          <WorkspaceChangesEmpty icon="check" body="No file changes from this conversation yet." />
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {warnings.map((warning) => (
              <div
                key={warning}
                style={{
                  border: "1px solid rgba(245,158,11,0.35)",
                  background: "rgba(245,158,11,0.08)",
                  borderRadius: 6,
                  padding: "8px 10px",
                  color: "var(--rt-warn)",
                  font: '400 11px/1.45 "IBM Plex Mono"'
                }}
              >
                {warning}
              </div>
            ))}
            {changes.map((change) => (
              <WorkspaceChangeRow key={`${change.index_status}${change.worktree_status}:${change.path}:${change.old_path ?? ""}`} change={change} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkspaceChangesEmpty({ icon, body }: { icon: "branch" | "chat" | "check" | "plug" | "refresh"; body: string }) {
  return (
    <div
      style={{
        height: "100%",
        minHeight: 180,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 10,
        padding: 18,
        font: "400 12px/1.5 Inter",
        color: "var(--rt-fog-dim)",
        textAlign: "center"
      }}
    >
      <Icon name={icon} size={16} />
      <span>{body}</span>
    </div>
  );
}

function WorkspaceChangeRow({ change }: { change: StudioWorkspaceChange }) {
  const meta = change.old_path ? `${change.old_path} -> ${change.path}` : change.path;
  return (
    <div
      title={meta}
      style={{
        border: "1px solid var(--rt-slate-line)",
        background: "var(--rt-slate-2)",
        borderRadius: 7,
        padding: "9px 10px",
        display: "grid",
        gap: 6
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            width: 28,
            flex: "0 0 auto",
            textAlign: "center",
            borderRadius: 5,
            padding: "2px 0",
            background: changeStatusBackground(change.status),
            color: changeStatusColor(change.status),
            font: '600 10px "IBM Plex Mono"'
          }}
        >
          {changeStatusLabel(change.status)}
        </span>
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--rt-off-white)",
            font: '500 12px "IBM Plex Mono"'
          }}
        >
          {change.path}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--rt-fog-dim)", font: '400 10.5px "IBM Plex Mono"' }}>
        {change.staged && <span>staged</span>}
        {change.unstaged && <span>{change.status === "untracked" ? "new" : "unstaged"}</span>}
        {change.old_path && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>from {change.old_path}</span>}
      </div>
    </div>
  );
}

function changeStatusLabel(status: StudioWorkspaceChange["status"]): string {
  switch (status) {
    case "modified": return "MOD";
    case "added": return "ADD";
    case "deleted": return "DEL";
    case "renamed": return "REN";
    case "copied": return "CPY";
    case "untracked": return "NEW";
    case "conflicted": return "CON";
    case "typechange": return "TYP";
    default: return "CHG";
  }
}

function changeStatusColor(status: StudioWorkspaceChange["status"]): string {
  switch (status) {
    case "added":
    case "untracked":
      return "var(--rt-pass)";
    case "deleted":
    case "conflicted":
      return "var(--rt-fail)";
    case "renamed":
    case "copied":
      return "var(--rt-teal)";
    default:
      return "var(--rt-warn)";
  }
}

function changeStatusBackground(status: StudioWorkspaceChange["status"]): string {
  switch (status) {
    case "added":
    case "untracked":
      return "rgba(34,197,94,0.12)";
    case "deleted":
    case "conflicted":
      return "rgba(239,68,68,0.12)";
    case "renamed":
    case "copied":
      return "rgba(20,184,182,0.12)";
    default:
      return "rgba(245,158,11,0.12)";
  }
}

function DeleteThreadInline({
  id,
  onRequestDelete
}: {
  id: string;
  onRequestDelete: (id: string) => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        right: 18,
        bottom: 14,
        display: "flex",
        gap: 8,
        zIndex: 10
      }}
    >
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => onRequestDelete(id)}
        title="Delete this conversation"
      >
        <Icon name="x" size={12} /> Delete thread
      </button>
    </div>
  );
}

function DeleteThreadConfirmDialog({
  thread,
  busy,
  error,
  onCancel,
  onConfirm
}: {
  thread: ChatThreadSummary | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const title = thread?.title ?? "this conversation";
  return (
    <div className="scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onCancel();
    }}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-thread-title"
        style={{ maxWidth: 460 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "18px 20px", borderBottom: "1px solid var(--rt-slate-line)" }}>
          <Kicker style={{ marginBottom: 6, color: "var(--rt-fail)" }}>DELETE THREAD</Kicker>
          <div id="delete-thread-title" style={{ font: "600 16px Inter", color: "var(--rt-off-white)" }}>
            Delete this thread?
          </div>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ font: "500 13px/1.5 Inter", color: "var(--rt-off-white)", marginBottom: 8 }}>
            {title}
          </div>
          <div style={{ font: "400 12.5px/1.55 Inter", color: "var(--rt-fog)" }}>
            This removes the conversation transcript from Studio and stops any active run on the thread. This cannot be undone.
          </div>
          {error && (
            <div
              style={{
                marginTop: 14,
                padding: "9px 11px",
                borderRadius: 6,
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.28)",
                color: "var(--rt-fail)",
                font: '400 12px/1.45 "IBM Plex Mono"'
              }}
            >
              {error}
            </div>
          )}
        </div>
        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid var(--rt-slate-line)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8
          }}
        >
          <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={onConfirm}
            disabled={busy}
            style={{
              background: "var(--rt-fail)",
              borderColor: "rgba(239,68,68,0.65)",
              color: "#1F0505"
            }}
          >
            <Icon name="x" size={12} />
            {busy ? "Deleting..." : "Delete thread"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunActivity({
  runState,
  streamingText,
  tools,
  elapsedMs
}: {
  runState: RunState;
  streamingText: string;
  tools: ToolEvent[];
  elapsedMs: number;
}) {
  const elapsedLabel = formatElapsed(elapsedMs);
  const status =
    runState.status === "aborting"
      ? "Stopping…"
      : streamingText.length > 0
        ? "Streaming"
        : tools.length > 0
          ? `Working — last action: ${tools[tools.length - 1].name}`
          : "Thinking";
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          font: "500 11px Inter",
          color: "var(--rt-fog-dim)",
          marginBottom: 6,
          textTransform: "uppercase",
          letterSpacing: 0.5
        }}
      >
        <ActivityDot />
        <span style={{ color: "var(--rt-off-white)" }}>Assistant</span>
        <span>· {status}</span>
        <span style={{ marginLeft: "auto", color: "var(--rt-fog-dim)" }}>{elapsedLabel}</span>
      </div>
      {tools.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: "0 0 10px 0",
            padding: "8px 12px",
            background: "var(--rt-slate-2)",
            border: "1px solid var(--rt-slate-line)",
            borderRadius: 8,
            font: "400 12px/1.5 Inter",
            color: "var(--rt-fog)"
          }}
        >
          {tools.slice(-6).map((t, i) => (
            <li key={`${t.ts}-${i}`} style={{ display: "flex", gap: 8 }}>
              <span style={{ color: "var(--rt-teal)", minWidth: 60 }}>{t.name}</span>
              <span
                style={{
                  color: "var(--rt-fog-dim)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis"
                }}
              >
                {t.summary}
              </span>
            </li>
          ))}
        </ul>
      )}
      {streamingText && (
        <div
          className="chat-md"
          style={{
            maxWidth: "100%",
            color: "var(--rt-off-white)",
            font: "400 13px/1.6 Inter",
            overflowWrap: "anywhere",
            wordBreak: "break-word"
          }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingText) + cursorHtml() }}
        />
      )}
      {!streamingText && tools.length === 0 && (
        <div style={{ font: "400 12px/1.5 Inter", color: "var(--rt-fog-dim)" }}>
          Agent is working — long configuration runs can take a few minutes before the first reply.
        </div>
      )}
    </div>
  );
}

function cursorHtml(): string {
  return '<span class="chat-md__cursor" aria-hidden="true"></span>';
}

function ActivityDot() {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "var(--rt-teal)",
        animation: "rt-pulse 1.2s ease-in-out infinite",
        boxShadow: "0 0 0 0 rgba(64,200,180,0.5)"
      }}
    />
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return "0s";
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function MessageBubble({ msg }: { msg: ChatJsonlLine }) {
  if (msg.kind === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div
          style={{
            maxWidth: "78%",
            background: "var(--rt-slate-3)",
            color: "var(--rt-off-white)",
            border: "1px solid var(--rt-slate-line)",
            borderRadius: 12,
            padding: "10px 14px",
            font: "400 13px/1.5 Inter",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            wordBreak: "break-word"
          }}
        >
          {msg.text}
        </div>
      </div>
    );
  }
  if (msg.kind === "assistant") {
    return (
      <div>
        <div
          style={{
            font: "500 11px Inter",
            color: "var(--rt-fog-dim)",
            marginBottom: 4,
            textTransform: "uppercase",
            letterSpacing: 0.5
          }}
        >
          Assistant
        </div>
        <div
          className="chat-md"
          style={{
            maxWidth: "100%",
            color: "var(--rt-off-white)",
            font: "400 13px/1.6 Inter",
            overflowWrap: "anywhere",
            wordBreak: "break-word"
          }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }}
        />
        {msg.usage && (
          <div style={{ font: "400 11px Inter", color: "var(--rt-fog-dim)", marginTop: 4 }}>
            {msg.usage.inputTokens} in / {msg.usage.outputTokens} out
            {typeof msg.costUsd === "number" ? ` · $${msg.costUsd.toFixed(4)}` : ""}
            {msg.restarted ? " · restarted" : ""}
          </div>
        )}
      </div>
    );
  }
  if (msg.kind === "system") {
    return (
      <div
        style={{
          font: "400 11px/1.5 Inter",
          color: "var(--rt-fog-dim)",
          padding: "4px 0",
          fontStyle: "italic"
        }}
      >
        {msg.detail}
      </div>
    );
  }
  return (
    <div
      style={{
        font: "400 12px/1.5 Inter",
        color: "var(--rt-coral, #ff9b8a)"
      }}
    >
      {msg.family}: {msg.message}
    </div>
  );
}

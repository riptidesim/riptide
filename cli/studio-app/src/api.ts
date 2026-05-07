// Thin typed wrappers over the localhost Studio API.

import type {
  ConfigIntentRequest,
  ConfigIntentResponse,
  JobLaunchRequest,
  StudioArtifactIndex,
  StudioGraphPayload,
  StudioJobPlanResponse,
  StudioJobResponse,
  StudioJobsResponse,
  StudioReportPayload
} from "./studioTypes";

export type Protocol = "amm" | "lending" | "perpetuals" | "liquid-staking" | "stablecoin" | "custom";

export interface ProtocolChoice {
  value: Protocol;
  label: string;
}

export interface AgentProbe {
  id: string;
  label: string;
  binary: string;
  recommended: boolean;
  detected: boolean;
  version: string | null;
  path: string | null;
}

export interface StudioWorkspace {
  id: string;
  label: string;
  source: "current" | "case-study" | "registered";
  path: string;
  riptide_path: string;
  has_riptide: boolean;
  warnings: { message: string; next_action: string }[];
}

export interface RegisteredProject {
  id: string;
  label: string;
  path: string;
  created_at: string;
  last_opened_at: string | null;
}

export type DetectSource = "anchor" | "cargo-workspace" | "cargo-package";

export interface DetectedCandidate {
  programName: string;
  source: DetectSource;
  manifestPath: string;
}

export interface ProgramDetection {
  schema_version: "studio-detect-program.v1";
  programName: string | null;
  source: DetectSource | null;
  manifestPath: string | null;
  candidates: DetectedCandidate[];
}

export interface InitRequest {
  programName: string;
  protocol: Protocol;
  /** Absolute path to scaffold into. When omitted, uses the cwd Studio was launched in. */
  path?: string;
  /** Optional display label for the registry entry. Defaults to the path basename. */
  label?: string;
}

export interface InitResponse {
  schema_version: "studio-init.v1";
  program_name: string;
  protocol: Protocol;
  target_path: string | null;
  created: string[];
  warnings: string[];
  workspaces: StudioWorkspace[];
}

export interface PickDirectoryResponse {
  schema_version: "studio-pick-directory.v1";
  path: string | null;
  cancelled: boolean;
  message?: string;
}

export interface BrowseDirectoryResponse {
  schema_version: "studio-directory-list.v1";
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly payload: unknown, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "message" in (body as Record<string, unknown>)
        ? String((body as Record<string, unknown>).message)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, body, msg);
  }
  return body as T;
}

function withWorkspace(path: string, workspaceId?: string): string {
  if (!workspaceId) return path;
  const params = new URLSearchParams({ workspace: workspaceId });
  return `${path}?${params.toString()}`;
}

function graphPath(q: {
  workspaceId?: string;
  adapter?: string;
  scenario?: string;
  campaign?: string;
  run?: string;
  pack?: string;
}): string {
  const params = new URLSearchParams();
  if (q.workspaceId) params.set("workspace", q.workspaceId);
  if (q.adapter) params.set("adapter", q.adapter);
  if (q.scenario) params.set("scenario", q.scenario);
  if (q.campaign) params.set("campaign", q.campaign);
  if (q.run) params.set("run", q.run);
  if (q.pack) params.set("pack", q.pack);
  const suffix = params.toString();
  return suffix ? `/api/studio/graph?${suffix}` : "/api/studio/graph";
}

function reportPath(q: { workspaceId?: string; artifactId: string }): string {
  const params = new URLSearchParams({ artifact: q.artifactId });
  if (q.workspaceId) params.set("workspace", q.workspaceId);
  return `/api/studio/report?${params.toString()}`;
}

function launchBody(body: JobLaunchRequest): string {
  return JSON.stringify({ workspace: body.workspaceId, kind: body.kind, params: body.params });
}

export const api = {
  workspaces: () =>
    request<{ schema_version: "studio-workspaces.v1"; workspaces: StudioWorkspace[] }>("/api/studio/workspaces"),
  agents: () =>
    request<{ schema_version: "studio-agents.v1"; agents: AgentProbe[] }>("/api/studio/agents"),
  protocols: () =>
    request<{ schema_version: "studio-protocols.v1"; protocols: ProtocolChoice[] }>("/api/studio/protocols"),
  detectProgram: (workspaceId?: string) => request<ProgramDetection>(withWorkspace("/api/studio/detect-program", workspaceId)),
  init: (body: InitRequest) =>
    request<InitResponse>("/api/studio/init", {
      method: "POST",
      body: JSON.stringify({
        program_name: body.programName,
        protocol: body.protocol,
        ...(body.path ? { path: body.path } : {}),
        ...(body.label ? { label: body.label } : {})
      })
    }),
  pickDirectory: () =>
    request<PickDirectoryResponse>("/api/studio/pick-directory", {
      method: "POST",
      body: "{}"
    }),
  browseDirectory: (path?: string) => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    const suffix = params.toString();
    return request<BrowseDirectoryResponse>(`/api/studio/browse-directory${suffix ? `?${suffix}` : ""}`);
  },
  listProjects: () =>
    request<{ schema_version: "studio-registry.v1"; projects: RegisteredProject[] }>(
      "/api/studio/registry"
    ),
  registerProject: (body: { path: string; label?: string }) =>
    request<{
      schema_version: "studio-registry-entry.v1";
      project: RegisteredProject;
      workspaces: StudioWorkspace[];
    }>("/api/studio/registry", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  removeProject: async (id: string): Promise<{ workspaces: StudioWorkspace[] }> => {
    const res = await fetch(`/api/studio/registry/${encodeURIComponent(id)}`, { method: "DELETE" });
    const text = await res.text();
    if (!res.ok) {
      throw new ApiError(res.status, text, `HTTP ${res.status}`);
    }
    const body = text.length > 0 ? JSON.parse(text) : { workspaces: [] };
    return body as { workspaces: StudioWorkspace[] };
  },
  artifacts: (workspaceId?: string) => request<StudioArtifactIndex>(withWorkspace("/api/studio/artifacts", workspaceId)),
  graph: (q: { workspaceId?: string; adapter?: string; scenario?: string; campaign?: string; run?: string; pack?: string }) =>
    request<StudioGraphPayload>(graphPath(q)),
  report: (q: { workspaceId?: string; artifactId: string }) =>
    request<StudioReportPayload>(reportPath(q)),
  jobs: {
    list: (workspaceId?: string) => request<StudioJobsResponse>(withWorkspace("/api/studio/jobs", workspaceId)),
    get: (id: string) => request<StudioJobResponse>(`/api/studio/jobs/${encodeURIComponent(id)}`),
    create: (body: JobLaunchRequest) =>
      request<StudioJobResponse>("/api/studio/jobs", {
        method: "POST",
        body: launchBody(body)
      }),
    cancel: (id: string) =>
      request<StudioJobResponse>(`/api/studio/jobs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        body: "{}"
      }),
    plan: (body: JobLaunchRequest) =>
      request<StudioJobPlanResponse>("/api/studio/jobs/plan", {
        method: "POST",
        body: launchBody(body)
      })
  },
  config: {
    intent: (body: ConfigIntentRequest) =>
      request<ConfigIntentResponse>("/api/studio/config/intent", {
        method: "POST",
        body: JSON.stringify(body)
      })
  }
};

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatAgentId = "claude-code" | "codex";

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

export interface ChatThreadSummary {
  id: string;
  title: string;
  agentId: ChatAgentId;
  model: string;
  updatedAt: string;
  messageCount: number;
  lastError: { family: ChatErrorFamily; message: string } | null;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type ChatJsonlLine =
  | { kind: "user"; ts: string; runId: string; text: string }
  | {
      kind: "assistant";
      ts: string;
      runId: string;
      text: string;
      sessionId: string | null;
      usage?: ChatUsage;
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
  | { kind: "error"; ts: string; runId: string; family: ChatErrorFamily; message: string };

export const chatApi = {
  listThreads: (workspaceId?: string) =>
    request<{ schema_version: "studio-chat-threads.v1"; threads: ChatThreadSummary[] }>(
      withWorkspace("/api/studio/chat/threads", workspaceId)
    ),
  createThread: (body: { agentId: ChatAgentId; model: string; title?: string; workspaceId?: string }) =>
    request<{ schema_version: "studio-chat-thread.v1"; thread: ChatThreadSummary }>(
      "/api/studio/chat/threads",
      {
        method: "POST",
        body: JSON.stringify({
          agentId: body.agentId,
          model: body.model,
          ...(body.title ? { title: body.title } : {}),
          ...(body.workspaceId ? { workspace: body.workspaceId } : {})
        })
      }
    ),
  getThread: (id: string, workspaceId?: string) =>
    request<{
      schema_version: "studio-chat-thread-detail.v1";
      thread: ChatThreadSummary;
      messages: ChatJsonlLine[];
    }>(withWorkspace(`/api/studio/chat/threads/${encodeURIComponent(id)}`, workspaceId)),
  deleteThread: async (id: string, workspaceId?: string): Promise<void> => {
    const res = await fetch(withWorkspace(`/api/studio/chat/threads/${encodeURIComponent(id)}`, workspaceId), {
      method: "DELETE"
    });
    if (!res.ok && res.status !== 204) {
      throw new ApiError(res.status, null, `HTTP ${res.status}`);
    }
  },
  postRun: (threadId: string, body: { prompt: string; modelOverride?: string; workspaceId?: string }) =>
    request<{ schema_version: "studio-chat-run.v1"; runId: string; streamUrl: string }>(
      `/api/studio/chat/threads/${encodeURIComponent(threadId)}/runs`,
      {
        method: "POST",
        body: JSON.stringify({
          prompt: body.prompt,
          ...(body.modelOverride ? { modelOverride: body.modelOverride } : {}),
          ...(body.workspaceId ? { workspace: body.workspaceId } : {})
        })
      }
    ),
  abortRun: async (runId: string): Promise<void> => {
    const res = await fetch(`/api/studio/chat/runs/${encodeURIComponent(runId)}/abort`, {
      method: "POST"
    });
    if (!res.ok) {
      throw new ApiError(res.status, null, `HTTP ${res.status}`);
    }
  }
};

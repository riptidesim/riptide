// Typed fetch helpers for the Studio JSON API.
//
// Studio is a localhost-only client; relative URLs go through the
// CLI-bundled server. All endpoints are documented in
// `cli/src/studio/server.ts`.

export interface WorkspaceWarning {
  message: string;
  next_action: string;
}

export interface Workspace {
  id: string;
  label: string;
  source: "current" | "case-study";
  path: string;
  riptide_path: string;
  has_riptide: boolean;
  warnings: WorkspaceWarning[];
}

export type ArtifactKind =
  | "run-collection"
  | "last-run"
  | "run"
  | "campaign-root"
  | "retained-case"
  | "campaign-input"
  | "pack"
  | "guided-sim"
  | "readiness-report"
  | "markdown-summary"
  | "scenario"
  | "adapter";

export interface ArtifactWarning {
  message: string;
  next_action: string;
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  label: string;
  relative_path: string;
  path: string;
  updated_at: string | null;
  verdict?: string;
  coverage?: string;
  confidence?: string;
  status?: string;
  canonical_hash?: string;
  invariant_fire_count?: number;
  meta?: Record<string, string | number | boolean | null>;
  warnings: ArtifactWarning[];
}

export interface ArtifactIndex {
  schema_version: string;
  workspace_id: string;
  workspace_path: string;
  has_riptide: boolean;
  artifacts: Artifact[];
  warnings: ArtifactWarning[];
}

export type GraphNodeKind =
  | "workspace"
  | "adapter"
  | "semantics"
  | "persona"
  | "scenario"
  | "campaign"
  | "parameter"
  | "invariant"
  | "engine"
  | "run"
  | "report"
  | "pack";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  meaning: string;
  source_path?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface Graph {
  schema_version: "studio-graph.v2";
  workspace_id: string;
  workspace_path: string;
  selection: {
    adapter: string | null;
    scenario: string | null;
    campaign: string | null;
    run: string | null;
    pack: string | null;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: { message: string; next_action: string }[];
}

export interface ReportPayload {
  schema_version: "studio-report.v1";
  workspace_id: string;
  artifact_id: string;
  content_type: "markdown" | "json";
  label: string;
  relative_path: string;
  body: string;
}

export interface Health {
  ok: boolean;
  schema_version: string;
  started_at: string;
  workspace: string;
  case_studies_root: string | null;
  workspace_count: number;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobKind =
  | "run"
  | "replay"
  | "campaign-validate"
  | "campaign-plan"
  | "campaign-run"
  | "review"
  | "readiness";

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  cwd: string;
  argv: string[];
  output_path: string | null;
  expected_artifact: string | null;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  artifact_paths: string[];
  warnings: string[];
}

export interface JobListPayload {
  schema_version: string;
  jobs: Job[];
  warnings?: { message: string; next_action: string }[];
}

export interface JobPlanPreview {
  kind: JobKind;
  argv: string[];
  cwd: string;
  output_path: string | null;
  expected_artifact: string | null;
  command_string: string;
  notes: string[];
}

export interface ConfigIntentInput {
  workspace_id: string;
  protocol_class: string;
  repo_path: string;
  risk_goal: string;
  scenario_target: string;
  evidence_boundary: string;
  notes?: string;
}

export interface ConfigIntentResponse {
  schema_version: "studio-config-intent.v1";
  intent: ConfigIntentInput & { generated_at: string };
  proposed_files: { path: string; purpose: string }[];
  validation_commands: string[];
  handoff_prompt: string;
  notes: string[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: "invalid_json", body: text.slice(0, 200) };
  }
  if (!res.ok) {
    const detail = (parsed as { message?: string }).message ?? text.slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return parsed as T;
}

export const api = {
  health: () => getJson<Health>("/api/studio/health"),
  workspaces: () =>
    getJson<{ workspaces: Workspace[] }>("/api/studio/workspaces").then((p) => p.workspaces),
  artifacts: (workspaceId: string) =>
    getJson<ArtifactIndex>(`/api/studio/artifacts?workspace=${encodeURIComponent(workspaceId)}`),
  graph: (workspaceId: string, selection: Partial<Graph["selection"]> = {}) => {
    const params = new URLSearchParams({ workspace: workspaceId });
    for (const [key, value] of Object.entries(selection)) {
      if (value) params.set(key, value);
    }
    return getJson<Graph>(`/api/studio/graph?${params.toString()}`);
  },
  report: (workspaceId: string, artifactId: string) =>
    getJson<ReportPayload>(
      `/api/studio/report?workspace=${encodeURIComponent(workspaceId)}&artifact=${encodeURIComponent(artifactId)}`
    ),
  collection: (workspaceId: string, source?: string) => {
    const params = new URLSearchParams({ workspace: workspaceId });
    if (source) params.set("source", source);
    return getJson<unknown>(`/api/collection?${params.toString()}`);
  },
  jobs: () => getJson<JobListPayload>("/api/studio/jobs"),
  job: (id: string) => getJson<{ job: Job }>(`/api/studio/jobs/${encodeURIComponent(id)}`),
  planJob: (workspaceId: string, kind: JobKind, params: Record<string, string> = {}) =>
    postJson<{ plan: JobPlanPreview }>("/api/studio/jobs/plan", {
      workspace: workspaceId,
      kind,
      params
    }),
  launchJob: (workspaceId: string, kind: JobKind, params: Record<string, string> = {}) =>
    postJson<{ job: Job }>("/api/studio/jobs", { workspace: workspaceId, kind, params }),
  cancelJob: (id: string) =>
    postJson<{ job: Job }>(`/api/studio/jobs/${encodeURIComponent(id)}/cancel`, {}),
  configIntent: (input: ConfigIntentInput) =>
    postJson<ConfigIntentResponse>("/api/studio/config/intent", input)
};

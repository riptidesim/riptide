export type StudioArtifactKind =
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

export interface StudioWarning {
  message: string;
  next_action: string;
}

export interface StudioSourcePayload {
  schema_version: "studio-source.v1";
  workspace_id: string;
  path: string;
  absolute_path: string;
  bytes: number;
  content: string;
}

export interface StudioArtifactEntry {
  id: string;
  kind: StudioArtifactKind;
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
  totals_by_status?: Record<string, number>;
  totals_by_verdict?: Record<string, number>;
  totals_by_coverage?: Record<string, number>;
  meta?: Record<string, string | number | boolean | null>;
  warnings: StudioWarning[];
}

export interface StudioArtifactIndex {
  schema_version: "studio-artifacts.v1";
  workspace_id: string;
  workspace_path: string;
  has_riptide: boolean;
  artifacts: StudioArtifactEntry[];
  warnings: StudioWarning[];
}

export type StudioGraphNodeKind =
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

export interface StudioGraphNode {
  id: string;
  kind: StudioGraphNodeKind;
  label: string;
  meaning: string;
  source_path?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface StudioGraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface StudioGraphPayload {
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
  nodes: StudioGraphNode[];
  edges: StudioGraphEdge[];
  warnings: StudioWarning[];
}

export type JobKind =
  | "run"
  | "replay"
  | "campaign-validate"
  | "campaign-plan"
  | "campaign-run"
  | "review"
  | "readiness";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

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

export interface JobPlanPreview {
  kind: JobKind;
  argv: string[];
  cwd: string;
  output_path: string | null;
  expected_artifact: string | null;
  command_string: string;
  notes: string[];
}

export interface JobLaunchRequest {
  workspaceId: string;
  kind: JobKind;
  params: Record<string, string>;
}

export interface StudioJobsResponse {
  schema_version: "studio-jobs.v1";
  jobs: Job[];
}

export interface StudioJobResponse {
  schema_version: "studio-job.v1";
  job: Job;
}

export interface StudioJobPlanResponse {
  schema_version: "studio-job-plan.v1";
  plan: JobPlanPreview;
}

export type StudioReportContentType = "markdown" | "json" | "toml";

export interface StudioReportPayload {
  schema_version: "studio-report.v1";
  workspace_id: string;
  artifact_id: string;
  content_type: StudioReportContentType;
  label: string;
  relative_path: string;
  body: string;
}

export interface ConfigIntentRequest {
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
  intent: ConfigIntentRequest & { generated_at: string };
  proposed_files: { path: string; purpose: string }[];
  validation_commands: string[];
  handoff_prompt: string;
  notes: string[];
}

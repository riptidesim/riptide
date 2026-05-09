import type {
  ConfigIntentRequest,
  ConfigIntentResponse,
  Job,
  JobKind,
  JobLaunchRequest,
  JobPlanPreview,
  JobStatus,
  StudioArtifactEntry,
  StudioArtifactIndex,
  StudioGraphEdge,
  StudioGraphNode,
  StudioGraphPayload,
  StudioJobPlanResponse,
  StudioJobResponse,
  StudioJobsResponse,
  StudioReportPayload,
  StudioSourcePayload
} from "../../cli/studio-app/src/studioTypes";

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
  path?: string;
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

export interface DemoSnapshot {
  workspace: StudioWorkspace;
  protocol: Protocol;
  configured: boolean;
  agentRunning: boolean;
  overviewSeen: boolean;
  runComplete: boolean;
  reportSeen: boolean;
  jobRunning: boolean;
  runPhase: number;
}

interface DemoState extends DemoSnapshot {
  artifacts: StudioArtifactEntry[];
  nodes: StudioGraphNode[];
  edges: StudioGraphEdge[];
  jobs: Job[];
  report: StudioReportPayload | null;
  threads: ChatThreadSummary[];
  messages: Record<string, ChatJsonlLine[]>;
}

type Listener = () => void;

const STORAGE_KEY = "riptide.static-studio-demo.v3";
const WORKSPACE_ID = "demo-lending-workspace";
const PROTOCOLS: ProtocolChoice[] = [
  { value: "lending", label: "Lending" },
  { value: "amm", label: "AMM" },
  { value: "perpetuals", label: "Perpetuals" },
  { value: "liquid-staking", label: "Liquid staking" },
  { value: "stablecoin", label: "Stablecoin" },
  { value: "custom", label: "Custom" }
];

const AGENTS: AgentProbe[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    binary: "claude",
    recommended: true,
    detected: true,
    version: "demo",
    path: "/usr/local/bin/claude"
  },
  {
    id: "codex",
    label: "Codex",
    binary: "codex",
    recommended: false,
    detected: true,
    version: "demo",
    path: "/usr/local/bin/codex"
  }
];

const listeners = new Set<Listener>();
let state = loadState();
let runTimer: number | null = null;

export const demoStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot(): DemoSnapshot {
    return pickSnapshot(state);
  },
  markOverviewSeen(): void {
    state = { ...state, overviewSeen: true };
    persistAndNotify();
  },
  markReportSeen(): void {
    state = { ...state, reportSeen: true };
    persistAndNotify();
  },
  skipToComplete(): void {
    if (runTimer !== null) window.clearTimeout(runTimer);
    state = completeRun(configureWorkspace({ ...state, workspace: { ...state.workspace, has_riptide: true } }));
    state = { ...state, overviewSeen: true, reportSeen: true, agentRunning: false, jobRunning: false, runPhase: 0 };
    persistAndNotify();
  },
  reset(): void {
    if (runTimer !== null) window.clearTimeout(runTimer);
    runTimer = null;
    state = createInitialState();
    persistAndNotify();
  }
};

export const api = {
  workspaces: async () => ({
    schema_version: "studio-workspaces.v1" as const,
    workspaces: [state.workspace]
  }),
  agents: async () => ({
    schema_version: "studio-agents.v1" as const,
    agents: AGENTS
  }),
  protocols: async () => ({
    schema_version: "studio-protocols.v1" as const,
    protocols: PROTOCOLS
  }),
  detectProgram: async (): Promise<ProgramDetection> => ({
    schema_version: "studio-detect-program.v1",
    programName: "lending",
    source: "anchor",
    manifestPath: "Anchor.toml",
    candidates: [
      {
        programName: "lending",
        source: "anchor",
        manifestPath: "Anchor.toml"
      }
    ]
  }),
  init: async (body: InitRequest): Promise<InitResponse> => {
    const workspace = workspaceFor(body.programName || "lending", body.protocol);
    state = {
      ...createInitialState(),
      workspace: { ...workspace, has_riptide: true },
      protocol: body.protocol
    };
    persistAndNotify();
    return {
      schema_version: "studio-init.v1",
      program_name: body.programName,
      protocol: body.protocol,
      target_path: workspace.path,
      created: [".riptide/adapters/lending.toml", ".riptide/scenarios/"],
    warnings: [],
      workspaces: [state.workspace]
    };
  },
  pickDirectory: async (): Promise<PickDirectoryResponse> => ({
    schema_version: "studio-pick-directory.v1",
    path: state.workspace.path,
    cancelled: false,
    message: "Static demo workspace selected."
  }),
  browseDirectory: async (path?: string): Promise<BrowseDirectoryResponse> => ({
    schema_version: "studio-directory-list.v1",
    path: path ?? "browser://riptide-demo",
    parent: null,
    entries: [
      { name: "solana-lending-market", path: "browser://riptide-demo/solana-lending-market" }
    ]
  }),
  listProjects: async () => ({
    schema_version: "studio-registry.v1" as const,
    projects: [projectEntry()]
  }),
  registerProject: async () => ({
    schema_version: "studio-registry-entry.v1" as const,
    project: projectEntry(),
    workspaces: [state.workspace]
  }),
  removeProject: async () => ({ workspaces: [state.workspace] }),
  artifacts: async (): Promise<StudioArtifactIndex> => ({
    schema_version: "studio-artifacts.v1",
    workspace_id: state.workspace.id,
    workspace_path: state.workspace.path,
    has_riptide: state.workspace.has_riptide,
    artifacts: state.artifacts,
    warnings: demoWarnings()
  }),
  graph: async (): Promise<StudioGraphPayload> => ({
    schema_version: "studio-graph.v2",
    workspace_id: state.workspace.id,
    workspace_path: state.workspace.path,
    selection: {
      adapter: null,
      scenario: null,
      campaign: null,
      run: null,
      pack: null
    },
    nodes: state.nodes,
    edges: state.edges,
    warnings: demoWarnings()
  }),
  report: async (q: { artifactId: string }): Promise<StudioReportPayload> => reportFor(q.artifactId),
  source: async (q: { path: string }): Promise<StudioSourcePayload> => ({
    schema_version: "studio-source.v1",
    workspace_id: state.workspace.id,
    path: q.path,
    absolute_path: `${state.workspace.path}/${q.path}`,
    bytes: sourceFor(q.path).length,
    content: sourceFor(q.path)
  }),
  jobs: {
    list: async (): Promise<StudioJobsResponse> => ({
      schema_version: "studio-jobs.v1",
      jobs: state.jobs
    }),
    get: async (id: string): Promise<StudioJobResponse> => ({
      schema_version: "studio-job.v1",
      job: state.jobs.find((job) => job.id === id) ?? createJob("queued")
    }),
    create: async (body: JobLaunchRequest): Promise<StudioJobResponse> => {
      const job = startRun(body.kind);
      return {
        schema_version: "studio-job.v1",
        job
      };
    },
    cancel: async (id: string): Promise<StudioJobResponse> => {
      const job = state.jobs.find((row) => row.id === id) ?? createJob("cancelled");
      const next = { ...job, status: "cancelled" as const, updated_at: nowIso(), exit_code: null };
      state = {
        ...state,
        jobs: state.jobs.map((row) => row.id === id ? next : row),
        jobRunning: false,
        runPhase: 0
      };
      persistAndNotify();
      return { schema_version: "studio-job.v1", job: next };
    },
    plan: async (body: JobLaunchRequest): Promise<StudioJobPlanResponse> => ({
      schema_version: "studio-job-plan.v1",
      plan: planFor(body.kind)
    })
  },
  config: {
    intent: async (body: ConfigIntentRequest): Promise<ConfigIntentResponse> => ({
      schema_version: "studio-config-intent.v1",
      intent: { ...body, generated_at: nowIso() },
      proposed_files: [
        { path: ".riptide/adapters/solana-lending-market.toml", purpose: "Map actions, observations, personas, and invariants." },
        { path: ".riptide/scenarios/whale-shock-grid/run-config.json", purpose: "Run the first deterministic risk path." }
      ],
      validation_commands: [
        "riptide lint .riptide/adapters/solana-lending-market.toml",
        "riptide run whale-shock-grid --seeds 3 --seed-root 1337"
      ],
      handoff_prompt: "Configure this workspace for a lending risk simulation with a whale borrower, keeper, oracle shock, and health-factor invariant.",
      notes: ["Intent prepared for the lending workspace."]
    })
  }
};

export const chatApi = {
  listThreads: async () => ({
    schema_version: "studio-chat-threads.v1" as const,
    threads: state.threads
  }),
  createThread: async (body: { agentId: ChatAgentId; model: string; title?: string }) => {
    const thread = {
      id: `thread-${Date.now()}`,
      title: body.title ?? "Configure demo workspace",
      agentId: body.agentId,
      model: body.model,
      updatedAt: nowIso(),
      messageCount: 0,
      lastError: null
    } satisfies ChatThreadSummary;
    state = {
      ...state,
      threads: [thread, ...state.threads],
      messages: { ...state.messages, [thread.id]: [] }
    };
    persistAndNotify();
    return { schema_version: "studio-chat-thread.v1" as const, thread };
  },
  getThread: async (id: string) => ({
    schema_version: "studio-chat-thread-detail.v1" as const,
    thread: state.threads.find((thread) => thread.id === id) ?? state.threads[0]!,
    messages: state.messages[id] ?? []
  }),
  deleteThread: async (id: string): Promise<void> => {
    const messages = { ...state.messages };
    delete messages[id];
    state = {
      ...state,
      threads: state.threads.filter((thread) => thread.id !== id),
      messages
    };
    persistAndNotify();
  },
  postRun: async (threadId: string, body: { prompt: string }) => {
    const runId = `run-${Date.now()}`;
    const thread = state.threads.find((row) => row.id === threadId);
    const existing = state.messages[threadId] ?? [];
    const user: ChatJsonlLine = {
      kind: "user",
      ts: nowIso(),
      runId,
      text: body.prompt
    };
    state = {
      ...state,
      agentRunning: true,
      threads: state.threads.map((row) =>
        row.id === threadId
          ? { ...row, title: thread?.title ?? "Configure demo workspace", updatedAt: nowIso(), messageCount: existing.length + 1 }
          : row
      ),
      messages: { ...state.messages, [threadId]: [...existing, user] }
    };
    persistAndNotify();
    return {
      schema_version: "studio-chat-run.v1" as const,
      runId,
      streamUrl: `demo://chat/${encodeURIComponent(threadId)}/${encodeURIComponent(runId)}`
    };
  },
  abortRun: async (): Promise<void> => {}
};

export class DemoEventSource extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  url: string;
  withCredentials = false;
  private timers: number[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    const parts = url.split("/");
    const runId = decodeURIComponent(parts.pop() ?? "run-demo-chat");
    const threadId = decodeURIComponent(parts.pop() ?? "");
    this.schedule(120, "meta", {});
    this.schedule(900, "tool", { name: "read_workspace", summary: "Indexed project files" });
    this.schedule(1900, "delta", { text: "I found a lending-shaped workspace. I am drafting the adapter, personas, scenarios, and invariants now." });
    this.schedule(3300, "tool", { name: "write_config", summary: "Created .riptide workspace files" });
    this.schedule(4600, "delta", { text: " The workspace is configured. Open Overview to inspect the graph and evidence counters." });
    this.timers.push(window.setTimeout(() => {
      finishChatRun(threadId, runId);
      this.dispatch("done", { restarted: false });
      this.close();
    }, 5600));
  }

  close(): void {
    this.readyState = 2;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers = [];
  }

  private schedule(ms: number, type: string, data: unknown): void {
    this.timers.push(window.setTimeout(() => this.dispatch(type, data), ms));
  }

  private dispatch(type: string, data: unknown): void {
    if (this.readyState === 2) return;
    this.readyState = 1;
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    this.dispatchEvent(event);
    if (type === "error") this.onerror?.(event);
  }
}

function finishChatRun(threadId: string, runId: string): void {
  const configured = configureWorkspace(state);
  const assistant: ChatJsonlLine = {
    kind: "assistant",
    ts: nowIso(),
    runId,
    text: "Configured a lending workspace with a graph-derived adapter, whale borrower, keeper, small depositor, whale-shock-grid scenario, bounded-risk-slice campaign, and economic invariants.",
    sessionId: "demo-session",
    usage: { inputTokens: 1420, outputTokens: 248 },
    costUsd: 0
  };
  const existing = configured.messages[threadId] ?? [];
  state = {
    ...configured,
    agentRunning: false,
    threads: configured.threads.map((thread) =>
      thread.id === threadId
        ? { ...thread, updatedAt: nowIso(), messageCount: existing.length + 1 }
        : thread
    ),
    messages: { ...configured.messages, [threadId]: [...existing, assistant] }
  };
  persistAndNotify();
}

function startRun(kind: JobKind): Job {
  if (runTimer !== null) window.clearTimeout(runTimer);
  const configured = state.configured ? state : configureWorkspace(state);
  const job = createJob("running", kind);
  state = {
    ...configured,
    jobs: [job, ...configured.jobs],
    jobRunning: true,
    runPhase: 0
  };
  persistAndNotify();
  const phases = [
    "booting LiteSVM runtime",
    "driving whale borrower and keeper personas",
    "evaluating health factor bounded invariant",
    "writing .riptide/reports/demo-whale-shock.md"
  ];
  phases.forEach((stdout, index) => {
    window.setTimeout(() => {
      if (!state.jobRunning) return;
      state = {
        ...state,
        runPhase: index,
        jobs: state.jobs.map((row) => row.id === job.id ? { ...row, stdout_tail: stdout, updated_at: nowIso() } : row)
      };
      persistAndNotify();
    }, 450 + index * 1400);
  });
  runTimer = window.setTimeout(() => {
    state = completeRun({
      ...state,
      jobRunning: false,
      runPhase: 0,
      jobs: state.jobs.map((row) =>
        row.id === job.id
          ? {
              ...row,
              status: "succeeded",
              exit_code: 1,
              updated_at: nowIso(),
              stdout_tail: "invariant fired: health factor bounded\nwrote .riptide/reports/demo-whale-shock.md",
              artifact_paths: [
                ".riptide/runs/demo-whale-shock/simulation-result.json",
                ".riptide/reports/demo-whale-shock.md"
              ]
            }
          : row
      )
    });
    persistAndNotify();
  }, 6500);
  return job;
}

function loadState(): DemoState {
  if (typeof window === "undefined") return createInitialState();
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return createInitialState();
  try {
    const parsed = JSON.parse(raw) as DemoState;
    if (!parsed.workspace || parsed.workspace.id !== WORKSPACE_ID) return createInitialState();
    return parsed;
  } catch {
    return createInitialState();
  }
}

function createInitialState(): DemoState {
  const workspace = workspaceFor("lending", "lending");
  return {
    workspace: { ...workspace, has_riptide: false },
    protocol: "lending",
    configured: false,
    agentRunning: false,
    overviewSeen: false,
    runComplete: false,
    reportSeen: false,
    jobRunning: false,
    runPhase: 0,
    artifacts: [],
    nodes: [workspaceNode(workspace)],
    edges: [],
    jobs: [],
    report: null,
    threads: [],
    messages: {}
  };
}

function configureWorkspace(input: DemoState): DemoState {
  const workspace = { ...input.workspace, has_riptide: true };
  const slug = "lending";
  const nodes: StudioGraphNode[] = [
    workspaceNode(workspace),
    {
      id: "adapter:primary",
      kind: "adapter",
      label: "lending.toml",
      meaning: "Lending adapter mapping actions, observations, personas, scenarios, and invariants for the demo workspace.",
      source_path: `.riptide/adapters/${slug}.toml`,
      meta: { protocol_class: input.protocol, generated_by: "agent" }
    },
    {
      id: "semantics:lending",
      kind: "semantics",
      label: "lending.v1",
      meaning: "Normalizes collateral, debt, oracle price, liquidation threshold, and health factor observations.",
      meta: { class: "lending.v1" }
    },
    {
      id: "persona:whale",
      kind: "persona",
      label: "Whale borrower",
      meaning: "Supplies concentrated collateral and borrows near the allowed limit.",
      source_path: `.riptide/adapters/${slug}.toml`,
      meta: { role: "borrower", risk: "concentration" }
    },
    {
      id: "persona:keeper",
      kind: "persona",
      label: "Liquidation keeper",
      meaning: "Attempts liquidation after oracle stress crosses the threshold.",
      source_path: `.riptide/adapters/${slug}.toml`,
      meta: { role: "keeper" }
    },
    {
      id: "persona:depositor",
      kind: "persona",
      label: "Small depositor",
      meaning: "Adds background liquidity movement so the run is not a single-account smoke.",
      source_path: `.riptide/adapters/${slug}.toml`,
      meta: { role: "liquidity" }
    },
    {
      id: "scenario:whale-shock-grid",
      kind: "scenario",
      label: "whale-shock-grid",
      meaning: "Seeded path with deposit pressure, borrow pressure, oracle shock, and keeper liquidation.",
      source_path: ".riptide/scenarios/whale-shock-grid/run-config.json",
      meta: { seeds: 3, seed_root: 1337, ticks: 64 }
    },
    {
      id: "scenario:oracle-drawdown",
      kind: "scenario",
      label: "oracle-drawdown",
      meaning: "Price movement and keeper timing path that validates liquidation response coverage.",
      source_path: ".riptide/scenarios/oracle-drawdown/run-config.json",
      meta: { seeds: 12, seed_root: 1441, ticks: 80 }
    },
    {
      id: "scenario:liquidity-exit",
      kind: "scenario",
      label: "liquidity-exit",
      meaning: "Depositor exit pressure with utilization and reserve accounting checks.",
      source_path: ".riptide/scenarios/liquidity-exit/run-config.json",
      meta: { seeds: 8, seed_root: 2027, ticks: 72 }
    },
    {
      id: "campaign:bounded-risk-slice",
      kind: "campaign",
      label: "bounded-risk-slice",
      meaning: "Small matrix over whale size, oracle movement, and keeper timing.",
      source_path: ".riptide/campaigns/bounded-risk-slice.toml",
      meta: { axes: 3, total_runs: 18 }
    },
    {
      id: "invariant:health-factor",
      kind: "invariant",
      label: "health factor bounded",
      meaning: "Borrower health must not remain below liquidation threshold after keeper action.",
      source_path: `.riptide/adapters/${slug}.toml`,
      meta: { severity: "high" }
    },
    {
      id: "invariant:reserve-solvency",
      kind: "invariant",
      label: "reserve remains solvent",
      meaning: "Reserve accounting must not diverge after adverse price movement.",
      source_path: `.riptide/adapters/${slug}.toml`,
      meta: { severity: "medium" }
    },
    {
      id: "invariant:oracle-freshness",
      kind: "invariant",
      label: "oracle freshness bounded",
      meaning: "Liquidation decisions must not use stale price observations.",
      source_path: `.riptide/adapters/${slug}.toml`,
      meta: { severity: "medium" }
    },
    {
      id: "invariant:withdrawal-liquidity",
      kind: "invariant",
      label: "withdrawal liquidity bounded",
      meaning: "Depositor withdrawals must respect available liquidity and debt accounting.",
      source_path: `.riptide/adapters/${slug}.toml`,
      meta: { severity: "medium" }
    }
  ];
  const edges: StudioGraphEdge[] = [
    { id: "workspace-adapter", from: "workspace", to: "adapter:primary", label: "contains" },
    { id: "adapter-semantics", from: "adapter:primary", to: "semantics:lending", label: "observes" },
    { id: "adapter-whale", from: "adapter:primary", to: "persona:whale", label: "declares" },
    { id: "adapter-keeper", from: "adapter:primary", to: "persona:keeper", label: "declares" },
    { id: "adapter-depositor", from: "adapter:primary", to: "persona:depositor", label: "declares" },
    { id: "scenario-whale", from: "scenario:whale-shock-grid", to: "persona:whale", label: "uses" },
    { id: "scenario-invariant", from: "scenario:whale-shock-grid", to: "invariant:health-factor", label: "checks" },
    { id: "scenario-oracle", from: "scenario:oracle-drawdown", to: "invariant:oracle-freshness", label: "checks" },
    { id: "scenario-liquidity", from: "scenario:liquidity-exit", to: "invariant:withdrawal-liquidity", label: "checks" },
    { id: "campaign-scenario", from: "campaign:bounded-risk-slice", to: "scenario:whale-shock-grid", label: "expands" }
  ];
  const artifacts = baselineArtifacts(workspace);
  return {
    ...input,
    workspace,
    configured: true,
    agentRunning: false,
    artifacts,
    nodes,
    edges,
    jobs: baselineJobs(workspace)
  };
}

function completeRun(input: DemoState): DemoState {
  const configured = input.configured ? input : configureWorkspace(input);
  const report = createReport(configured.workspace);
  const runArtifact = createRunArtifact(configured.workspace);
  const reportArtifact = createReportArtifact(configured.workspace);
  const runNode: StudioGraphNode = {
    id: "run:demo-whale-shock",
    kind: "run",
    label: "demo-whale-shock",
    meaning: "Run that produces the final report artifact for the guided workflow.",
    source_path: ".riptide/runs/demo-whale-shock/simulation-result.json",
    meta: { verdict: "fail", seed_root: 1337 }
  };
  const reportNode: StudioGraphNode = {
    id: "report:demo-whale-shock",
    kind: "report",
    label: "Risk report",
    meaning: "Markdown report summarizing the invariant fire, root cause, reproduction command, and evidence boundary.",
    source_path: ".riptide/reports/demo-whale-shock.md",
    meta: { invariant_fire_count: 1 }
  };
  return {
    ...configured,
    runComplete: true,
    artifacts: mergeArtifacts(configured.artifacts, [runArtifact, reportArtifact]),
    nodes: mergeNodes(configured.nodes, [runNode, reportNode]),
    edges: mergeEdges(configured.edges, [
      { id: "scenario-run", from: "scenario:whale-shock-grid", to: "run:demo-whale-shock", label: "executes" },
      { id: "run-report", from: "run:demo-whale-shock", to: "report:demo-whale-shock", label: "produces" }
    ]),
    report
  };
}

function workspaceFor(name: string, protocol: Protocol): StudioWorkspace {
  void protocol;
  return {
    id: WORKSPACE_ID,
    label: name,
    source: "registered",
    path: "/demo/workspaces/lending",
    riptide_path: "/demo/workspaces/lending/.riptide",
    has_riptide: false,
    warnings: []
  };
}

function projectEntry(): RegisteredProject {
  return {
    id: WORKSPACE_ID,
    label: state.workspace.label,
    path: state.workspace.path,
    created_at: nowIso(),
    last_opened_at: nowIso()
  };
}

function baselineArtifacts(workspace: StudioWorkspace): StudioArtifactEntry[] {
  return [
    runCollectionArtifact(workspace),
    lastRunArtifact(workspace),
    ...Array.from({ length: 5 }, (_, index) => historicalRunArtifact(workspace, index)),
    ...Array.from({ length: 2 }, (_, index) => campaignRootArtifact(workspace, index)),
    ...Array.from({ length: 6 }, (_, index) => retainedCaseArtifact(workspace, index)),
    ...Array.from({ length: 64 }, (_, index) => summaryArtifact(workspace, index)),
    adapterArtifact(workspace),
    campaignArtifact(workspace),
    scenarioArtifact(workspace, "whale-shock-grid", 0),
    scenarioArtifact(workspace, "oracle-drawdown", 1),
    scenarioArtifact(workspace, "liquidity-exit", 2)
  ];
}

function runCollectionArtifact(workspace: StudioWorkspace): StudioArtifactEntry {
  return {
    id: "run-collection",
    kind: "run-collection",
    label: "latest run collection",
    relative_path: ".riptide/run-collection.json",
    path: `${workspace.riptide_path}/run-collection.json`,
    updated_at: recentIso(1),
    verdict: "no-failure-observed",
    coverage: "exercised",
    totals_by_verdict: { "no-failure-observed": 60 },
    totals_by_coverage: { exercised: 60 },
    meta: { scenarios: 60, seeds: 60 },
    warnings: []
  };
}

function lastRunArtifact(workspace: StudioWorkspace): StudioArtifactEntry {
  return {
    id: "last-run",
    kind: "last-run",
    label: "last-run",
    relative_path: ".riptide/last-run.json",
    path: `${workspace.riptide_path}/last-run.json`,
    updated_at: recentIso(2),
    verdict: "no-failure-observed",
    coverage: "exercised",
    meta: { seed_root: 1337 },
    warnings: []
  };
}

function historicalRunArtifact(workspace: StudioWorkspace, index: number): StudioArtifactEntry {
  const label = ["solvency-grid", "oracle-drawdown", "liquidity-exit", "keeper-response", "deposit-pressure"][index] ?? `run-${index + 1}`;
  return {
    id: `artifact:run:${label}`,
    kind: "run",
    label,
    relative_path: `.riptide/runs/${label}/simulation-result.json`,
    path: `${workspace.riptide_path}/runs/${label}/simulation-result.json`,
    updated_at: recentIso(4 + index),
    verdict: "no-failure-observed",
    coverage: "exercised",
    invariant_fire_count: 0,
    meta: { seed_root: 1337 + index },
    warnings: []
  };
}

function campaignRootArtifact(workspace: StudioWorkspace, index: number): StudioArtifactEntry {
  const label = ["bounded-risk-slice", "keeper-latency-sweep"][index] ?? `campaign-root-${index + 1}`;
  return {
    id: `artifact:campaign-root:${label}`,
    kind: "campaign-root",
    label,
    relative_path: `.riptide/campaigns/${label}/campaign-result.json`,
    path: `${workspace.riptide_path}/campaigns/${label}/campaign-result.json`,
    updated_at: recentIso(10 + index),
    verdict: "no-failure-observed",
    coverage: "exercised",
    totals_by_verdict: { "no-failure-observed": index === 0 ? 36 : 24 },
    meta: { retained_runs: index === 0 ? 3 : 2 },
    warnings: []
  };
}

function retainedCaseArtifact(workspace: StudioWorkspace, index: number): StudioArtifactEntry {
  return {
    id: `artifact:retained-case:${index + 1}`,
    kind: "retained-case",
    label: `retained-case-${String(index + 1).padStart(2, "0")}`,
    relative_path: `.riptide/campaigns/bounded-risk-slice/retained/case-${String(index + 1).padStart(2, "0")}.json`,
    path: `${workspace.riptide_path}/campaigns/bounded-risk-slice/retained/case-${String(index + 1).padStart(2, "0")}.json`,
    updated_at: recentIso(14 + index),
    verdict: "no-failure-observed",
    coverage: "exercised",
    warnings: []
  };
}

function summaryArtifact(workspace: StudioWorkspace, index: number): StudioArtifactEntry {
  return {
    id: `artifact:summary:${index + 1}`,
    kind: "markdown-summary",
    label: `risk-summary-${String(index + 1).padStart(2, "0")}`,
    relative_path: `.riptide/reports/risk-summary-${String(index + 1).padStart(2, "0")}.md`,
    path: `${workspace.riptide_path}/reports/risk-summary-${String(index + 1).padStart(2, "0")}.md`,
    updated_at: recentIso(20 + index),
    verdict: "no-failure-observed",
    coverage: "exercised",
    warnings: []
  };
}

function adapterArtifact(workspace: StudioWorkspace): StudioArtifactEntry {
  return {
    id: "artifact:adapter",
    kind: "adapter",
    label: "lending.toml",
    relative_path: ".riptide/adapters/lending.toml",
    path: `${workspace.riptide_path}/adapters/lending.toml`,
    updated_at: recentIso(84),
    meta: { generated_by: "agent", protocol_class: "lending" },
    warnings: []
  };
}

function scenarioArtifact(workspace: StudioWorkspace, label: string, index: number): StudioArtifactEntry {
  return {
    id: `artifact:scenario:${label}`,
    kind: "scenario",
    label,
    relative_path: `.riptide/scenarios/${label}/run-config.json`,
    path: `${workspace.riptide_path}/scenarios/${label}/run-config.json`,
    updated_at: recentIso(85 + index),
    meta: { seeds: [3, 12, 8][index] ?? 3, seed_root: 1337 + index },
    warnings: []
  };
}

function campaignArtifact(workspace: StudioWorkspace): StudioArtifactEntry {
  return {
    id: "artifact:campaign:bounded-risk-slice",
    kind: "campaign-input",
    label: "bounded-risk-slice.toml",
    relative_path: ".riptide/campaigns/bounded-risk-slice.toml",
    path: `${workspace.riptide_path}/campaigns/bounded-risk-slice.toml`,
    updated_at: recentIso(88),
    meta: { total_runs: 60, retained_runs: 5 },
    warnings: []
  };
}

function createRunArtifact(workspace: StudioWorkspace): StudioArtifactEntry {
  return {
    id: "artifact:run:demo-whale-shock",
    kind: "run",
    label: "demo-whale-shock",
    relative_path: ".riptide/runs/demo-whale-shock/simulation-result.json",
    path: `${workspace.riptide_path}/runs/demo-whale-shock/simulation-result.json`,
    updated_at: nowIso(),
    verdict: "fail",
    coverage: "exercised",
    confidence: "high",
    invariant_fire_count: 1,
    meta: { seed_root: 1337 },
    warnings: []
  };
}

function createReportArtifact(workspace: StudioWorkspace): StudioArtifactEntry {
  return {
    id: "artifact:report:demo-whale-shock",
    kind: "markdown-summary",
    label: "Risk report",
    relative_path: ".riptide/reports/demo-whale-shock.md",
    path: `${workspace.riptide_path}/reports/demo-whale-shock.md`,
    updated_at: nowIso(),
    verdict: "fail",
    coverage: "exercised",
    confidence: "high",
    invariant_fire_count: 1,
    meta: { product: workspace.label, protocol_class: "lending" },
    warnings: []
  };
}

function reportFor(artifactId: string): StudioReportPayload {
  if (artifactId.includes("adapter")) {
    return {
      schema_version: "studio-report.v1",
      workspace_id: state.workspace.id,
      artifact_id: artifactId,
      content_type: "toml",
      label: "lending.toml",
      relative_path: ".riptide/adapters/lending.toml",
      body: sourceFor(".riptide/adapters/lending.toml")
    };
  }
  if (artifactId.includes("scenario")) {
    const label = artifactId.split(":").pop() ?? "whale-shock-grid";
    return {
      schema_version: "studio-report.v1",
      workspace_id: state.workspace.id,
      artifact_id: artifactId,
      content_type: "json",
      label,
      relative_path: `.riptide/scenarios/${label}/run-config.json`,
      body: JSON.stringify({ scenario: label, seeds: 3, seed_root: 1337, tick_budget: 64 }, null, 2)
    };
  }
  if (state.report && artifactId.includes("report")) return state.report;
  return state.report ?? createSummaryReport(state.workspace, artifactId);
}

function createSummaryReport(workspace: StudioWorkspace, artifactId: string): StudioReportPayload {
  return {
    schema_version: "studio-report.v1",
    workspace_id: workspace.id,
    artifact_id: artifactId,
    content_type: "markdown",
    label: "Run collection summary",
    relative_path: ".riptide/reports/run-collection-summary.md",
    body: [
      "# Lending run collection",
      "",
      "Verdict: no failure observed across the latest 60 scenario runs.",
      "",
      "## Coverage",
      "The run collection exercised borrower health, keeper timing, oracle movement, deposit pressure, and reserve accounting paths.",
      "",
      "## Review target",
      "Open the Reports view to inspect retained cases and drill into the scenario evidence."
    ].join("\n")
  };
}

function createReport(workspace: StudioWorkspace): StudioReportPayload {
  return {
    schema_version: "studio-report.v1",
    workspace_id: workspace.id,
    artifact_id: "artifact:report:demo-whale-shock",
    content_type: "markdown",
    label: "Risk report",
    relative_path: ".riptide/reports/demo-whale-shock.md",
    body: [
      `# ${workspace.label} risk report`,
      "",
      "Verdict: invariant fired in the whale-shock-grid run.",
      "",
      "## What happened",
      "A whale borrower supplied concentrated collateral, borrowed near the configured limit, and then hit a deterministic oracle shock. The keeper acted, but the borrower health factor stayed below the liquidation threshold for two ticks after the liquidation attempt.",
      "",
      "## Fired invariant",
      "`health factor bounded` fired at tick 42. The first failing flow step is the keeper liquidation path, not setup or adapter parsing.",
      "",
      "## Reproduction shape",
      "`riptide run whale-shock-grid --seeds 3 --seed-root 1337`",
      "",
      "## Evidence boundary",
      "This report is attached to the sample lending workspace and captures the review path for the selected run."
    ].join("\n")
  };
}

function baselineJobs(workspace: StudioWorkspace): Job[] {
  const rows: Job[] = [];
  for (let index = 0; index < 11; index += 1) rows.push(historyJob(workspace, "succeeded", index));
  for (let index = 0; index < 5; index += 1) rows.push(historyJob(workspace, "failed", index + 11));
  rows.push(historyJob(workspace, "cancelled", 16));
  return rows;
}

function historyJob(workspace: StudioWorkspace, status: JobStatus, index: number): Job {
  const slug = ["solvency-grid", "oracle-drawdown", "liquidity-exit", "keeper-response", "deposit-pressure"][index % 5] ?? "risk-run";
  return {
    id: `job:history:${String(index + 1).padStart(2, "0")}`,
    kind: index % 3 === 0 ? "campaign-run" : "run",
    status,
    created_at: recentIso(120 + index * 7),
    updated_at: recentIso(110 + index * 7),
    workspace_id: workspace.id,
    cwd: workspace.path,
    argv: index % 3 === 0
      ? ["riptide", "campaign", "run", "bounded-risk-slice"]
      : ["riptide", "run", slug, "--seed-root", String(1337 + index)],
    output_path: `.riptide/runs/${slug}`,
    expected_artifact: `.riptide/reports/${slug}.md`,
    exit_code: status === "succeeded" ? 0 : status === "failed" ? 1 : null,
    stdout_tail: status === "failed" ? "invariant pressure exceeded configured threshold" : "completed scenario sweep",
    stderr_tail: "",
    artifact_paths: status === "cancelled" ? [] : [`.riptide/runs/${slug}/simulation-result.json`],
    warnings: []
  };
}

function createJob(status: JobStatus, kind: JobKind = "run"): Job {
  return {
    id: "job:demo-run",
    kind,
    status,
    created_at: nowIso(),
    updated_at: nowIso(),
    workspace_id: state.workspace.id,
    cwd: state.workspace.path,
    argv: ["riptide", "run", "whale-shock-grid", "--seeds", "3", "--seed-root", "1337"],
    output_path: ".riptide/runs/demo-whale-shock",
    expected_artifact: ".riptide/reports/demo-whale-shock.md",
    exit_code: status === "succeeded" ? 1 : null,
    stdout_tail: status === "succeeded" ? "invariant fired: health factor bounded\nwrote report" : "waiting for run...",
    stderr_tail: "",
    artifact_paths: [],
    warnings: []
  };
}

function planFor(kind: JobKind): JobPlanPreview {
  return {
    kind,
    argv: ["riptide", kind === "campaign-run" ? "campaign" : "run", "whale-shock-grid", "--seed-root", "1337"],
    cwd: state.workspace.path,
    output_path: ".riptide/runs/demo-whale-shock",
    expected_artifact: ".riptide/reports/demo-whale-shock.md",
    command_string: "riptide run whale-shock-grid --seeds 3 --seed-root 1337",
    notes: ["Run will be queued from the selected report artifact."]
  };
}

function sourceFor(path: string): string {
  if (path.endsWith(".toml")) {
    return [
      'program_name = "lending"',
      'protocol_class = "lending"',
      "",
      "[personas.whale_borrower]",
      'role = "borrower"',
      "",
      "[invariants.health_factor_bounded]",
      'severity = "high"'
    ].join("\n");
  }
  return JSON.stringify({ scenario: "whale-shock-grid", seed_root: 1337 }, null, 2);
}

function workspaceNode(workspace: StudioWorkspace): StudioGraphNode {
  return {
    id: "workspace",
    kind: "workspace",
    label: workspace.label,
    meaning: "Sample lending workspace.",
    meta: { source: "demo" }
  };
}

function pickSnapshot(input: DemoState): DemoSnapshot {
  return {
    workspace: input.workspace,
    protocol: input.protocol,
    configured: input.configured,
    agentRunning: input.agentRunning,
    overviewSeen: input.overviewSeen,
    runComplete: input.runComplete,
    reportSeen: input.reportSeen,
    jobRunning: input.jobRunning,
    runPhase: input.runPhase
  };
}

function mergeArtifacts(existing: StudioArtifactEntry[], next: StudioArtifactEntry[]): StudioArtifactEntry[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}

function mergeNodes(existing: StudioGraphNode[], next: StudioGraphNode[]): StudioGraphNode[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}

function mergeEdges(existing: StudioGraphEdge[], next: StudioGraphEdge[]): StudioGraphEdge[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}

function demoWarnings(): { message: string; next_action: string }[] {
  return [];
}

function persistAndNotify(): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent("riptide-demo-change", { detail: pickSnapshot(state) }));
  }
  for (const listener of listeners) listener();
}

function nowIso(): string {
  return new Date().toISOString();
}

function recentIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

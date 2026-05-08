import { useEffect, useMemo, useState } from "react";

import { api } from "../api";
import type { PageId } from "../shell/types";
import type {
  Job,
  StudioArtifactEntry,
  StudioGraphNode,
  StudioReportPayload
} from "../studioTypes";
import { Icon, type IconName } from "../ui/Icon";
import { Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";

interface TutorialPageProps {
  workspaceId: string;
  workspacePath: string;
  onNavigate: (id: PageId) => void;
}

type TutorialActionKind = "navigate" | "queue-run" | "preview-report";

interface TutorialStep {
  id: number;
  label: string;
  title: string;
  body: string;
  done: boolean;
  target: PageId;
  actionKind: TutorialActionKind;
  actionLabel: string;
  icon: IconName;
  pill: string;
  pillKind: PillKind;
}

interface TutorialMetrics {
  hasRiptide: boolean;
  adapterCount: number;
  personaCount: number;
  scenarioCount: number;
  invariantCount: number;
  runCount: number;
  reportCount: number;
  activeJobCount: number;
  hasSucceededRunJob: boolean;
  latestReportArtifact: StudioArtifactEntry | null;
}

const REPORT_KINDS: ReadonlySet<StudioArtifactEntry["kind"]> = new Set([
  "run-collection",
  "last-run",
  "run",
  "campaign-root",
  "retained-case",
  "pack",
  "guided-sim",
  "readiness-report",
  "markdown-summary"
]);

const RUN_KINDS: ReadonlySet<StudioArtifactEntry["kind"]> = new Set([
  "run-collection",
  "last-run",
  "run",
  "campaign-root",
  "retained-case",
  "guided-sim"
]);

const GUIDE_SECTIONS = [
  {
    title: "What is Riptide?",
    body: "Riptide runs deterministic economic simulations against Solana program artifacts. Studio reads the local .riptide workspace and turns adapters, personas, scenarios, jobs, and reports into a browsable workflow."
  },
  {
    title: "How simulations work",
    body: "A run advances a seeded scenario through ticks. Persona actions invoke the adapter, the engine records observations, and invariants check whether the protocol stayed inside the expected economic bounds."
  },
  {
    title: "Adapter, personas, scenarios, invariants",
    body: "The adapter maps your program and protocol semantics. Personas describe actors. Scenarios bind seeds and run parameters. Invariants are falsifiable claims the engine evaluates on every run."
  },
  {
    title: "Reading a report",
    body: "Start from the latest run, campaign, readiness, or markdown artifact. A report should tell you the verdict, fired invariants, reproduction command, and the evidence boundary for what the run did or did not prove."
  },
  {
    title: "Common workflows",
    body: "Use Agent chat to configure gaps, run a scenario from Studio's allowlisted job launcher, inspect Jobs while it runs, and read the resulting artifact from Reports or this tutorial preview."
  },
  {
    title: "Keyboard shortcuts",
    body: "Cmd/Ctrl+K opens the command palette. / also opens it when focus is not inside a form field."
  }
];

export function TutorialPage({ workspaceId, workspacePath, onNavigate }: TutorialPageProps) {
  const [openIdx, setOpenIdx] = useState(0);
  const [selectedStepId, setSelectedStepId] = useState<number | null>(null);
  const [artifacts, setArtifacts] = useState<StudioArtifactEntry[]>([]);
  const [nodes, setNodes] = useState<StudioGraphNode[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [hasRiptide, setHasRiptide] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"refresh" | "queue-run" | "preview-report" | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reportPreview, setReportPreview] = useState<StudioReportPayload | null>(null);

  async function refresh(cancelled?: () => boolean) {
    setLoading(true);
    setLoadError(null);
    try {
      const [artifactRes, graphRes, jobsRes] = await Promise.all([
        api.artifacts(workspaceId),
        api.graph({ workspaceId }),
        api.jobs.list(workspaceId)
      ]);
      if (cancelled?.()) return;
      setArtifacts(artifactRes.artifacts);
      setNodes(graphRes.nodes);
      setJobs(jobsRes.jobs.filter((job) => job.workspace_id === workspaceId));
      setHasRiptide(artifactRes.has_riptide);
    } catch (err) {
      if (!cancelled?.()) setLoadError((err as Error).message);
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const metrics = useMemo(
    () => buildMetrics({ artifacts, nodes, jobs, hasRiptide }),
    [artifacts, nodes, jobs, hasRiptide]
  );
  const steps = useMemo(() => buildSteps(metrics), [metrics]);
  const doneCount = steps.filter((step) => step.done).length;
  const nextStepId = steps.find((step) => !step.done)?.id ?? steps[steps.length - 1]!.id;
  const selectedStep = steps.find((step) => step.id === (selectedStepId ?? nextStepId)) ?? steps[0]!;
  const progressPct = Math.round((doneCount / steps.length) * 100);

  async function refreshFromButton() {
    setBusyAction("refresh");
    setActionNotice(null);
    setActionError(null);
    await refresh();
    setBusyAction(null);
  }

  async function queueFirstRun() {
    setBusyAction("queue-run");
    setActionNotice(null);
    setActionError(null);
    try {
      const res = await api.jobs.create({ workspaceId, kind: "run", params: {} });
      setActionNotice(`Queued ${res.job.argv.join(" ")}`);
      onNavigate("jobs");
      await refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function previewLatestReport() {
    if (!metrics.latestReportArtifact) {
      onNavigate(metrics.runCount > 0 || metrics.activeJobCount > 0 ? "jobs" : "handoff");
      return;
    }
    setBusyAction("preview-report");
    setActionNotice(null);
    setActionError(null);
    try {
      const report = await api.report({
        workspaceId,
        artifactId: metrics.latestReportArtifact.id
      });
      setReportPreview(report);
      setActionNotice(`Loaded ${report.relative_path}`);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  function runStepAction(step: TutorialStep) {
    if (step.actionKind === "queue-run") {
      void queueFirstRun();
      return;
    }
    if (step.actionKind === "preview-report") {
      void previewLatestReport();
      return;
    }
    onNavigate(step.target);
  }

  return (
    <div>
      <PageLabel>TUTORIAL</PageLabel>

      <div className="card" style={{ padding: 24, marginBottom: 16 }}>
        <Kicker style={{ marginBottom: 8 }}>LIVE WORKSPACE TOUR</Kicker>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
          <div>
            <h2 style={{ font: "600 22px Inter", margin: "0 0 6px", color: "var(--rt-off-white)", letterSpacing: 0 }}>
              Walk the framework, end to end.
            </h2>
            <div style={{ font: '400 11.5px/1.5 "IBM Plex Mono"', color: "var(--rt-fog-dim)", wordBreak: "break-all" }}>
              {workspacePath}
            </div>
          </div>
          <span style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", whiteSpace: "nowrap" }}>
            {loading ? "syncing..." : `${doneCount} of ${steps.length} done`}
          </span>
        </div>
        <div style={{ height: 4, background: "var(--rt-slate-2)", borderRadius: 2, marginBottom: 24, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${progressPct}%`, background: "linear-gradient(90deg, var(--rt-teal), var(--rt-signal-cyan))" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(116px, 1fr))", gap: 8 }}>
          {steps.map((step) => {
            const isSelected = selectedStep.id === step.id;
            const isNext = nextStepId === step.id && !step.done;
            return (
              <button
                key={step.id}
                onClick={() => setSelectedStepId(step.id)}
                aria-pressed={isSelected}
                style={{
                  minHeight: 102,
                  padding: "13px 10px",
                  background: isSelected ? "var(--rt-slate-2)" : isNext ? "rgba(20,184,182,0.08)" : "transparent",
                  border: isSelected ? "1px solid var(--rt-teal)" : "1px solid var(--rt-slate-line)",
                  borderRadius: 8,
                  cursor: "pointer",
                  textAlign: "left",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: step.done ? "rgba(34,197,94,0.12)" : isNext ? "rgba(20,184,182,0.15)" : "var(--rt-slate-2)",
                    border: isNext ? "1px solid var(--rt-teal)" : "1px solid var(--rt-slate-line)",
                    color: step.done ? "var(--rt-pass)" : isNext ? "var(--rt-teal)" : "var(--rt-fog-dim)",
                    font: '500 11px "IBM Plex Mono"'
                  }}
                >
                  {step.done ? <Icon name="check" size={12} /> : step.id}
                </div>
                <div style={{ font: "500 12.5px/1.35 Inter", color: isSelected || isNext ? "var(--rt-off-white)" : "var(--rt-fog)" }}>
                  {step.label}
                </div>
                <div style={{ marginTop: "auto" }}>
                  <Pill kind={step.pillKind}>{step.pill}</Pill>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}>
        <div
          style={{
            background: "linear-gradient(135deg, var(--rt-slate-panel), var(--rt-deep-ocean))",
            padding: 24,
            position: "relative",
            minHeight: 250
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: "url(assets/hero-current.png)",
              backgroundSize: "cover",
              backgroundPosition: "right center",
              opacity: 0.22,
              pointerEvents: "none"
            }}
          />
          <div style={{ position: "relative", maxWidth: 680 }}>
            <Kicker style={{ marginBottom: 8 }}>STEP {selectedStep.id} OF {steps.length}</Kicker>
            <h2 style={{ font: "600 24px Inter", color: "var(--rt-off-white)", margin: "0 0 8px", letterSpacing: 0 }}>
              {selectedStep.title}
            </h2>
            <p style={{ font: "400 14px/1.6 Inter", color: "var(--rt-fg-2)", margin: "0 0 18px" }}>
              {selectedStep.body}
            </p>
            {loadError && (
              <div style={{ font: "400 13px/1.55 Inter", color: "var(--rt-fail)", marginBottom: 14 }}>
                {loadError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                className="btn btn--primary btn--sm"
                onClick={() => runStepAction(selectedStep)}
                disabled={busyAction !== null || loading}
              >
                <Icon name={selectedStep.icon} size={13} />
                {labelForPrimary(selectedStep, busyAction)}
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setSelectedStepId(nextStepId)}>
                <Icon name="target" size={12} />
                Next gap
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => void refreshFromButton()} disabled={busyAction !== null}>
                <Icon name="refresh" size={12} />
                Refresh
              </button>
            </div>
            {actionNotice && (
              <div style={{ font: '400 11.5px/1.5 "IBM Plex Mono"', color: "var(--rt-teal)", marginTop: 12 }}>
                {actionNotice}
              </div>
            )}
            {actionError && (
              <div style={{ font: "400 13px/1.5 Inter", color: "var(--rt-fail)", marginTop: 12 }}>
                {actionError}
              </div>
            )}
          </div>
        </div>
        {reportPreview && selectedStep.actionKind === "preview-report" && (
          <div style={{ padding: 18, borderTop: "1px solid var(--rt-slate-line)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
              <div>
                <Kicker style={{ marginBottom: 4 }}>REPORT PREVIEW</Kicker>
                <div style={{ font: '500 12px "IBM Plex Mono"', color: "var(--rt-off-white)" }}>{reportPreview.relative_path}</div>
              </div>
              <button className="btn btn--ghost btn--sm" onClick={() => onNavigate("reports")}>
                <Icon name="external" size={12} />
                Open Reports
              </button>
            </div>
            <div className="code" style={{ maxHeight: 320, overflowY: "auto", whiteSpace: "pre-wrap" }}>
              {previewBody(reportPreview)}
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        {GUIDE_SECTIONS.map((section, i) => (
          <div key={section.title} style={{ borderBottom: i === GUIDE_SECTIONS.length - 1 ? "none" : "1px solid var(--rt-slate-line)" }}>
            <button
              onClick={() => setOpenIdx(openIdx === i ? -1 : i)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "16px 20px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                font: "500 14px Inter",
                color: "var(--rt-off-white)"
              }}
            >
              <span style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", width: 24 }}>0{i + 1}</span>
              <span style={{ flex: 1 }}>{section.title}</span>
              <Icon
                name="chevronDown"
                size={14}
                color="var(--rt-fog-dim)"
                style={{ transform: openIdx === i ? "rotate(180deg)" : "" }}
              />
            </button>
            {openIdx === i && (
              <div style={{ padding: "0 20px 18px 56px", font: "400 14px/1.65 Inter", color: "var(--rt-fg-2)" }}>
                {section.body}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 18, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ font: "400 13px Inter", color: "var(--rt-fog-dim)" }}>Need more context?</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="btn btn--ghost btn--sm" href="https://github.com/riptidesim/riptide/tree/main/docs" target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={12} />
            Docs
          </a>
          <a className="btn btn--ghost btn--sm" href="https://github.com/riptidesim/riptide" target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={12} />
            GitHub
          </a>
          <a className="btn btn--ghost btn--sm" href="https://github.com/riptidesim/riptide/releases" target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={12} />
            Releases
          </a>
        </div>
      </div>
    </div>
  );
}

function buildMetrics(input: {
  artifacts: StudioArtifactEntry[];
  nodes: StudioGraphNode[];
  jobs: Job[];
  hasRiptide: boolean;
}): TutorialMetrics {
  const adapterCount = Math.max(
    input.nodes.filter((node) => node.kind === "adapter").length,
    input.artifacts.filter((artifact) => artifact.kind === "adapter").length
  );
  const scenarioCount = Math.max(
    input.nodes.filter((node) => node.kind === "scenario").length,
    input.artifacts.filter((artifact) => artifact.kind === "scenario").length
  );
  const reportArtifacts = input.artifacts.filter((artifact) => REPORT_KINDS.has(artifact.kind));
  const runArtifacts = input.artifacts.filter((artifact) => RUN_KINDS.has(artifact.kind));
  const activeJobs = input.jobs.filter((job) => job.status === "queued" || job.status === "running");
  const runJobs = input.jobs.filter((job) => job.kind === "run" || job.kind === "campaign-run" || job.kind === "replay");

  return {
    hasRiptide: input.hasRiptide,
    adapterCount,
    personaCount: input.nodes.filter((node) => node.kind === "persona").length,
    scenarioCount,
    invariantCount: input.nodes.filter((node) => node.kind === "invariant").length,
    runCount: runArtifacts.length,
    reportCount: reportArtifacts.length,
    activeJobCount: activeJobs.length,
    hasSucceededRunJob: runJobs.some((job) => job.status === "succeeded"),
    latestReportArtifact: newestArtifact(reportArtifacts)
  };
}

function buildSteps(metrics: TutorialMetrics): TutorialStep[] {
  const hasAdapter = metrics.adapterCount > 0;
  const hasScenario = metrics.scenarioCount > 0;
  const hasRun = metrics.runCount > 0 || metrics.hasSucceededRunJob;
  const canQueueRun = hasAdapter && hasScenario && metrics.activeJobCount === 0;

  return [
    {
      id: 1,
      label: "Workspace",
      title: metrics.hasRiptide ? "Workspace scaffold is present." : "Scaffold this workspace first.",
      body: metrics.hasRiptide
        ? "Studio can read .riptide for this workspace. The remaining steps reflect the live graph, artifacts, and job queue."
        : "Studio did not find a .riptide directory for this workspace. Use the first-run wizard or Agent chat to bootstrap it.",
      done: metrics.hasRiptide,
      target: "settings",
      actionKind: "navigate",
      actionLabel: metrics.hasRiptide ? "Open Settings" : "Open Settings",
      icon: "settings",
      pill: metrics.hasRiptide ? "READY" : "MISSING",
      pillKind: metrics.hasRiptide ? "pass" : "warn"
    },
    {
      id: 2,
      label: "Adapter",
      title: hasAdapter ? "Adapter is wired into the graph." : "Wire the protocol adapter.",
      body: hasAdapter
        ? `Studio found ${formatCount(metrics.adapterCount, "adapter")} for this workspace. Inspect the graph-derived manifest before running scenarios.`
        : "No adapter node or adapter artifact was found. Configure the adapter so Riptide knows how to drive the program.",
      done: hasAdapter,
      target: hasAdapter ? "adapter" : "handoff",
      actionKind: "navigate",
      actionLabel: hasAdapter ? "Open Adapter" : "Configure with agent",
      icon: hasAdapter ? "plug" : "sparkles",
      pill: hasAdapter ? `${metrics.adapterCount}` : "TODO",
      pillKind: hasAdapter ? "pass" : "queued"
    },
    {
      id: 3,
      label: "Personas",
      title: metrics.personaCount > 0 ? "Personas are available." : "Define the actors.",
      body: metrics.personaCount > 0
        ? `The adapter graph exposes ${formatCount(metrics.personaCount, "persona")}. These actors are what drive actions during the run.`
        : "No persona nodes are visible yet. Add personas to the adapter or ask the agent to draft them from the protocol behavior.",
      done: metrics.personaCount > 0,
      target: metrics.personaCount > 0 ? "library" : "handoff",
      actionKind: "navigate",
      actionLabel: metrics.personaCount > 0 ? "Open Library" : "Draft personas",
      icon: metrics.personaCount > 0 ? "users" : "sparkles",
      pill: metrics.personaCount > 0 ? `${metrics.personaCount}` : "TODO",
      pillKind: metrics.personaCount > 0 ? "pass" : "queued"
    },
    {
      id: 4,
      label: "Scenario",
      title: hasScenario ? "A scenario is ready to run." : "Write the first scenario.",
      body: hasScenario
        ? `Studio found ${formatCount(metrics.scenarioCount, "scenario")} under the workspace graph or artifact index.`
        : "No scenario is visible yet. A scenario gives the engine a seed, tick budget, persona mix, and target behavior to exercise.",
      done: hasScenario,
      target: hasScenario ? "library" : "handoff",
      actionKind: "navigate",
      actionLabel: hasScenario ? "Open Scenarios" : "Write with agent",
      icon: hasScenario ? "play" : "sparkles",
      pill: hasScenario ? `${metrics.scenarioCount}` : "TODO",
      pillKind: hasScenario ? "pass" : "queued"
    },
    {
      id: 5,
      label: "Run",
      title: hasRun ? "Run evidence exists." : metrics.activeJobCount > 0 ? "A job is already running." : "Run the first scenario.",
      body: hasRun
        ? `Studio found ${formatCount(metrics.runCount, "run artifact")} and ${metrics.activeJobCount} active jobs for this workspace.`
        : metrics.activeJobCount > 0
        ? "A queued or running Studio job is already active. Open the queue to watch stdout, stderr, and completion state."
        : canQueueRun
        ? "Queue an allowlisted `riptide run --quiet` job from Studio. The server maps this button to structured argv; no shell endpoint is exposed."
        : "Create an adapter and scenario first. Studio will not queue a run until there is something concrete to execute.",
      done: hasRun,
      target: metrics.activeJobCount > 0 ? "jobs" : canQueueRun ? "jobs" : "handoff",
      actionKind: metrics.activeJobCount > 0 ? "navigate" : canQueueRun ? "queue-run" : "navigate",
      actionLabel: metrics.activeJobCount > 0 ? "Open queue" : canQueueRun ? "Queue run" : "Prepare with agent",
      icon: metrics.activeJobCount > 0 ? "listTodo" : canQueueRun ? "play" : "sparkles",
      pill: hasRun ? `${metrics.runCount}` : metrics.activeJobCount > 0 ? "RUNNING" : "TODO",
      pillKind: hasRun ? "pass" : metrics.activeJobCount > 0 ? "running" : "queued"
    },
    {
      id: 6,
      label: "Report",
      title: metrics.reportCount > 0 ? "A report can be read now." : "Generate or inspect a report.",
      body: metrics.latestReportArtifact
        ? `Latest readable artifact: ${metrics.latestReportArtifact.label} at ${metrics.latestReportArtifact.relative_path}.`
        : "No report-capable artifacts are indexed yet. Run a scenario, replay, campaign, or readiness check to produce one.",
      done: metrics.reportCount > 0,
      target: metrics.reportCount > 0 ? "reports" : hasRun || metrics.activeJobCount > 0 ? "jobs" : "handoff",
      actionKind: metrics.reportCount > 0 ? "preview-report" : "navigate",
      actionLabel: metrics.reportCount > 0 ? "Preview latest" : hasRun || metrics.activeJobCount > 0 ? "Open queue" : "Create evidence",
      icon: metrics.reportCount > 0 ? "fileText" : hasRun || metrics.activeJobCount > 0 ? "listTodo" : "sparkles",
      pill: metrics.reportCount > 0 ? `${metrics.reportCount}` : "TODO",
      pillKind: metrics.reportCount > 0 ? "pass" : "queued"
    },
    {
      id: 7,
      label: "Invariants",
      title: metrics.invariantCount > 0 ? "Invariants are locked into the graph." : "Add invariants before CI.",
      body: metrics.invariantCount > 0
        ? `Studio found ${formatCount(metrics.invariantCount, "invariant")}. Review their predicates before treating a run as CI evidence.`
        : "No invariant nodes are visible. Add falsifiable economic predicates so runs fail loudly when behavior drifts.",
      done: metrics.invariantCount > 0,
      target: metrics.invariantCount > 0 ? "library" : "handoff",
      actionKind: "navigate",
      actionLabel: metrics.invariantCount > 0 ? "Open Invariants" : "Draft invariants",
      icon: metrics.invariantCount > 0 ? "shield" : "sparkles",
      pill: metrics.invariantCount > 0 ? `${metrics.invariantCount}` : "TODO",
      pillKind: metrics.invariantCount > 0 ? "pass" : "queued"
    }
  ];
}

function labelForPrimary(step: TutorialStep, busyAction: "refresh" | "queue-run" | "preview-report" | null): string {
  if (step.actionKind === "queue-run" && busyAction === "queue-run") return "Queueing...";
  if (step.actionKind === "preview-report" && busyAction === "preview-report") return "Loading...";
  return step.actionLabel;
}

function formatCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function newestArtifact(artifacts: StudioArtifactEntry[]): StudioArtifactEntry | null {
  return [...artifacts].sort((a, b) => timestamp(b.updated_at) - timestamp(a.updated_at))[0] ?? null;
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function previewBody(report: StudioReportPayload): string {
  const body = report.body.trim();
  if (body.length <= 2200) return body;
  return `${body.slice(0, 2200)}\n\n...`;
}

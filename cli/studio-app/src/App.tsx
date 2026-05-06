import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  type ArtifactIndex,
  type Health,
  type JobListPayload,
  type Workspace
} from "./api";
import { Sidebar, type ViewKey } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { OverviewView } from "./views/OverviewView";
import { LibraryView } from "./views/LibraryView";
import { ReportView } from "./views/ReportView";
import { DiagramView } from "./views/DiagramView";
import { DashboardView } from "./views/DashboardView";
import { LaunchView } from "./views/LaunchView";
import { ConfigView } from "./views/ConfigView";

interface AppState {
  health: Health | null;
  workspaces: Workspace[];
  workspaceId: string;
  artifacts: ArtifactIndex | null;
  artifactsError: string | null;
  jobs: JobListPayload | null;
  view: ViewKey;
  selectedArtifactId: string | null;
}

export function App() {
  const [state, setState] = useState<AppState>({
    health: null,
    workspaces: [],
    workspaceId: "",
    artifacts: null,
    artifactsError: null,
    jobs: null,
    view: "overview",
    selectedArtifactId: null
  });
  const [loadError, setLoadError] = useState<string | null>(null);

  // Initial load: health + workspaces.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [health, workspaces] = await Promise.all([api.health(), api.workspaces()]);
        if (cancelled) return;
        const initialId = workspaces[0]?.id ?? "";
        setState((prev) => ({
          ...prev,
          health,
          workspaces,
          workspaceId: prev.workspaceId || initialId
        }));
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever the workspace changes, refresh artifacts.
  useEffect(() => {
    if (!state.workspaceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const artifacts = await api.artifacts(state.workspaceId);
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          artifacts,
          artifactsError: null,
          selectedArtifactId: prev.selectedArtifactId
            ? artifacts.artifacts.some((a) => a.id === prev.selectedArtifactId)
              ? prev.selectedArtifactId
              : null
            : null
        }));
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            artifacts: null,
            artifactsError: (err as Error).message
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.workspaceId]);

  // Refresh jobs periodically.
  const refreshJobs = useCallback(async () => {
    try {
      const jobs = await api.jobs();
      setState((prev) => ({ ...prev, jobs }));
    } catch {
      // surface in Launch view; do not block the rest of the UI
    }
  }, []);
  useEffect(() => {
    void refreshJobs();
    const id = window.setInterval(refreshJobs, 4000);
    return () => window.clearInterval(id);
  }, [refreshJobs]);

  const setWorkspaceId = useCallback((workspaceId: string) => {
    setState((prev) => ({ ...prev, workspaceId, selectedArtifactId: null }));
  }, []);
  const setView = useCallback((view: ViewKey) => {
    setState((prev) => ({ ...prev, view }));
  }, []);
  const setSelectedArtifactId = useCallback((id: string | null) => {
    setState((prev) => ({ ...prev, selectedArtifactId: id }));
  }, []);
  const openArtifactReport = useCallback((id: string) => {
    setState((prev) => ({ ...prev, view: "report", selectedArtifactId: id }));
  }, []);
  const openArtifactDashboard = useCallback((relativePath: string) => {
    setState((prev) => ({
      ...prev,
      view: "dashboard",
      selectedArtifactId: relativePath
    }));
  }, []);

  const sidebarCounts = useMemo(() => {
    const artifacts = state.artifacts?.artifacts ?? [];
    const jobs = state.jobs?.jobs ?? [];
    const reports = artifacts.filter((a) =>
      ["run", "campaign-root", "pack", "guided-sim", "readiness-report", "markdown-summary"].includes(a.kind)
    );
    return {
      overview: artifacts.length,
      library: artifacts.length,
      report: reports.length,
      diagram: artifacts.filter((a) => a.kind === "adapter" || a.kind === "scenario" || a.kind === "campaign-input")
        .length,
      dashboard: artifacts.filter((a) => a.kind === "run" || a.kind === "run-collection" || a.kind === "pack").length,
      launch: jobs.filter((j) => j.status === "queued" || j.status === "running").length,
      config: 0
    };
  }, [state.artifacts, state.jobs]);

  const selectedWorkspace = state.workspaces.find((w) => w.id === state.workspaceId) ?? null;

  if (loadError) {
    return (
      <div className="rt-shell">
        <div className="rt-topbar">
          <span className="rt-brand">
            <strong>RIPTIDE</strong>&nbsp;STUDIO
          </span>
        </div>
        <aside className="rt-side" />
        <main className="rt-main">
          <div className="rt-page-kicker">CONNECTION</div>
          <h1>Studio could not reach the local server.</h1>
          <p>{loadError}</p>
          <p>Confirm <code className="rt-code-inline">riptide studio</code> is running and reload.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="rt-shell">
      <TopBar
        workspaces={state.workspaces}
        workspaceId={state.workspaceId}
        onSelectWorkspace={setWorkspaceId}
        health={state.health}
        artifacts={state.artifacts}
        jobs={state.jobs}
      />
      <Sidebar view={state.view} onSelect={setView} counts={sidebarCounts} />
      <main className="rt-main">
        {renderView({
          view: state.view,
          workspace: selectedWorkspace,
          artifacts: state.artifacts,
          artifactsError: state.artifactsError,
          jobs: state.jobs,
          selectedArtifactId: state.selectedArtifactId,
          openArtifactReport,
          openArtifactDashboard,
          setSelectedArtifactId,
          refreshJobs,
          setView
        })}
      </main>
    </div>
  );
}

interface RenderArgs {
  view: ViewKey;
  workspace: Workspace | null;
  artifacts: ArtifactIndex | null;
  artifactsError: string | null;
  jobs: JobListPayload | null;
  selectedArtifactId: string | null;
  openArtifactReport: (id: string) => void;
  openArtifactDashboard: (relativePath: string) => void;
  setSelectedArtifactId: (id: string | null) => void;
  refreshJobs: () => Promise<void>;
  setView: (view: ViewKey) => void;
}

function renderView(args: RenderArgs) {
  const { view, workspace, artifacts, artifactsError, jobs, selectedArtifactId } = args;
  if (!workspace) {
    return (
      <>
        <div className="rt-page-kicker">WORKSPACES</div>
        <h1>Loading workspace…</h1>
      </>
    );
  }
  switch (view) {
    case "overview":
      return (
        <OverviewView
          workspace={workspace}
          artifacts={artifacts}
          artifactsError={artifactsError}
          jobs={jobs}
          openArtifactReport={args.openArtifactReport}
          setView={args.setView}
        />
      );
    case "library":
      return (
        <LibraryView
          workspace={workspace}
          artifacts={artifacts}
          artifactsError={artifactsError}
          openArtifactReport={args.openArtifactReport}
          openArtifactDashboard={args.openArtifactDashboard}
        />
      );
    case "report":
      return (
        <ReportView
          workspace={workspace}
          artifacts={artifacts}
          selectedArtifactId={selectedArtifactId}
          onSelect={args.setSelectedArtifactId}
        />
      );
    case "diagram":
      return <DiagramView workspace={workspace} />;
    case "dashboard":
      return (
        <DashboardView
          workspace={workspace}
          artifacts={artifacts}
          selectedSource={selectedArtifactId}
          onSelect={args.setSelectedArtifactId}
        />
      );
    case "launch":
      return (
        <LaunchView
          workspace={workspace}
          artifacts={artifacts}
          jobs={jobs}
          refreshJobs={args.refreshJobs}
        />
      );
    case "config":
      return <ConfigView workspace={workspace} artifacts={artifacts} />;
    default:
      return null;
  }
}

import { useCallback, useEffect, useState } from "react";

import { api, type AgentProbe, type StudioWorkspace } from "./api";
import { useAgentPreference } from "./useAgentPreference";
import { WorkspaceRail } from "./shell/Rail";
import { Sidebar, type SidebarCounts } from "./shell/Sidebar";
import { FirstRunWizard } from "./shell/FirstRunWizard";
import { AddProjectWizard } from "./shell/AddProjectWizard";
import { CommandPalette } from "./shell/CommandPalette";
import { HelpOverlay } from "./shell/HelpOverlay";
import { readStudioPage, readStudioWorkspace, writeStudioLocation } from "./shell/location";
import { type PageId } from "./shell/types";
import type { StudioArtifactKind } from "./studioTypes";

import { OverviewPage } from "./pages/OverviewPage";
import { HandoffPage } from "./pages/HandoffPage";
import { AdapterPage } from "./pages/AdapterPage";
import { CampaignsPage } from "./pages/CampaignsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { JobsPage } from "./pages/JobsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { TutorialPage } from "./pages/TutorialPage";
import { SettingsPage } from "./pages/SettingsPage";

const REPORT_KINDS = new Set<StudioArtifactKind>([
  "run-collection",
  "last-run",
  "run",
  "campaign-root",
  "retained-case",
  "pack",
  "readiness-report",
  "markdown-summary",
  "guided-sim",
  "scenario",
  "adapter",
  "campaign-input"
]);

function isManagedWorkspace(workspace: StudioWorkspace): boolean {
  return workspace.has_riptide && Boolean(
    workspace.registry_id ||
    workspace.source === "registered" ||
    workspace.source === "case-study"
  );
}

function workspaceNeedsFirstRun(active: StudioWorkspace | null, workspaces: StudioWorkspace[] | null): boolean {
  if (!active || isManagedWorkspace(active)) return false;
  return !(workspaces ?? []).some(isManagedWorkspace);
}

function selectWorkspaceAfterRemoval(workspaces: StudioWorkspace[], removedIndex: number): number {
  if (workspaces.length === 0) return -1;
  const preferred = removedIndex > 0
    ? Math.min(removedIndex - 1, workspaces.length - 1)
    : 0;
  if (workspaces[preferred] && isManagedWorkspace(workspaces[preferred])) return preferred;

  for (let distance = 1; distance < workspaces.length; distance += 1) {
    const above = preferred - distance;
    if (above >= 0 && workspaces[above] && isManagedWorkspace(workspaces[above])) return above;
    const below = preferred + distance;
    if (below < workspaces.length && workspaces[below] && isManagedWorkspace(workspaces[below])) return below;
  }
  return preferred;
}

export function App() {
  const [page, setPage] = useState<PageId>(() => readStudioPage());
  const [activeWs, setActiveWs] = useState(0);
  const [workspaces, setWorkspaces] = useState<StudioWorkspace[] | null>(null);
  const [agents, setAgents] = useState<AgentProbe[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [counts, setCounts] = useState<SidebarCounts>({});
  const [pendingArtifact, setPendingArtifact] = useState<{ id: string; nonce: number } | null>(null);

  useEffect(() => {
    api.workspaces().then((r) => setWorkspaces(r.workspaces)).catch((e) => setLoadError((e as Error).message));
  }, []);

  useEffect(() => {
    api.agents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!workspaces) return;
    const workspaceId = readStudioWorkspace();
    if (!workspaceId) return;
    const idx = workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (idx >= 0 && idx !== activeWs) setActiveWs(idx);
  }, [activeWs, workspaces]);

  useEffect(() => {
    function onPopState() {
      setPage(readStudioPage());
      const workspaceId = readStudioWorkspace();
      if (!workspaces) return;
      if (!workspaceId) {
        setActiveWs(0);
        return;
      }
      const idx = workspaces.findIndex((workspace) => workspace.id === workspaceId);
      if (idx >= 0) setActiveWs(idx);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [workspaces]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const cmdK = (isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "k";
      if (cmdK) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? "";
      const inEditable = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || !!t?.isContentEditable;
      if (e.key === "/" && !paletteOpen && !inEditable) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.key === "?" && !paletteOpen && !inEditable) {
        e.preventDefault();
        setHelpOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  async function refreshAgents() {
    const r = await api.agents();
    setAgents(r.agents);
    return r.agents;
  }

  // Compute a stable workspace path before any conditional return so the
  // useAgentPreference hook always runs in the same order. Empty string
  // means "no workspace yet" — the hook will simply read/write that key
  // until we have a real workspace.
  const primary = workspaces?.[0] ?? null;
  const active = primary ? (workspaces?.[activeWs] ?? primary) : null;
  const needsFirstRun = workspaceNeedsFirstRun(active, workspaces);
  const { pref, setPref } = useAgentPreference(active?.path ?? "", agents);

  useEffect(() => {
    if (!active?.id || needsFirstRun) {
      setCounts({});
      return;
    }
    let cancelled = false;
    Promise.all([
      api.artifacts(active.id),
      api.jobs.list(active.id),
      api.graph({ workspaceId: active.id })
    ])
      .then(([artifactsRes, jobsRes, graphRes]) => {
        if (cancelled) return;
        const artifacts = artifactsRes.artifacts;
        const workspaceJobs = jobsRes.jobs.filter((job) => job.workspace_id === active.id);
        const activeJobs = workspaceJobs.filter((job) => job.status === "queued" || job.status === "running");
        const libraryNodes = graphRes.nodes.filter(
          (node) => node.kind === "persona" || node.kind === "scenario" || node.kind === "invariant"
        );
        setCounts({
          campaigns: artifacts.filter(
            (artifact) => artifact.kind === "campaign-input" || artifact.kind === "campaign-root"
          ).length,
          library: libraryNodes.length,
          jobs: activeJobs.length,
          reports: artifacts.filter((artifact) => REPORT_KINDS.has(artifact.kind)).length
        });
      })
      .catch(() => {
        if (!cancelled) setCounts({});
      });
    return () => {
      cancelled = true;
    };
  }, [active?.id, page, needsFirstRun]);

  const navigateToPage = useCallback((nextPage: PageId) => {
    setPage(nextPage);
    writeStudioLocation(nextPage, active?.id ?? readStudioWorkspace(), "push");
  }, [active?.id]);

  const switchWorkspace = useCallback((idx: number) => {
    const next = workspaces?.[idx];
    if (!next) return;
    setActiveWs(idx);
    writeStudioLocation(page, next.id, "push");
  }, [page, workspaces]);

  const removeWorkspace = useCallback(async (target: StudioWorkspace) => {
    const registryId = target.registry_id ?? (target.source === "registered" ? target.id : null);
    if (!registryId) {
      throw new Error("This workspace is not remembered in Studio's registry.");
    }
    const activeId = workspaces?.[activeWs]?.id ?? null;
    const removedIdx = workspaces?.findIndex((w) => w.id === target.id) ?? activeWs;
    const res = await api.removeProject(registryId);
    const next = res.workspaces;
    setWorkspaces(next);
    const sameIdx = activeId ? next.findIndex((w) => w.id === activeId) : -1;
    const removedActiveWorkspace = activeId === target.id;
    if (!removedActiveWorkspace && sameIdx >= 0) {
      setActiveWs(sameIdx);
      writeStudioLocation(page, next[sameIdx]?.id ?? null, "replace");
    } else {
      const fallbackIdx = selectWorkspaceAfterRemoval(next, removedIdx);
      setActiveWs(Math.max(fallbackIdx, 0));
      writeStudioLocation(page, fallbackIdx >= 0 ? next[fallbackIdx]?.id ?? null : null, "replace");
    }
  }, [activeWs, page, workspaces]);

  const openArtifact = useCallback((artifactId: string) => {
    setPage("reports");
    writeStudioLocation("reports", active?.id ?? readStudioWorkspace(), "push", { artifactId });
    setPendingArtifact({ id: artifactId, nonce: Date.now() });
  }, [active?.id]);

  if (loadError) return <FullPageMessage title="Studio API unreachable" body={loadError} />;
  if (workspaces === null) return <FullPageMessage title="Loading workspace…" body="Talking to the Studio server." />;
  if (!primary || !active) return <FullPageMessage title="No workspace registered" body="Restart `riptide studio` from a project directory." />;

  if (needsFirstRun) {
    return (
      <FirstRunWizard
        workspace={active}
        onDone={(next, activeWorkspaceId) => {
          setWorkspaces(next);
          const idx = activeWorkspaceId
            ? next.findIndex((w) => w.id === activeWorkspaceId)
            : next.findIndex((w) => w.id === active.id);
          if (idx >= 0) {
            setActiveWs(idx);
            writeStudioLocation(page, next[idx]?.id ?? null, "replace");
          }
        }}
        onPickAgent={setPref}
      />
    );
  }

  function handleProjectCreated(next: StudioWorkspace[], newId: string | null) {
    setWorkspaces(next);
    setAddOpen(false);
    if (newId) {
      const idx = next.findIndex((w) => w.id === newId);
      if (idx >= 0) {
        setActiveWs(idx);
        writeStudioLocation(page, next[idx]?.id ?? null, "push");
      }
    }
  }

  let body;
  switch (page) {
    case "overview":  body = <OverviewPage workspaceId={active.id} onNavigate={navigateToPage} />; break;
    case "handoff":   body = <HandoffPage pref={pref} setPref={setPref} agents={agents} workspaceId={active.id} workspacePath={active.path} />; break;
    case "adapter":   body = <AdapterPage workspaceId={active.id} onNavigate={navigateToPage} />; break;
    case "campaigns": body = <CampaignsPage workspaceId={active.id} onNavigate={navigateToPage} />; break;
    case "library":   body = <LibraryPage workspaceId={active.id} onNavigate={navigateToPage} />; break;
    case "jobs":      body = <JobsPage workspaceId={active.id} onNavigate={navigateToPage} />; break;
    case "reports":   body = <ReportsPage workspaceId={active.id} onNavigate={navigateToPage} pendingArtifact={pendingArtifact} />; break;
    case "tutorial":  body = <TutorialPage workspaceId={active.id} workspacePath={active.path} onNavigate={navigateToPage} />; break;
    case "settings":  body = <SettingsPage agents={agents} onReprobe={refreshAgents} workspace={active} pref={pref} setPref={setPref} onRemoveWorkspace={removeWorkspace} />; break;
  }

  return (
    <div className="studio">
      <WorkspaceRail
        workspaces={workspaces}
        activeIdx={activeWs}
        setActiveIdx={switchWorkspace}
        onAddWorkspace={() => setAddOpen(true)}
      />
      <Sidebar
        page={page}
        setPage={navigateToPage}
        ws={active}
        agents={agents}
        pref={pref}
        setPref={setPref}
        onOpenSearch={() => setPaletteOpen(true)}
        counts={counts}
      />
      <main className="main">{body}</main>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        workspaces={workspaces}
        agents={agents}
        activeWs={activeWs}
        onNavigate={navigateToPage}
        onSwitchWorkspace={switchWorkspace}
        onOpenArtifact={openArtifact}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      {addOpen && (
        <AddProjectWizard
          onClose={() => setAddOpen(false)}
          onCreated={handleProjectCreated}
        />
      )}
    </div>
  );
}

function FullPageMessage({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", padding: 32, gap: 8, color: "var(--rt-fog)" }}>
      <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)" }}>{title}</div>
      <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>{body}</div>
    </div>
  );
}

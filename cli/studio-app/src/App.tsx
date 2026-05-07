import { useCallback, useEffect, useState } from "react";

import { api, type AgentProbe, type StudioWorkspace } from "./api";
import { useAgentPreference } from "./useAgentPreference";
import { WorkspaceRail } from "./shell/Rail";
import { Sidebar } from "./shell/Sidebar";
import { FirstRunWizard } from "./shell/FirstRunWizard";
import { AddProjectWizard } from "./shell/AddProjectWizard";
import { CommandPalette } from "./shell/CommandPalette";
import { readStudioPage, readStudioWorkspace, writeStudioLocation } from "./shell/location";
import { type PageId } from "./shell/types";

import { OverviewPage } from "./pages/OverviewPage";
import { HandoffPage } from "./pages/HandoffPage";
import { AdapterPage } from "./pages/AdapterPage";
import { CampaignsPage } from "./pages/CampaignsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { JobsPage } from "./pages/JobsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { TutorialPage } from "./pages/TutorialPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const [page, setPage] = useState<PageId>(() => readStudioPage());
  const [activeWs, setActiveWs] = useState(0);
  const [workspaces, setWorkspaces] = useState<StudioWorkspace[] | null>(null);
  const [agents, setAgents] = useState<AgentProbe[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

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
      if (e.key === "/" && !paletteOpen) {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName ?? "";
        if (!/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && !t?.isContentEditable) {
          e.preventDefault();
          setPaletteOpen(true);
        }
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
  const { pref, setPref } = useAgentPreference(active?.path ?? "", agents);

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

  if (loadError) return <FullPageMessage title="Studio API unreachable" body={loadError} />;
  if (workspaces === null) return <FullPageMessage title="Loading workspace…" body="Talking to the Studio server." />;
  if (!primary || !active) return <FullPageMessage title="No workspace registered" body="Restart `riptide studio` from a project directory." />;

  if (!active.has_riptide) {
    return (
      <FirstRunWizard
        workspace={active}
        onDone={(next) => {
          setWorkspaces(next);
          const idx = next.findIndex((w) => w.id === active.id);
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
    case "reports":   body = <ReportsPage workspaceId={active.id} onNavigate={navigateToPage} />; break;
    case "tutorial":  body = <TutorialPage workspaceId={active.id} workspacePath={active.path} onNavigate={navigateToPage} />; break;
    case "settings":  body = <SettingsPage agents={agents} onReprobe={refreshAgents} workspace={active} pref={pref} setPref={setPref} />; break;
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
      />
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

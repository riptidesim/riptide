import { useEffect, useState } from "react";

import { api, type StudioWorkspace } from "./api";
import { WorkspaceRail } from "./shell/Rail";
import { Sidebar } from "./shell/Sidebar";
import { FirstRunWizard } from "./shell/FirstRunWizard";
import { WORKSPACES, type PageId } from "./shell/types";

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
  const [page, setPage] = useState<PageId>("overview");
  const [activeWs, setActiveWs] = useState(0);
  const [workspaces, setWorkspaces] = useState<StudioWorkspace[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api.workspaces().then((r) => setWorkspaces(r.workspaces)).catch((e) => setLoadError((e as Error).message));
  }, []);

  if (loadError) return <FullPageMessage title="Studio API unreachable" body={loadError} />;
  if (workspaces === null) return <FullPageMessage title="Loading workspace…" body="Talking to the Studio server." />;

  const primary = workspaces[0];
  if (!primary) return <FullPageMessage title="No workspace registered" body="Restart `riptide studio` from a project directory." />;

  if (!primary.has_riptide) {
    return <FirstRunWizard workspace={primary} onDone={(next) => setWorkspaces(next)} />;
  }

  const populated = false;
  let body;
  switch (page) {
    case "overview":  body = <OverviewPage populated={populated} onNavigate={setPage} />; break;
    case "handoff":   body = <HandoffPage />; break;
    case "adapter":   body = <AdapterPage populated={populated} onNavigate={setPage} />; break;
    case "campaigns": body = <CampaignsPage populated={populated} />; break;
    case "library":   body = <LibraryPage populated={populated} />; break;
    case "jobs":      body = <JobsPage populated={populated} />; break;
    case "reports":   body = <ReportsPage populated={populated} />; break;
    case "tutorial":  body = <TutorialPage />; break;
    case "settings":  body = <SettingsPage />; break;
  }

  return (
    <div className="studio">
      <WorkspaceRail activeIdx={activeWs} setActiveIdx={setActiveWs} />
      <Sidebar page={page} setPage={setPage} ws={WORKSPACES[activeWs]} />
      <main className="main">{body}</main>
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

import { useState } from "react";

import { WorkspaceRail } from "./shell/Rail";
import { Sidebar } from "./shell/Sidebar";
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
  const populated = true;

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

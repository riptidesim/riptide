import { useEffect, useState } from "react";

import { api } from "../api";
import type { StudioGraphNode } from "../studioTypes";
import { PageLabel } from "../ui/primitives";
import { TabStrip } from "../ui/TabStrip";
import type { PageId } from "../shell/types";
import { PersonasPage } from "./PersonasPage";
import { ScenariosPage } from "./ScenariosPage";
import { InvariantsPage } from "./InvariantsPage";

type LibraryTab = "personas" | "scenarios" | "invariants";

interface LibraryPageProps {
  workspaceId: string;
  onNavigate?: (id: PageId) => void;
}

export function LibraryPage({ workspaceId, onNavigate }: LibraryPageProps) {
  const [tab, setTab] = useState<LibraryTab>("personas");
  const [nodes, setNodes] = useState<StudioGraphNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNodes([]);
    api.graph({ workspaceId })
      .then((graph) => {
        if (!cancelled) setNodes(graph.nodes);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const personas = nodes.filter((node) => node.kind === "persona");
  const scenarios = nodes.filter((node) => node.kind === "scenario");
  const invariants = nodes.filter((node) => node.kind === "invariant");

  return (
    <div>
      <PageLabel>LIBRARY</PageLabel>
      <TabStrip
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "personas", label: "Personas", count: loading ? undefined : personas.length },
          { id: "scenarios", label: "Scenarios", count: loading ? undefined : scenarios.length },
          { id: "invariants", label: "Invariants", count: loading ? undefined : invariants.length }
        ]}
      />
      {tab === "personas" && <PersonasPage nodes={personas} loading={loading} error={error} onNavigate={onNavigate} embedded />}
      {tab === "scenarios" && <ScenariosPage nodes={scenarios} loading={loading} error={error} onNavigate={onNavigate} embedded />}
      {tab === "invariants" && <InvariantsPage nodes={invariants} loading={loading} error={error} onNavigate={onNavigate} embedded />}
    </div>
  );
}

import { useState } from "react";

import { PageLabel } from "../ui/primitives";
import { TabStrip } from "../ui/TabStrip";
import { PersonasPage } from "./PersonasPage";
import { ScenariosPage } from "./ScenariosPage";
import { InvariantsPage } from "./InvariantsPage";

type LibraryTab = "personas" | "scenarios" | "invariants";

export function LibraryPage({ populated }: { populated: boolean }) {
  const [tab, setTab] = useState<LibraryTab>("personas");
  return (
    <div>
      <PageLabel>LIBRARY</PageLabel>
      <TabStrip
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "personas", label: "Personas", count: 12 },
          { id: "scenarios", label: "Scenarios", count: 8 },
          { id: "invariants", label: "Invariants", count: 47 }
        ]}
      />
      {tab === "personas" && <PersonasPage populated={populated} embedded />}
      {tab === "scenarios" && <ScenariosPage populated={populated} embedded />}
      {tab === "invariants" && <InvariantsPage populated={populated} embedded />}
    </div>
  );
}

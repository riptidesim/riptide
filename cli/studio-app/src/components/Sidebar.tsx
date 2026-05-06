export type ViewKey =
  | "overview"
  | "library"
  | "report"
  | "diagram"
  | "dashboard"
  | "launch"
  | "config";

interface SidebarItem {
  key: ViewKey;
  label: string;
  group: "workspace" | "evidence" | "control";
}

const ITEMS: SidebarItem[] = [
  { key: "overview", label: "Overview", group: "workspace" },
  { key: "library", label: "Evidence library", group: "evidence" },
  { key: "report", label: "Report viewer", group: "evidence" },
  { key: "diagram", label: "Simulation diagram", group: "evidence" },
  { key: "dashboard", label: "Dashboard drilldown", group: "evidence" },
  { key: "launch", label: "Launch jobs", group: "control" },
  { key: "config", label: "Config handoff", group: "control" }
];

interface Props {
  view: ViewKey;
  onSelect: (view: ViewKey) => void;
  counts: Record<ViewKey, number>;
}

export function Sidebar({ view, onSelect, counts }: Props) {
  return (
    <aside className="rt-side">
      <div className="rt-side-section">Workspace</div>
      {ITEMS.filter((i) => i.group === "workspace").map((item) => (
        <NavBtn key={item.key} item={item} active={view === item.key} count={counts[item.key]} onSelect={onSelect} />
      ))}
      <div className="rt-side-section">Evidence</div>
      {ITEMS.filter((i) => i.group === "evidence").map((item) => (
        <NavBtn key={item.key} item={item} active={view === item.key} count={counts[item.key]} onSelect={onSelect} />
      ))}
      <div className="rt-side-section">Control plane</div>
      {ITEMS.filter((i) => i.group === "control").map((item) => (
        <NavBtn key={item.key} item={item} active={view === item.key} count={counts[item.key]} onSelect={onSelect} />
      ))}
    </aside>
  );
}

function NavBtn({
  item,
  active,
  count,
  onSelect
}: {
  item: SidebarItem;
  active: boolean;
  count: number;
  onSelect: (view: ViewKey) => void;
}) {
  return (
    <button
      type="button"
      className={`rt-nav-btn${active ? " rt-nav-btn--active" : ""}`}
      onClick={() => onSelect(item.key)}
    >
      <span>{item.label}</span>
      {count > 0 ? <span className="rt-count">{count}</span> : null}
    </button>
  );
}

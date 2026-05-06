import { Icon } from "../ui/Icon";
import { AdapterChip } from "./AdapterChip";
import { NAV, type PageId, type Workspace } from "./types";

interface SidebarProps {
  page: PageId;
  setPage: (id: PageId) => void;
  ws: Workspace;
}

export function Sidebar({ page, setPage, ws }: SidebarProps) {
  return (
    <aside className="side">
      <div
        className="side__head"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 8, padding: "14px 14px 12px" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="side__title">{ws.name}</span>
          <div style={{ flex: 1 }} />
          <button className="side__icon-btn" title="Search">
            <Icon name="search" size={14} />
          </button>
        </div>
        <AdapterChip onConfigure={() => setPage("settings")} />
      </div>

      <nav className="side__nav">
        {NAV.map((n) => {
          if (n.kind === "group") {
            return (
              <div className="side__group-head" key={n.id} style={{ marginTop: 6 }}>
                <span className="side__group-label">{n.label}</span>
              </div>
            );
          }
          const active = page === n.id;
          return (
            <button
              key={n.id}
              className={`side__item${active ? " side__item--active" : ""}`}
              onClick={() => setPage(n.id)}
            >
              <span className="side__item-icon">
                <Icon name={n.icon} size={15} />
              </span>
              <span className="side__item-label">{n.label}</span>
              {n.badge != null && (
                <span className={`side__item-badge${n.badgeAccent ? " side__item-badge--accent" : ""}`}>
                  {n.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="side__utility">
        <div className="side__doc">
          <Icon name="book2" size={15} />
          <span style={{ flex: 1 }}>Documentation</span>
          <Icon name="external" size={12} color="var(--rt-fog-dim)" />
        </div>
        <div className="side__util-row">
          <span className="side__version">v0.31</span>
          <button className="side__util-btn" title="Settings" onClick={() => setPage("settings")}>
            <Icon name="settings" size={14} />
          </button>
          <button className="side__util-btn" title="Theme">
            <Icon name="moon" size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}

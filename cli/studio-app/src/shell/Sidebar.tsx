import type { AgentProbe, StudioWorkspace } from "../api";
import type { AgentPreference } from "../agentMeta";
import { Icon } from "../ui/Icon";
import { AgentChip } from "./AgentChip";
import { NAV, type PageId } from "./types";

export type SidebarCounts = Partial<Record<PageId, number>>;

interface SidebarProps {
  page: PageId;
  setPage: (id: PageId) => void;
  ws: StudioWorkspace;
  agents: AgentProbe[];
  pref: AgentPreference | null;
  setPref: (next: AgentPreference) => void;
  onOpenSearch: () => void;
  counts?: SidebarCounts;
}

export function Sidebar({ page, setPage, ws, agents, pref, setPref, onOpenSearch, counts }: SidebarProps) {
  const isMac = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
  const shortcut = isMac ? "⌘K" : "Ctrl K";

  return (
    <aside className="side">
      <div
        className="side__head"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 8, padding: "14px 14px 12px" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="side__title" title={ws.label}>{ws.label}</span>
          <div style={{ flex: 1 }} />
          <button
            className="side__icon-btn"
            title={`Search · ${shortcut}`}
            onClick={onOpenSearch}
          >
            <Icon name="search" size={14} />
          </button>
        </div>
        <AgentChip agents={agents} pref={pref} setPref={setPref} onConfigure={() => setPage("settings")} />
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
          const badge = n.badge ?? counts?.[n.id];
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
              {badge != null && badge > 0 && (
                <span className={`side__item-badge${n.badgeAccent ? " side__item-badge--accent" : ""}`}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="side__utility">
        <a
          className="side__doc"
          href="https://www.riptidesim.com/docs/"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="book2" size={15} />
          <span style={{ flex: 1 }}>Documentation</span>
          <Icon name="external" size={12} color="var(--rt-fog-dim)" />
        </a>
        <div className="side__util-row">
          <span className="side__version">v0.11.0</span>
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

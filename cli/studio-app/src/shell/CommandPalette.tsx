import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentProbe, StudioWorkspace } from "../api";
import { Icon, type IconName } from "../ui/Icon";
import { NAV, type PageId } from "./types";

type Hit =
  | { kind: "page"; id: PageId; label: string; subtitle: string; icon: IconName }
  | { kind: "workspace"; idx: number; label: string; subtitle: string };

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  workspaces: StudioWorkspace[];
  agents: AgentProbe[];
  activeWs: number;
  onNavigate: (page: PageId) => void;
  onSwitchWorkspace: (idx: number) => void;
}

const PAGE_SUBTITLES: Record<PageId, string> = {
  overview: "Workspace summary",
  handoff: "Agent handoff",
  adapter: "Adapter graph",
  campaigns: "Campaign inputs and runs",
  library: "Personas, scenarios, invariants",
  jobs: "Job queue",
  reports: "Artifacts and report bodies",
  tutorial: "Guided tour",
  settings: "Program detection and config intent"
};

export function CommandPalette({
  open,
  onClose,
  workspaces,
  activeWs,
  onNavigate,
  onSwitchWorkspace
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const catalog = useMemo(() => {
    const pages: Hit[] = NAV
      .filter((entry): entry is Extract<(typeof NAV)[number], { kind: "item" }> => entry.kind === "item")
      .map((entry) => ({
        kind: "page",
        id: entry.id,
        label: entry.label,
        subtitle: PAGE_SUBTITLES[entry.id],
        icon: entry.icon
      }));
    const workspaceHits: Hit[] = workspaces.map((workspace, idx) => ({
      kind: "workspace",
      idx,
      label: workspace.label,
      subtitle: idx === activeWs ? `${workspace.path} - current` : workspace.path
    }));
    return [...pages, ...workspaceHits];
  }, [activeWs, workspaces]);

  const hits = useMemo(() => catalog.filter((hit) => matches(hit, query)), [catalog, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (activeIdx >= hits.length) setActiveIdx(hits.length === 0 ? 0 : hits.length - 1);
  }, [activeIdx, hits.length]);

  if (!open) return null;

  function commit(hit: Hit) {
    if (hit.kind === "page") onNavigate(hit.id);
    else onSwitchWorkspace(hit.idx);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (hits.length) setActiveIdx((idx) => (idx + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (hits.length) setActiveIdx((idx) => (idx - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[activeIdx];
      if (hit) commit(hit);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="cmdk__backdrop" onClick={onClose} />
      <div className="cmdk__panel" role="document">
        <div className="cmdk__field">
          <Icon name="search" size={16} color="var(--rt-teal)" />
          <input
            ref={inputRef}
            className="cmdk__input"
            type="search"
            placeholder="Go to a page or switch workspace..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="cmdk__results" role="listbox" aria-label="Results">
          {hits.length === 0 ? (
            <div className="cmdk__empty">No matches</div>
          ) : (
            grouped(hits).map((group) => (
              <div key={group.label} className="cmdk__section">
                <div className="cmdk__section-label">{group.label}</div>
                {group.items.map(({ hit, index }) => (
                  <button
                    key={keyFor(hit)}
                    data-idx={index}
                    className={`cmdk__hit${activeIdx === index ? " cmdk__hit--active" : ""}`}
                    onMouseEnter={() => setActiveIdx(index)}
                    onClick={() => commit(hit)}
                  >
                    <span className="cmdk__hit-icon">
                      <Icon name={hit.kind === "page" ? hit.icon : "home"} size={14} />
                    </span>
                    <span className="cmdk__hit-body">
                      <span className="cmdk__hit-title">{hit.label}</span>
                      <span className="cmdk__hit-sub">{hit.subtitle}</span>
                    </span>
                    <span className="cmdk__hit-tag">{hit.kind === "page" ? "Page" : "Workspace"}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="cmdk__foot">
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function matches(hit: Hit, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${hit.label} ${hit.subtitle}`.toLowerCase().includes(q);
}

function grouped(hits: Hit[]): Array<{ label: string; items: Array<{ hit: Hit; index: number }> }> {
  const groups = [
    { label: "Go to", items: [] as Array<{ hit: Hit; index: number }> },
    { label: "Switch workspace", items: [] as Array<{ hit: Hit; index: number }> }
  ];
  hits.forEach((hit, index) => groups[hit.kind === "page" ? 0 : 1].items.push({ hit, index }));
  return groups.filter((group) => group.items.length > 0);
}

function keyFor(hit: Hit): string {
  return hit.kind === "page" ? `page:${hit.id}` : `workspace:${hit.idx}`;
}

import { useEffect, useMemo, useRef, useState } from "react";

import { api, type AgentProbe, type StudioWorkspace } from "../api";
import type { Job, StudioArtifactEntry } from "../studioTypes";
import { Icon, type IconName } from "../ui/Icon";
import { NAV, type PageId } from "./types";

type Hit =
  | { kind: "page"; id: PageId; label: string; subtitle: string; icon: IconName }
  | { kind: "workspace"; idx: number; label: string; subtitle: string }
  | { kind: "artifact"; id: string; label: string; subtitle: string; icon: IconName }
  | { kind: "job"; id: string; label: string; subtitle: string; icon: IconName };

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  workspaces: StudioWorkspace[];
  agents: AgentProbe[];
  activeWs: number;
  onNavigate: (page: PageId) => void;
  onSwitchWorkspace: (idx: number) => void;
  onOpenArtifact: (artifactId: string) => void;
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
  onSwitchWorkspace,
  onOpenArtifact
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [artifacts, setArtifacts] = useState<StudioArtifactEntry[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const activeWorkspaceId = workspaces[activeWs]?.id ?? null;

  useEffect(() => {
    if (!open) return;
    if (!activeWorkspaceId) {
      setArtifacts([]);
      setJobs([]);
      return;
    }
    let cancelled = false;
    Promise.all([api.artifacts(activeWorkspaceId), api.jobs.list(activeWorkspaceId)])
      .then(([artifactRes, jobRes]) => {
        if (cancelled) return;
        setArtifacts(artifactRes.artifacts);
        setJobs(jobRes.jobs.filter((job) => job.workspace_id === activeWorkspaceId));
      })
      .catch(() => {
        if (cancelled) return;
        setArtifacts([]);
        setJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeWorkspaceId]);

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
    const artifactHits: Hit[] = artifacts.map((artifact) => ({
      kind: "artifact",
      id: artifact.id,
      label: artifact.label,
      subtitle: `${artifact.kind.replace(/-/g, " ")} · ${artifact.relative_path}`,
      icon: iconForArtifactKind(artifact.kind)
    }));
    const jobHits: Hit[] = jobs.map((job) => ({
      kind: "job",
      id: job.id,
      label: job.argv.join(" ") || job.kind,
      subtitle: `${job.kind} · ${job.status}`,
      icon: iconForJobKind(job.kind)
    }));
    return [...pages, ...workspaceHits, ...artifactHits, ...jobHits];
  }, [activeWs, workspaces, artifacts, jobs]);

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
    else if (hit.kind === "workspace") onSwitchWorkspace(hit.idx);
    else if (hit.kind === "artifact") onOpenArtifact(hit.id);
    else if (hit.kind === "job") onNavigate("jobs");
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
            placeholder="Go to a page, workspace, artifact, or job..."
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
                      <Icon name={iconForHit(hit)} size={14} />
                    </span>
                    <span className="cmdk__hit-body">
                      <span className="cmdk__hit-title">{hit.label}</span>
                      <span className="cmdk__hit-sub">{hit.subtitle}</span>
                    </span>
                    <span className="cmdk__hit-tag">{tagForHit(hit)}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="cmdk__foot">
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
          <span style={{ marginLeft: "auto" }}><kbd>?</kbd> shortcuts</span>
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
  const groups: Array<{ label: string; items: Array<{ hit: Hit; index: number }> }> = [
    { label: "Go to", items: [] },
    { label: "Switch workspace", items: [] },
    { label: "Artifacts", items: [] },
    { label: "Jobs", items: [] }
  ];
  hits.forEach((hit, index) => {
    if (hit.kind === "page") groups[0]!.items.push({ hit, index });
    else if (hit.kind === "workspace") groups[1]!.items.push({ hit, index });
    else if (hit.kind === "artifact") groups[2]!.items.push({ hit, index });
    else groups[3]!.items.push({ hit, index });
  });
  return groups.filter((group) => group.items.length > 0);
}

function keyFor(hit: Hit): string {
  switch (hit.kind) {
    case "page": return `page:${hit.id}`;
    case "workspace": return `workspace:${hit.idx}`;
    case "artifact": return `artifact:${hit.id}`;
    case "job": return `job:${hit.id}`;
  }
}

function iconForHit(hit: Hit): IconName {
  switch (hit.kind) {
    case "page": return hit.icon;
    case "workspace": return "home";
    case "artifact": return hit.icon;
    case "job": return hit.icon;
  }
}

function tagForHit(hit: Hit): string {
  switch (hit.kind) {
    case "page": return "Page";
    case "workspace": return "Workspace";
    case "artifact": return "Artifact";
    case "job": return "Job";
  }
}

function iconForArtifactKind(kind: StudioArtifactEntry["kind"]): IconName {
  if (kind === "adapter") return "plug";
  if (kind === "scenario") return "play";
  if (kind === "campaign-input" || kind === "campaign-root") return "rocket";
  if (kind === "pack" || kind === "retained-case") return "library";
  return "fileText";
}

function iconForJobKind(kind: Job["kind"]): IconName {
  if (kind.startsWith("campaign")) return "rocket";
  if (kind === "review") return "fileText";
  if (kind === "readiness") return "check";
  if (kind === "replay") return "refresh";
  return "play";
}

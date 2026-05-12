import { useEffect, useMemo, useState } from "react";

import { api } from "../api";
import type { StudioArtifactEntry, StudioArtifactKind, StudioReportPayload } from "../studioTypes";
import { Icon } from "../ui/Icon";
import { JsonTree } from "../ui/JsonTree";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";
import { ReportRenderer } from "../ui/ReportRenderer";
import { SyntaxBlock } from "../ui/SyntaxBlock";
import { readStudioArtifact, writeStudioLocation } from "../shell/location";
import type { PageId } from "../shell/types";

interface ReportsPageProps {
  workspaceId: string;
  onNavigate?: (id: PageId) => void;
  pendingArtifact?: { id: string; nonce: number } | null;
}

const KIND_ORDER: StudioArtifactKind[] = [
  "run-collection",
  "last-run",
  "run",
  "campaign-root",
  "retained-case",
  "pack",
  "readiness-report",
  "markdown-summary",
  "guided-sim",
  "scenario",
  "adapter",
  "campaign-input"
];

export function ReportsPage({ workspaceId, onNavigate, pendingArtifact }: ReportsPageProps) {
  const [artifacts, setArtifacts] = useState<StudioArtifactEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<StudioReportPayload | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsedKinds, setCollapsedKinds] = useState<Set<StudioArtifactKind>>(() => new Set());
  const [query, setQuery] = useState("");

  function toggleKind(kind: StudioArtifactKind) {
    setCollapsedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setArtifacts([]);
    setReport(null);
    setReportError(null);
    const queryArtifact = readStudioArtifact();
    api.artifacts(workspaceId)
      .then((res) => {
        if (cancelled) return;
        setArtifacts(res.artifacts);
        const initial = queryArtifact && res.artifacts.some((artifact) => artifact.id === queryArtifact)
          ? queryArtifact
          : res.artifacts[0]?.id ?? null;
        setSelectedId(initial);
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

  useEffect(() => {
    if (!pendingArtifact) return;
    setSelectedId((current) => {
      if (current === pendingArtifact.id) return current;
      return artifacts.some((artifact) => artifact.id === pendingArtifact.id) ? pendingArtifact.id : current;
    });
  }, [pendingArtifact, artifacts]);

  useEffect(() => {
    if (!selectedId) {
      setReport(null);
      setReportError(null);
      return;
    }
    let cancelled = false;
    setReport(null);
    setReportError(null);
    api.report({ workspaceId, artifactId: selectedId })
      .then((payload) => {
        if (!cancelled) setReport(payload);
      })
      .catch((err) => {
        if (!cancelled) setReportError((err as Error).message);
      });
    writeStudioLocation("reports", workspaceId, "replace", { artifactId: selectedId });
    return () => {
      cancelled = true;
    };
  }, [selectedId, workspaceId]);

  const filteredArtifacts = useMemo(() => filterArtifacts(artifacts, query), [artifacts, query]);
  const grouped = useMemo(() => groupArtifacts(filteredArtifacts), [filteredArtifacts]);
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0] ?? null;

  async function refreshArtifacts() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await api.artifacts(workspaceId);
      setArtifacts(res.artifacts);
      setSelectedId((current) =>
        current && res.artifacts.some((artifact) => artifact.id === current)
          ? current
          : res.artifacts[0]?.id ?? null
      );
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  async function runSelected() {
    if (!selected) return;
    setLaunching(true);
    try {
      const params: Record<string, string> =
        selected.kind === "run"
          ? { scenario: selected.id.replace(/^run:/, "") }
          : selected.kind === "scenario"
            ? { scenario: selected.label }
            : {};
      await api.jobs.create({ workspaceId, kind: "run", params });
      onNavigate?.("jobs");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div>
      <PageLabel>REPORTS</PageLabel>
      {loading && <ReportsEmpty title="Loading reports" body="Indexing .riptide artifacts for this workspace." />}
      {error && <ReportsEmpty title="Studio API error" body={error} />}
      {!loading && !error && artifacts.length === 0 && (
        <ReportsEmpty
          title="No reports yet"
          body="No readable artifacts were found. Run a scenario or campaign and refresh Studio."
          ctaLabel="Open Agent chat"
          onCta={() => onNavigate?.("handoff")}
        />
      )}
      {!loading && !error && artifacts.length > 0 && (
        <div className="lview" style={{ gridTemplateColumns: "340px 1fr" }}>
          <div className="lview__list">
            <div className="lview__list-head" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <Kicker>
                  ARTIFACTS · {query ? `${filteredArtifacts.length} / ${artifacts.length}` : artifacts.length}
                </Kicker>
                <button
                  className="side__icon-btn"
                  onClick={refreshArtifacts}
                  title="Refresh artifacts"
                  disabled={refreshing}
                  aria-label="Refresh artifacts"
                >
                  <Icon name="refresh" size={13} />
                </button>
              </div>
              <input
                type="search"
                className="lview__filter"
                placeholder="Filter artifacts…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="lview__list-body" style={{ padding: "4px 0" }}>
              {grouped.length === 0 && (
                <div style={{ padding: "16px 14px", color: "var(--rt-fog-dim)", font: '400 12px Inter' }}>
                  No artifacts match “{query}”.
                </div>
              )}
              {grouped.map((group) => {
                const collapsed = collapsedKinds.has(group.kind);
                return (
                  <div key={group.kind} style={{ marginBottom: 8 }}>
                    <button
                      type="button"
                      onClick={() => toggleKind(group.kind)}
                      aria-expanded={!collapsed}
                      style={{
                        width: "100%",
                        padding: "10px 14px 4px",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                        color: "inherit"
                      }}
                    >
                      <Icon name={collapsed ? "chevron" : "chevronDown"} size={11} color="var(--rt-fog-dim)" />
                      <span style={{ font: '500 10px "IBM Plex Mono"', letterSpacing: ".16em", textTransform: "uppercase", color: "var(--rt-fog-dim)" }}>
                        {kindLabel(group.kind)} · {group.items.length}
                      </span>
                    </button>
                    {!collapsed && group.items.map((artifact) => (
                      <button
                        key={artifact.id}
                        className={`lview__row${selected?.id === artifact.id ? " lview__row--active" : ""}`}
                        style={{ padding: "8px 14px 8px 28px", gap: 4, borderBottom: "none" }}
                        onClick={() => setSelectedId(artifact.id)}
                      >
                        <div className="lview__row-top">
                          <Icon name="file" size={12} color="var(--rt-fog-dim)" />
                          <span className="lview__row-name" style={{ fontFamily: "IBM Plex Mono", fontSize: 12 }}>
                            {artifact.label}
                          </span>
                          {(artifact.verdict || artifact.status) && <Pill kind={pillForArtifact(artifact)}>{artifact.verdict ?? artifact.status}</Pill>}
                        </div>
                        <div className="lview__row-meta" style={{ paddingLeft: 18 }}>
                          <span>{formatTime(artifact.updated_at)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="lview__detail" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
            {selected && (
              <>
                <div style={{ padding: "18px 28px 0", borderBottom: "1px solid var(--rt-slate-line)" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <Kicker style={{ marginBottom: 6 }}>{kindLabel(selected.kind)}</Kicker>
                      <h2 style={{ font: '500 20px "IBM Plex Mono"', margin: 0, color: "var(--rt-off-white)" }}>{selected.label}</h2>
                      <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 6 }}>
                        {selected.relative_path} · {formatTime(selected.updated_at)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {(selected.kind === "run-collection" || selected.kind === "run" || selected.kind === "scenario") && (
                        <button className="btn btn--primary btn--sm" onClick={runSelected} disabled={launching}>
                          <Icon name="play" size={12} />
                          {launching ? "Queueing..." : "Run"}
                        </button>
                      )}
                      {(selected.verdict || selected.status) && <Pill kind={pillForArtifact(selected)}>{selected.verdict ?? selected.status}</Pill>}
                    </div>
                  </div>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
                  {reportError && (
                    <div className="card" style={{ padding: 18 }}>
                      <Kicker style={{ marginBottom: 8 }}>REPORT BODY</Kicker>
                      <div style={{ color: "var(--rt-fog-dim)", font: "400 13px Inter" }}>{reportError}</div>
                    </div>
                  )}
                  {report && report.content_type === "markdown" && <ReportRenderer body={report.body} />}
                  {report && report.content_type === "json" && <JsonTree body={report.body} />}
                  {report && report.content_type === "toml" && (
                    <SyntaxBlock content={report.body} language="toml" ariaLabel={`${report.relative_path} TOML`} />
                  )}
                  <ArtifactMeta artifact={selected} />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportsEmpty({ title, body, ctaLabel, onCta }: { title: string; body: string; ctaLabel?: string; onCta?: () => void }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <EmptyState icon="fileText" title={title} body={body} ctaLabel={ctaLabel} onCta={onCta} />
    </div>
  );
}

function ArtifactMeta({ artifact }: { artifact: StudioArtifactEntry }) {
  const [open, setOpen] = useState(false);
  const meta = Object.entries(artifact.meta ?? {});
  const hasWarnings = artifact.warnings.length > 0;
  return (
    <div className="card" style={{ padding: 0, marginTop: 18 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px",
          background: "transparent",
          border: 0,
          color: "inherit",
          cursor: "pointer",
          textAlign: "left"
        }}
      >
        <Icon name={open ? "chevronDown" : "chevron"} size={11} color="var(--rt-fog-dim)" />
        <Kicker>ARTIFACT DETAILS</Kicker>
        {hasWarnings && (
          <span style={{ marginLeft: "auto" }}>
            <Pill kind="warn">{artifact.warnings.length} warning{artifact.warnings.length === 1 ? "" : "s"}</Pill>
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: "0 16px 16px" }}>
          <table className="ptable">
            <tbody>
              <tr><td>id</td><td>{artifact.id}</td></tr>
              <tr><td>kind</td><td>{artifact.kind}</td></tr>
              <tr><td>path</td><td>{artifact.relative_path}</td></tr>
              {artifact.canonical_hash && <tr><td>canonical hash</td><td>{artifact.canonical_hash}</td></tr>}
              {artifact.invariant_fire_count != null && <tr><td>invariant fires</td><td>{artifact.invariant_fire_count}</td></tr>}
              {meta.map(([key, value]) => (
                <tr key={key}><td>{key}</td><td>{String(value ?? "null")}</td></tr>
              ))}
            </tbody>
          </table>
          {hasWarnings && (
            <div style={{ marginTop: 14 }}>
              <Kicker style={{ marginBottom: 8 }}>WARNINGS</Kicker>
              {artifact.warnings.map((warning, idx) => (
                <div key={idx} style={{ color: "var(--rt-fog-dim)", font: "400 12px/1.5 Inter", marginBottom: 6 }}>
                  {warning.message} Next: {warning.next_action}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function groupArtifacts(artifacts: StudioArtifactEntry[]): Array<{ kind: StudioArtifactKind; items: StudioArtifactEntry[] }> {
  return KIND_ORDER.map((kind) => ({
    kind,
    items: artifacts.filter((artifact) => artifact.kind === kind)
  })).filter((group) => group.items.length > 0);
}

function filterArtifacts(artifacts: StudioArtifactEntry[], query: string): StudioArtifactEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return artifacts;
  return artifacts.filter((artifact) => {
    const haystack = `${artifact.label} ${artifact.kind} ${artifact.relative_path} ${artifact.verdict ?? ""} ${artifact.status ?? ""}`.toLowerCase();
    return haystack.includes(q);
  });
}

function kindLabel(kind: StudioArtifactKind): string {
  return kind.replace(/-/g, " ");
}

function pillForArtifact(artifact: StudioArtifactEntry): PillKind {
  const value = `${artifact.verdict ?? ""} ${artifact.status ?? ""}`.toLowerCase();
  if (value.includes("no-failure") || value.includes("pass")) return "pass";
  if (value.includes("fail") || value.includes("error")) return "fail";
  if (value.includes("running")) return "running";
  if (value.includes("queued")) return "queued";
  if (value.includes("warn") || value.includes("inconclusive")) return "warn";
  return "neutral";
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "unknown";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

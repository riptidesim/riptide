import { useMemo, useState } from "react";

import type { Artifact, ArtifactIndex, ArtifactKind, Workspace } from "../api";
import { StatusPill } from "../components/StatusPill";

interface Props {
  workspace: Workspace;
  artifacts: ArtifactIndex | null;
  artifactsError: string | null;
  openArtifactReport: (id: string) => void;
  openArtifactDashboard: (relativePath: string) => void;
}

const KIND_LABELS: Record<ArtifactKind, string> = {
  "run-collection": "run collection",
  "last-run": "last run",
  run: "run",
  "campaign-root": "campaign",
  "retained-case": "retained case",
  "campaign-input": "campaign input",
  pack: "pack",
  "guided-sim": "guided sim",
  "readiness-report": "readiness report",
  "markdown-summary": "summary",
  scenario: "scenario",
  adapter: "adapter"
};

export function LibraryView({
  workspace,
  artifacts,
  artifactsError,
  openArtifactReport,
  openArtifactDashboard
}: Props) {
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [protocolFilter, setProtocolFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  const items = artifacts?.artifacts ?? [];

  const protocolOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of items) {
      if (typeof a.meta?.protocol_class === "string") set.add(a.meta.protocol_class);
    }
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((a) => {
      if (kindFilter !== "all" && a.kind !== kindFilter) return false;
      if (statusFilter !== "all") {
        const s = (a.status ?? a.verdict ?? "").toLowerCase();
        if (!s.includes(statusFilter)) return false;
      }
      if (protocolFilter !== "all") {
        if (a.meta?.protocol_class !== protocolFilter) return false;
      }
      if (q.length > 0) {
        const haystack = `${a.label} ${a.relative_path} ${a.id}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [items, kindFilter, statusFilter, protocolFilter, query]);

  return (
    <>
      <div className="rt-page-kicker">EVIDENCE LIBRARY</div>
      <h1>{workspace.label}</h1>
      <p>
        Browse runs, campaigns, packs, readiness reports, scenarios, and adapters indexed under
        <code className="rt-code-inline"> {workspace.path}/.riptide/</code>.
      </p>

      {artifactsError ? (
        <div className="rt-empty">
          <strong>Could not load artifacts.</strong>
          {artifactsError}
        </div>
      ) : null}

      <div className="rt-toolbar">
        <select className="rt-select" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="all">All kinds</option>
          {(Object.keys(KIND_LABELS) as ArtifactKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <select className="rt-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All status</option>
          <option value="pass">pass</option>
          <option value="fail">fail</option>
          <option value="setup">setup-error</option>
          <option value="warn">warn</option>
          <option value="no-failure">no-failure-observed</option>
          <option value="failure">failure-observed</option>
        </select>
        {protocolOptions.length > 0 ? (
          <select className="rt-select" value={protocolFilter} onChange={(e) => setProtocolFilter(e.target.value)}>
            <option value="all">All protocol classes</option>
            {protocolOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : null}
        <input
          className="rt-input"
          style={{ maxWidth: 240 }}
          placeholder="Search by name or path"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="rt-meta" style={{ fontFamily: "var(--rt-font-mono)" }}>
          {filtered.length}/{items.length} artifacts
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rt-empty">
          <strong>No artifacts match the current filters.</strong>
          Clear filters or run <code className="rt-code-inline">riptide run</code>,{" "}
          <code className="rt-code-inline">riptide campaign run</code>, or{" "}
          <code className="rt-code-inline">riptide readiness</code>.
        </div>
      ) : (
        <div className="rt-table-wrap">
          <table className="rt-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Label</th>
                <th>Status</th>
                <th>Verdict</th>
                <th>Coverage</th>
                <th>Confidence</th>
                <th>Hash</th>
                <th>Path</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <ArtifactRow
                  key={a.id}
                  artifact={a}
                  openReport={openArtifactReport}
                  openDashboard={openArtifactDashboard}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ArtifactRow({
  artifact,
  openReport,
  openDashboard
}: {
  artifact: Artifact;
  openReport: (id: string) => void;
  openDashboard: (relativePath: string) => void;
}) {
  const reportable = ["run", "campaign-root", "pack", "guided-sim", "readiness-report", "markdown-summary", "retained-case"].includes(
    artifact.kind
  );
  const dashboardable = ["run", "run-collection", "pack"].includes(artifact.kind);
  return (
    <tr>
      <td>
        <span className="rt-pill rt-pill--info">{KIND_LABELS[artifact.kind]}</span>
      </td>
      <td>
        <div>{artifact.label}</div>
        {artifact.warnings.length > 0 ? (
          <div className="rt-meta" style={{ color: "var(--rt-warn)" }}>
            {artifact.warnings.length} warning{artifact.warnings.length === 1 ? "" : "s"}
          </div>
        ) : null}
      </td>
      <td>
        <StatusPill text={artifact.status} />
      </td>
      <td>
        <StatusPill text={artifact.verdict} />
      </td>
      <td>
        <StatusPill text={artifact.coverage} tone="info" />
      </td>
      <td>
        <StatusPill text={artifact.confidence} tone="info" />
      </td>
      <td className="rt-mono">
        {artifact.canonical_hash ? artifact.canonical_hash.slice(0, 12) + "…" : "—"}
      </td>
      <td className="rt-mono">{artifact.relative_path}</td>
      <td className="rt-mono">{relTime(artifact.updated_at)}</td>
      <td>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {reportable ? (
            <button className="rt-btn rt-btn--ghost" type="button" onClick={() => openReport(artifact.id)}>
              Report
            </button>
          ) : null}
          {dashboardable ? (
            <button
              className="rt-btn rt-btn--ghost"
              type="button"
              onClick={() => openDashboard(artifact.relative_path)}
            >
              Dashboard
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(t).toISOString().slice(0, 10);
}

import { useEffect, useMemo, useState } from "react";

import { api, type ArtifactIndex, type ReportPayload, type Workspace } from "../api";
import { Markdown } from "../components/Markdown";
import { StatusPill } from "../components/StatusPill";

interface Props {
  workspace: Workspace;
  artifacts: ArtifactIndex | null;
  selectedArtifactId: string | null;
  onSelect: (id: string | null) => void;
}

const REPORTABLE_KINDS = new Set([
  "run",
  "run-collection",
  "campaign-root",
  "pack",
  "guided-sim",
  "readiness-report",
  "markdown-summary",
  "retained-case",
  "scenario"
]);

export function ReportView({ workspace, artifacts, selectedArtifactId, onSelect }: Props) {
  const reportable = useMemo(
    () => (artifacts?.artifacts ?? []).filter((a) => REPORTABLE_KINDS.has(a.kind)),
    [artifacts]
  );
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedArtifactId) {
      setReport(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const payload = await api.report(workspace.id, selectedArtifactId);
        if (!cancelled) setReport(payload);
      } catch (err) {
        if (!cancelled) {
          setReport(null);
          setError((err as Error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace.id, selectedArtifactId]);

  return (
    <>
      <div className="rt-page-kicker">REPORT VIEWER</div>
      <h1>Reports & summaries</h1>

      <div className="rt-toolbar">
        <select
          className="rt-select"
          value={selectedArtifactId ?? ""}
          onChange={(e) => onSelect(e.target.value || null)}
        >
          <option value="">Select an artifact…</option>
          {reportable.map((r) => (
            <option key={r.id} value={r.id}>
              {r.kind} · {r.label}
            </option>
          ))}
        </select>
        {selectedArtifactId ? (
          <button className="rt-btn rt-btn--ghost" type="button" onClick={() => onSelect(null)}>
            Clear
          </button>
        ) : null}
      </div>

      {!selectedArtifactId ? (
        <div className="rt-empty">
          <strong>Pick a run, campaign, pack, summary, or readiness report.</strong>
          Studio renders Markdown locally; raw JSON shows as a preformatted block.
        </div>
      ) : loading ? (
        <div className="rt-empty">Loading report…</div>
      ) : error ? (
        <div className="rt-empty">
          <strong>Could not load report.</strong>
          {error}
        </div>
      ) : report ? (
        <div className="rt-card">
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div>
              <h3>{report.label}</h3>
              <div className="rt-meta">{report.relative_path}</div>
            </div>
            <StatusPill text={report.content_type} tone="info" />
          </div>
          {report.content_type === "markdown" ? (
            <Markdown body={report.body} />
          ) : (
            <pre className="rt-code-block">{prettyJson(report.body)}</pre>
          )}
        </div>
      ) : null}
    </>
  );
}

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

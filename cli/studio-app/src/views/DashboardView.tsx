import { useMemo } from "react";

import type { ArtifactIndex, Workspace } from "../api";

interface Props {
  workspace: Workspace;
  artifacts: ArtifactIndex | null;
  selectedSource: string | null;
  onSelect: (source: string | null) => void;
}

export function DashboardView({ workspace, artifacts, selectedSource, onSelect }: Props) {
  const sources = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    const items = artifacts?.artifacts ?? [];
    if (items.some((a) => a.kind === "run-collection")) {
      out.push({ value: ".riptide/run-collection.json", label: "Run collection (default)" });
    }
    for (const a of items) {
      if (a.kind === "run") {
        out.push({ value: a.relative_path, label: `Run · ${a.label}` });
      } else if (a.kind === "pack") {
        out.push({ value: a.relative_path, label: `Pack · ${a.label}` });
      }
    }
    return out;
  }, [artifacts]);

  const iframeSource = selectedSource ?? sources[0]?.value ?? "";
  const iframeUrl = buildDashboardUrl(workspace.id, iframeSource);

  return (
    <>
      <div className="rt-page-kicker">DASHBOARD DRILLDOWN</div>
      <h1>Run / replay dashboard</h1>
      <p>
        Same dashboard the existing <code className="rt-code-inline">riptide run --serve</code> and{" "}
        <code className="rt-code-inline">riptide replay --serve</code> ship — embedded inside Studio
        and scoped to the selected workspace.
      </p>

      <div className="rt-toolbar">
        <select
          className="rt-select"
          value={selectedSource ?? ""}
          onChange={(e) => onSelect(e.target.value || null)}
        >
          <option value="">Workspace default</option>
          {sources.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <a
          className="rt-btn rt-btn--ghost"
          href={iframeUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open in new tab
        </a>
      </div>

      {sources.length === 0 ? (
        <div className="rt-empty">
          <strong>No drillable artifacts.</strong>
          The dashboard view shows runs, run collections, and replay packs. Run{" "}
          <code className="rt-code-inline">riptide run</code> or{" "}
          <code className="rt-code-inline">riptide replay</code> first.
        </div>
      ) : (
        <iframe
          title="Riptide dashboard"
          src={iframeUrl}
          style={{
            width: "100%",
            height: "70vh",
            border: "1px solid var(--rt-slate-line)",
            borderRadius: 12,
            background: "var(--rt-slate-panel)"
          }}
        />
      )}
    </>
  );
}

function buildDashboardUrl(workspaceId: string, source: string): string {
  const params = new URLSearchParams();
  params.set("workspace", workspaceId);
  if (source) params.set("source", source);
  return `/dashboard?${params.toString()}`;
}

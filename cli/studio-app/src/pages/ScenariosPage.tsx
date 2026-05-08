import { useEffect, useState } from "react";

import type { StudioGraphNode } from "../studioTypes";
import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel } from "../ui/primitives";
import { SourceBlock } from "../ui/SourceBlock";
import type { PageId } from "../shell/types";

interface ScenariosPageProps {
  nodes: StudioGraphNode[];
  workspaceId?: string;
  loading?: boolean;
  error?: string | null;
  embedded?: boolean;
  onNavigate?: (id: PageId) => void;
}

export function ScenariosPage({ nodes, workspaceId, loading, error, embedded, onNavigate }: ScenariosPageProps) {
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    setSel(nodes[0]?.id ?? null);
  }, [nodes]);

  const detail = nodes.find((node) => node.id === sel) ?? nodes[0] ?? null;

  if (loading) return <ScenarioEmpty embedded={embedded} title="Loading scenarios" body="Fetching graph nodes from the Studio API." />;
  if (error) return <ScenarioEmpty embedded={embedded} title="Studio API error" body={error} />;
  if (nodes.length === 0) {
    return (
      <ScenarioEmpty
        embedded={embedded}
        title="No scenarios authored"
        body="Scenarios are read from .riptide/scenarios and surfaced through the graph endpoint."
        ctaLabel="Open Agent chat"
        onCta={() => onNavigate?.("handoff")}
      />
    );
  }

  return (
    <div>
      {!embedded && <PageLabel>SCENARIOS</PageLabel>}
      <div className="lview">
        <div className="lview__list">
          <div className="lview__list-head">
            <Kicker>SCENARIOS · {nodes.length}</Kicker>
          </div>
          <div className="lview__list-body">
            {nodes.map((node) => (
              <button
                key={node.id}
                className={`lview__row${detail?.id === node.id ? " lview__row--active" : ""}`}
                onClick={() => setSel(node.id)}
              >
                <div className="lview__row-top">
                  <Icon name="play" size={13} color="var(--rt-fog-dim)" />
                  <span className="lview__row-name">{node.label}</span>
                </div>
                <div className="lview__row-meta">
                  <span style={{ fontFamily: "IBM Plex Mono" }}>{node.source_path ?? node.id}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
        {detail && (
          <div className="lview__detail">
            <Kicker style={{ marginBottom: 8 }}>SCENARIO</Kicker>
            <h2 style={{ font: "600 22px Inter", margin: "0 0 8px", color: "var(--rt-off-white)" }}>{detail.label}</h2>
            <div style={{ font: "400 14px/1.6 Inter", color: "var(--rt-fg-2)", marginBottom: 18 }}>{detail.meaning}</div>
            {detail.source_path && (
              <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 18 }}>
                <Icon name="folder" size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                {detail.source_path}
              </div>
            )}
            <MetaTable meta={detail.meta} />
            {workspaceId && <SourceBlock workspaceId={workspaceId} sourcePath={detail.source_path} />}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaTable({ meta }: { meta?: Record<string, string | number | boolean | null> }) {
  const entries = Object.entries(meta ?? {});
  if (entries.length === 0) return <div style={{ color: "var(--rt-fog-dim)", font: "400 13px Inter" }}>No scenario metadata on this node.</div>;
  return (
    <table className="ptable">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key}><td>{key}</td><td>{String(value ?? "null")}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function ScenarioEmpty({ embedded, title, body, ctaLabel, onCta }: { embedded?: boolean; title: string; body: string; ctaLabel?: string; onCta?: () => void }) {
  return (
    <div>
      {!embedded && <PageLabel>SCENARIOS</PageLabel>}
      <div className="card" style={{ padding: 0 }}>
        <EmptyState icon="play" title={title} body={body} ctaLabel={ctaLabel} onCta={onCta} />
      </div>
    </div>
  );
}

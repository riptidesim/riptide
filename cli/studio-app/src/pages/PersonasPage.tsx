import { useEffect, useState } from "react";

import type { StudioGraphNode } from "../studioTypes";
import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill } from "../ui/primitives";
import type { PageId } from "../shell/types";

interface PersonasPageProps {
  nodes: StudioGraphNode[];
  loading?: boolean;
  error?: string | null;
  embedded?: boolean;
  onNavigate?: (id: PageId) => void;
}

export function PersonasPage({ nodes, loading, error, embedded, onNavigate }: PersonasPageProps) {
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    setSel(nodes[0]?.id ?? null);
  }, [nodes]);

  const detail = nodes.find((node) => node.id === sel) ?? nodes[0] ?? null;

  if (loading) return <LibraryEmpty embedded={embedded} page="PERSONAS" title="Loading personas" body="Fetching graph nodes from the Studio API." />;
  if (error) return <LibraryEmpty embedded={embedded} page="PERSONAS" title="Studio API error" body={error} />;
  if (nodes.length === 0) {
    return (
      <LibraryEmpty
        embedded={embedded}
        page="PERSONAS"
        title="No personas defined yet"
        body="Personas are graph nodes sourced from the active adapter. Add personas to the adapter and refresh this workspace."
        ctaLabel="Open Agent chat"
        onCta={() => onNavigate?.("handoff")}
      />
    );
  }

  return (
    <div>
      {!embedded && <PageLabel>PERSONAS</PageLabel>}
      <div className="lview">
        <div className="lview__list">
          <div className="lview__list-head">
            <Kicker>PERSONAS · {nodes.length}</Kicker>
          </div>
          <div className="lview__list-body">
            {nodes.map((node) => (
              <button
                key={node.id}
                className={`lview__row${detail?.id === node.id ? " lview__row--active" : ""}`}
                onClick={() => setSel(node.id)}
              >
                <div className="lview__row-top">
                  <Icon name="users" size={13} color="var(--rt-fog-dim)" />
                  <span className="lview__row-name">{node.label}</span>
                  <Pill kind="info">PERSONA</Pill>
                </div>
                <div className="lview__row-meta">
                  <span style={{ fontFamily: "IBM Plex Mono" }}>{String(node.meta?.persona_id ?? node.id.replace(/^persona:/, ""))}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
        <GraphNodeDetail node={detail} />
      </div>
    </div>
  );
}

function GraphNodeDetail({ node }: { node: StudioGraphNode | null }) {
  if (!node) return null;
  return (
    <div className="lview__detail">
      <Kicker style={{ marginBottom: 8 }}>PERSONA</Kicker>
      <h2 style={{ font: "600 22px Inter", margin: "0 0 8px", color: "var(--rt-off-white)" }}>{node.label}</h2>
      <div style={{ font: "400 14px/1.6 Inter", color: "var(--rt-fg-2)", marginBottom: 18, maxWidth: 720 }}>{node.meaning}</div>
      {node.source_path && (
        <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 18 }}>
          <Icon name="folder" size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          {node.source_path}
        </div>
      )}
      <Kicker style={{ marginBottom: 8 }}>METADATA</Kicker>
      <MetaTable meta={node.meta} />
    </div>
  );
}

function MetaTable({ meta }: { meta?: Record<string, string | number | boolean | null> }) {
  const entries = Object.entries(meta ?? {});
  if (entries.length === 0) return <div style={{ color: "var(--rt-fog-dim)", font: "400 13px Inter" }}>No metadata on this node.</div>;
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

function LibraryEmpty({
  embedded,
  page,
  title,
  body,
  ctaLabel,
  onCta
}: {
  embedded?: boolean;
  page: string;
  title: string;
  body: string;
  ctaLabel?: string;
  onCta?: () => void;
}) {
  return (
    <div>
      {!embedded && <PageLabel>{page}</PageLabel>}
      <div className="card" style={{ padding: 0 }}>
        <EmptyState icon="users" title={title} body={body} ctaLabel={ctaLabel} onCta={onCta} />
      </div>
    </div>
  );
}

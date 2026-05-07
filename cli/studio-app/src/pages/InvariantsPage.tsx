import { useEffect, useState } from "react";

import type { StudioGraphNode } from "../studioTypes";
import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";
import type { PageId } from "../shell/types";

interface InvariantsPageProps {
  nodes: StudioGraphNode[];
  loading?: boolean;
  error?: string | null;
  embedded?: boolean;
  onNavigate?: (id: PageId) => void;
}

export function InvariantsPage({ nodes, loading, error, embedded, onNavigate }: InvariantsPageProps) {
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    setSel(nodes[0]?.id ?? null);
  }, [nodes]);

  const detail = nodes.find((node) => node.id === sel) ?? nodes[0] ?? null;

  if (loading) return <InvariantEmpty embedded={embedded} title="Loading invariants" body="Fetching graph nodes from the Studio API." />;
  if (error) return <InvariantEmpty embedded={embedded} title="Studio API error" body={error} />;
  if (nodes.length === 0) {
    return (
      <InvariantEmpty
        embedded={embedded}
        title="No invariants attached"
        body="Invariants are read from the active adapter graph. Add invariant definitions to the adapter to populate this tab."
        ctaLabel="Open Agent chat"
        onCta={() => onNavigate?.("handoff")}
      />
    );
  }

  return (
    <div>
      {!embedded && <PageLabel>INVARIANTS</PageLabel>}
      <div className="lview">
        <div className="lview__list">
          <div className="lview__list-head">
            <Kicker>INVARIANTS · {nodes.length}</Kicker>
          </div>
          <div className="lview__list-body">
            {nodes.map((node) => (
              <button
                key={node.id}
                className={`lview__row${detail?.id === node.id ? " lview__row--active" : ""}`}
                onClick={() => setSel(node.id)}
              >
                <div className="lview__row-top">
                  <Icon name="shield" size={13} color="var(--rt-fog-dim)" />
                  <span className="lview__row-name" style={{ fontFamily: "IBM Plex Mono", fontSize: 12.5 }}>{node.label}</span>
                </div>
                <div className="lview__row-meta">
                  <Pill kind={severityKind(node)}>GRAPH</Pill>
                  <span style={{ marginLeft: "auto", fontFamily: "IBM Plex Mono" }}>{String(node.meta?.field ?? "field:any")}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
        {detail && (
          <div className="lview__detail">
            <Kicker style={{ marginBottom: 8 }}>INVARIANT</Kicker>
            <h2 style={{ font: '500 22px "IBM Plex Mono"', margin: "0 0 10px", color: "var(--rt-off-white)" }}>{detail.label}</h2>
            <div style={{ font: "400 14px/1.6 Inter", color: "var(--rt-fg-2)", marginBottom: 18 }}>{detail.meaning}</div>
            {detail.source_path && (
              <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 18 }}>
                <Icon name="folder" size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                {detail.source_path}
              </div>
            )}
            <Kicker style={{ marginBottom: 8 }}>PREDICATE METADATA</Kicker>
            <MetaTable meta={detail.meta} />
          </div>
        )}
      </div>
    </div>
  );
}

function severityKind(node: StudioGraphNode): PillKind {
  const op = String(node.meta?.op ?? "");
  if (op.includes("<") || op.includes(">")) return "warn";
  return "info";
}

function MetaTable({ meta }: { meta?: Record<string, string | number | boolean | null> }) {
  const entries = Object.entries(meta ?? {});
  if (entries.length === 0) return <div style={{ color: "var(--rt-fog-dim)", font: "400 13px Inter" }}>No predicate metadata on this node.</div>;
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

function InvariantEmpty({ embedded, title, body, ctaLabel, onCta }: { embedded?: boolean; title: string; body: string; ctaLabel?: string; onCta?: () => void }) {
  return (
    <div>
      {!embedded && <PageLabel>INVARIANTS</PageLabel>}
      <div className="card" style={{ padding: 0 }}>
        <EmptyState icon="shield" title={title} body={body} ctaLabel={ctaLabel} onCta={onCta} />
      </div>
    </div>
  );
}

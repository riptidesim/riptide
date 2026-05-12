import { useEffect, useMemo, useState } from "react";

import { api } from "../api";
import type { StudioGraphEdge, StudioGraphNode, StudioGraphNodeKind } from "../studioTypes";
import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill } from "../ui/primitives";
import { TabStrip } from "../ui/TabStrip";
import { writeStudioLocation } from "../shell/location";
import type { PageId } from "../shell/types";

type AdapterTab = "manifest" | "accounts" | "instructions" | "semantics";

interface AdapterPageProps {
  workspaceId: string;
  onNavigate: (id: PageId) => void;
}

export function AdapterPage({ workspaceId, onNavigate }: AdapterPageProps) {
  const [tab, setTab] = useState<AdapterTab>("manifest");
  const [nodes, setNodes] = useState<StudioGraphNode[]>([]);
  const [edges, setEdges] = useState<StudioGraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNodes([]);
    setEdges([]);
    api.graph({ workspaceId })
      .then((graph) => {
        if (!cancelled) {
          setNodes(graph.nodes);
          setEdges(graph.edges);
        }
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

  const adapter = nodes.find((node) => node.kind === "adapter") ?? null;
  const semantics = nodes.filter((node) => node.kind === "semantics");
  const personas = nodes.filter((node) => node.kind === "persona");
  const invariants = nodes.filter((node) => node.kind === "invariant");
  const parameters = nodes.filter((node) => node.kind === "parameter");
  const rawArtifactId = useMemo(() => rawAdapterArtifactId(adapter), [adapter]);

  function openRaw() {
    if (rawArtifactId) {
      writeStudioLocation("reports", workspaceId, "push", { artifactId: rawArtifactId });
    }
    onNavigate("reports");
  }

  return (
    <div>
      <PageLabel>ADAPTER</PageLabel>
      {loading && <AdapterShell title="Loading adapter graph" body="Fetching graph nodes from the Studio API." />}
      {error && <AdapterShell title="Studio API error" body={error} />}
      {!loading && !error && !adapter && (
        <div className="card" style={{ padding: 0 }}>
          <EmptyState
            icon="plug"
            title="Adapter not configured"
            body="No graph node with kind adapter was returned for this workspace. Add an adapter under .riptide/adapters and refresh Studio."
            ctaLabel="Configure with agent"
            onCta={() => onNavigate("handoff")}
          />
        </div>
      )}
      {!loading && !error && adapter && (
        <>
          <div className="card" style={{ padding: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <Kicker style={{ marginBottom: 6 }}>GRAPH-DERIVED ADAPTER</Kicker>
                <h2 style={{ margin: "0 0 6px", font: "600 20px Inter", color: "var(--rt-off-white)" }}>{adapter.label}</h2>
                <div style={{ font: "400 13px/1.55 Inter", color: "var(--rt-fg-2)", maxWidth: 820 }}>
                  Studio is rendering the adapter, semantics, personas, invariants, and parameters exposed by the graph endpoint. Field-level IDL account and instruction tables are not exposed by a server endpoint yet.
                </div>
              </div>
              <button className="btn btn--ghost btn--sm" onClick={openRaw} disabled={!rawArtifactId}>
                <Icon name="file" size={12} />
                View raw
              </button>
            </div>
          </div>

          <SimulationDiagram nodes={nodes} edges={edges} />

          <TabStrip
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "manifest", label: "Manifest" },
              { id: "accounts", label: "Accounts", count: personas.length },
              { id: "instructions", label: "Instructions", count: parameters.length },
              { id: "semantics", label: "Semantics", count: semantics.length + invariants.length }
            ]}
          />

          {tab === "manifest" && <ManifestTab adapter={adapter} semantics={semantics} personas={personas} invariants={invariants} parameters={parameters} />}
          {tab === "accounts" && <GapTab title="Accounts" nodes={personas} emptyLabel="No persona/account-like graph nodes were returned." />}
          {tab === "instructions" && <GapTab title="Instructions" nodes={parameters.length > 0 ? parameters : invariants} emptyLabel="No parameter or instruction-like graph nodes were returned." />}
          {tab === "semantics" && <SemanticsTab semantics={semantics} invariants={invariants} parameters={parameters} />}
        </>
      )}
    </div>
  );
}

const DIAGRAM_COLUMNS: Array<{ title: string; kinds: StudioGraphNodeKind[] }> = [
  { title: "Workspace", kinds: ["workspace"] },
  { title: "Inputs", kinds: ["adapter", "semantics", "persona", "scenario", "campaign", "parameter"] },
  { title: "Runner", kinds: ["engine", "invariant"] },
  { title: "Evidence", kinds: ["run", "report", "pack"] }
];

interface DiagramNode extends StudioGraphNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

function SimulationDiagram({ nodes, edges }: { nodes: StudioGraphNode[]; edges: StudioGraphEdge[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(nodes[0]?.id ?? null);
  const layout = useMemo(() => layoutDiagram(nodes), [nodes]);
  const selected = layout.nodes.find((node) => node.id === selectedId) ?? layout.nodes[0] ?? null;

  useEffect(() => {
    setSelectedId((current) => current && nodes.some((node) => node.id === current) ? current : nodes[0]?.id ?? null);
  }, [nodes]);

  if (layout.nodes.length === 0) return null;

  return (
    <div className="card" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div>
          <Kicker style={{ marginBottom: 4 }}>SIMULATION DIAGRAM</Kicker>
          <div className="card__sub">Local graph endpoint rendered without external layout services.</div>
        </div>
        <Pill kind="info">{layout.nodes.length} nodes</Pill>
      </div>
      <div style={{ overflowX: "auto", border: "1px solid var(--rt-slate-line)", borderRadius: 8, background: "var(--rt-slate-1)" }}>
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width="100%"
          height={layout.height}
          role="img"
          aria-label="Riptide simulation graph"
          style={{ minWidth: layout.width }}
        >
          <defs>
            <marker id="diagram-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--rt-fog-dim)" />
            </marker>
          </defs>
          {layout.columns.map((column) => (
            <text key={column.title} x={column.x} y={24} fill="var(--rt-fog-dim)" fontFamily="IBM Plex Mono" fontSize="10" fontWeight="600">
              {column.title.toUpperCase()}
            </text>
          ))}
          {edges.map((edge) => {
            const from = layout.byId.get(edge.from);
            const to = layout.byId.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + from.w;
            const y1 = from.y + from.h / 2;
            const x2 = to.x;
            const y2 = to.y + to.h / 2;
            const mid = x1 + Math.max(24, (x2 - x1) / 2);
            return (
              <path
                key={edge.id}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 8} ${y2}`}
                fill="none"
                stroke="var(--rt-fog-dim)"
                strokeWidth="1.4"
                opacity="0.7"
                markerEnd="url(#diagram-arrow)"
              />
            );
          })}
          {layout.nodes.map((node) => {
            const selectedNode = selected?.id === node.id;
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`${node.kind} ${node.label}`}
                onClick={() => setSelectedId(node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedId(node.id);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.w}
                  height={node.h}
                  rx="7"
                  fill={selectedNode ? "var(--rt-slate-3)" : "var(--rt-slate-2)"}
                  stroke={selectedNode ? "var(--rt-teal)" : "var(--rt-slate-line)"}
                  strokeWidth={selectedNode ? 1.6 : 1}
                />
                <text x={node.x + 12} y={node.y + 20} fill="var(--rt-fog-dim)" fontFamily="IBM Plex Mono" fontSize="9" fontWeight="600">
                  {node.kind.toUpperCase()}
                </text>
                <text x={node.x + 12} y={node.y + 39} fill="var(--rt-off-white)" fontFamily="IBM Plex Mono" fontSize="12" fontWeight="500">
                  {shorten(node.label, 18)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {selected && (
        <div style={{ marginTop: 12, border: "1px solid var(--rt-slate-line)", borderRadius: 8, padding: 12, background: "var(--rt-slate-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Pill kind="info">{selected.kind}</Pill>
            <span style={{ font: "600 13px Inter", color: "var(--rt-off-white)" }}>{selected.label}</span>
          </div>
          <div style={{ font: "400 12.5px/1.55 Inter", color: "var(--rt-fg-2)" }}>{selected.meaning}</div>
          {selected.source_path && (
            <div style={{ marginTop: 8, font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>
              {selected.source_path}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function layoutDiagram(nodes: StudioGraphNode[]): {
  nodes: DiagramNode[];
  byId: Map<string, DiagramNode>;
  columns: Array<{ title: string; x: number }>;
  width: number;
  height: number;
} {
  const nodeWidth = 156;
  const nodeHeight = 58;
  const gapX = 64;
  const gapY = 14;
  const top = 40;
  const left = 18;
  const laidOut: DiagramNode[] = [];
  const seen = new Set<string>();
  const columns: Array<{ title: string; x: number }> = [];

  DIAGRAM_COLUMNS.forEach((column, columnIdx) => {
    const x = left + columnIdx * (nodeWidth + gapX);
    columns.push({ title: column.title, x });
    const columnNodes = nodes.filter((node) => column.kinds.includes(node.kind)).sort((a, b) => a.id.localeCompare(b.id));
    columnNodes.forEach((node, rowIdx) => {
      seen.add(node.id);
      laidOut.push({ ...node, x, y: top + rowIdx * (nodeHeight + gapY), w: nodeWidth, h: nodeHeight });
    });
  });

  const extraX = left + DIAGRAM_COLUMNS.length * (nodeWidth + gapX);
  nodes
    .filter((node) => !seen.has(node.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((node, rowIdx) => {
      laidOut.push({ ...node, x: extraX, y: top + rowIdx * (nodeHeight + gapY), w: nodeWidth, h: nodeHeight });
    });

  const maxY = laidOut.reduce((max, node) => Math.max(max, node.y + node.h), top + nodeHeight);
  const width = left * 2 + DIAGRAM_COLUMNS.length * nodeWidth + (DIAGRAM_COLUMNS.length - 1) * gapX;
  const byId = new Map(laidOut.map((node) => [node.id, node]));
  return { nodes: laidOut, byId, columns, width, height: maxY + 18 };
}

function shorten(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

function AdapterShell({ title, body }: { title: string; body: string }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <EmptyState icon="plug" title={title} body={body} />
    </div>
  );
}

function ManifestTab({
  adapter,
  semantics,
  personas,
  invariants,
  parameters
}: {
  adapter: StudioGraphNode;
  semantics: StudioGraphNode[];
  personas: StudioGraphNode[];
  invariants: StudioGraphNode[];
  parameters: StudioGraphNode[];
}) {
  return (
    <div className="card" style={{ padding: 22 }}>
      <Kicker style={{ marginBottom: 8 }}>MANIFEST</Kicker>
      <div style={{ font: "400 14px/1.6 Inter", color: "var(--rt-fg-2)", marginBottom: 18 }}>{adapter.meaning}</div>
      {adapter.source_path && (
        <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 18 }}>
          <Icon name="folder" size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          {adapter.source_path}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 18 }}>
        <Fact label="SEMANTICS" value={semantics.map((node) => node.label).join(", ") || "none"} />
        <Fact label="PERSONAS" value={String(personas.length)} />
        <Fact label="INVARIANTS" value={String(invariants.length)} />
        <Fact label="PARAMETERS" value={String(parameters.length)} />
      </div>
      <Kicker style={{ marginBottom: 8 }}>ADAPTER METADATA</Kicker>
      <MetaTable meta={adapter.meta} />
    </div>
  );
}

function GapTab({ title, nodes, emptyLabel }: { title: string; nodes: StudioGraphNode[]; emptyLabel: string }) {
  return (
    <div className="card" style={{ padding: 22 }}>
      <Kicker style={{ marginBottom: 8 }}>{title.toUpperCase()}</Kicker>
      <div style={{ font: "400 13px/1.55 Inter", color: "var(--rt-fg-2)", marginBottom: 16 }}>
        Field-level IDL data is not available through the Studio API yet. This tab shows the graph-derived nodes that are available today and keeps synthetic account or instruction rows out of the UI.
      </div>
      {nodes.length === 0 ? (
        <div style={{ color: "var(--rt-fog-dim)", font: "400 13px Inter" }}>{emptyLabel}</div>
      ) : (
        <NodeList nodes={nodes} />
      )}
    </div>
  );
}

function SemanticsTab({
  semantics,
  invariants,
  parameters
}: {
  semantics: StudioGraphNode[];
  invariants: StudioGraphNode[];
  parameters: StudioGraphNode[];
}) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="card" style={{ padding: 22 }}>
        <Kicker style={{ marginBottom: 8 }}>SEMANTIC CLASSES</Kicker>
        {semantics.length === 0 ? <EmptyLine>No semantic class node was returned.</EmptyLine> : <NodeList nodes={semantics} />}
      </div>
      <div className="card" style={{ padding: 22 }}>
        <Kicker style={{ marginBottom: 8 }}>INVARIANTS</Kicker>
        {invariants.length === 0 ? <EmptyLine>No invariant nodes were returned.</EmptyLine> : <NodeList nodes={invariants} />}
      </div>
      <div className="card" style={{ padding: 22 }}>
        <Kicker style={{ marginBottom: 8 }}>PARAMETERS</Kicker>
        {parameters.length === 0 ? <EmptyLine>No parameter nodes were returned.</EmptyLine> : <NodeList nodes={parameters} />}
      </div>
    </div>
  );
}

function NodeList({ nodes }: { nodes: StudioGraphNode[] }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {nodes.map((node) => (
        <div key={node.id} style={{ border: "1px solid var(--rt-slate-line)", borderRadius: 6, padding: 12, background: "var(--rt-slate-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Pill kind="info">{node.kind}</Pill>
            <span style={{ font: "600 13px Inter", color: "var(--rt-off-white)" }}>{node.label}</span>
          </div>
          <div style={{ font: "400 12px/1.5 Inter", color: "var(--rt-fg-2)", marginBottom: 8 }}>{node.meaning}</div>
          {node.source_path && (
            <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>{node.source_path}</div>
          )}
          {Object.keys(node.meta ?? {}).length > 0 && <MetaTable meta={node.meta} compact />}
        </div>
      ))}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "var(--rt-slate-2)", border: "1px solid var(--rt-slate-line)", borderRadius: 6, padding: "12px 14px" }}>
      <Kicker style={{ marginBottom: 6 }}>{label}</Kicker>
      <div style={{ font: '500 13px "IBM Plex Mono"', color: "var(--rt-off-white)" }}>{value}</div>
    </div>
  );
}

function EmptyLine({ children }: { children: string }) {
  return <div style={{ color: "var(--rt-fog-dim)", font: "400 13px Inter" }}>{children}</div>;
}

function MetaTable({ meta, compact }: { meta?: Record<string, string | number | boolean | null>; compact?: boolean }) {
  const entries = Object.entries(meta ?? {});
  if (entries.length === 0) return <EmptyLine>No metadata on this node.</EmptyLine>;
  return (
    <table className="ptable" style={{ marginTop: compact ? 10 : 0 }}>
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key}><td>{key}</td><td>{String(value ?? "null")}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function rawAdapterArtifactId(adapter: StudioGraphNode | null): string | null {
  const source = adapter?.source_path;
  if (!source) return null;
  const file = source.split("/").pop();
  return file ? `adapter:${file}` : null;
}

import { useEffect, useMemo, useState } from "react";

import { api, type Graph, type GraphNode, type Workspace } from "../api";

interface Props {
  workspace: Workspace;
}

const KIND_COLUMNS: Record<GraphNode["kind"], number> = {
  workspace: 0,
  adapter: 1,
  semantics: 2,
  persona: 3,
  scenario: 3,
  campaign: 3,
  parameter: 3,
  invariant: 4,
  engine: 5,
  run: 6,
  report: 7,
  pack: 7
};

const COLUMN_TITLES: Record<number, string> = {
  0: "Workspace",
  1: "Adapter",
  2: "Semantics",
  3: "Personas / scenario / campaign",
  4: "Invariants",
  5: "Engine",
  6: "Runs",
  7: "Reports & packs"
};

const NODE_W = 200;
const NODE_H = 56;
const COL_W = 240;
const ROW_H = 76;
const PAD_X = 24;
const PAD_Y = 56;

export function DiagramView({ workspace }: Props) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGraph(null);
    setError(null);
    void (async () => {
      try {
        const g = await api.graph(workspace.id);
        if (!cancelled) setGraph(g);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  const layout = useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);
  const selectedNode = graph?.nodes.find((n) => n.id === selected) ?? null;

  return (
    <>
      <div className="rt-page-kicker">SIMULATION DIAGRAM</div>
      <h1>{workspace.label}</h1>
      <p>
        Adapter, semantics, personas, scenario/campaign, invariants, engine, runs, and report/pack
        flow rendered locally. Click a node for source path and meaning.
      </p>

      {error ? (
        <div className="rt-empty">
          <strong>Could not load diagram.</strong>
          {error}
        </div>
      ) : null}

      {graph && layout ? (
        <>
          <div className="rt-diagram-wrap">
            <svg
              className="rt-diagram-svg"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
            >
              {layout.columnTitles.map((c, i) => (
                <text
                  key={i}
                  x={c.x}
                  y={20}
                  fill="var(--rt-fog-dim)"
                  fontFamily="var(--rt-font-mono)"
                  fontSize={10}
                  letterSpacing="0.14em"
                  textAnchor="start"
                >
                  {c.title.toUpperCase()}
                </text>
              ))}
              {layout.edges.map((edge) => (
                <g key={edge.id} className="rt-diagram-edge">
                  <line x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} />
                  {edge.label ? (
                    <text x={(edge.x1 + edge.x2) / 2} y={(edge.y1 + edge.y2) / 2 - 4} textAnchor="middle">
                      {edge.label}
                    </text>
                  ) : null}
                </g>
              ))}
              {layout.nodes.map((n) => (
                <g
                  key={n.node.id}
                  className="rt-diagram-node"
                  data-kind={n.node.kind}
                  data-selected={n.node.id === selected}
                  transform={`translate(${n.x}, ${n.y})`}
                  onClick={() => setSelected(n.node.id)}
                  style={{ cursor: "pointer" }}
                >
                  <rect width={NODE_W} height={NODE_H} rx={8} ry={8} />
                  <text x={10} y={20} className="rt-diagram-label">
                    {n.node.kind.toUpperCase()}
                  </text>
                  <text x={10} y={38}>
                    {truncate(n.node.label, 26)}
                  </text>
                </g>
              ))}
            </svg>
          </div>

          {selectedNode ? (
            <div className="rt-detail-panel">
              <h3>{selectedNode.label}</h3>
              <div className="rt-meta">
                {selectedNode.kind}
                {selectedNode.source_path ? ` · ${selectedNode.source_path}` : ""}
              </div>
              <p>{selectedNode.meaning}</p>
              {selectedNode.meta && Object.keys(selectedNode.meta).length > 0 ? (
                <pre className="rt-code-block">{JSON.stringify(selectedNode.meta, null, 2)}</pre>
              ) : null}
            </div>
          ) : null}

          {graph.warnings.length > 0 ? (
            <ul className="rt-warning-list" style={{ marginTop: 12 }}>
              {graph.warnings.map((w, i) => (
                <li key={i}>
                  <strong>{w.message}.</strong> {w.next_action}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : !error ? (
        <div className="rt-empty">Loading diagram…</div>
      ) : null}
    </>
  );
}

interface PositionedNode {
  node: GraphNode;
  x: number;
  y: number;
}

interface PositionedEdge {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
}

interface Layout {
  width: number;
  height: number;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  columnTitles: { x: number; title: string }[];
}

function layoutGraph(graph: Graph): Layout {
  const columns = new Map<number, GraphNode[]>();
  for (const node of graph.nodes) {
    const col = KIND_COLUMNS[node.kind] ?? 3;
    const list = columns.get(col) ?? [];
    list.push(node);
    columns.set(col, list);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  for (const [col, list] of columns.entries()) {
    list.sort((a, b) => a.label.localeCompare(b.label));
    list.forEach((node, idx) => {
      const x = PAD_X + col * COL_W;
      const y = PAD_Y + idx * ROW_H;
      positions.set(node.id, { x, y });
    });
    maxRows = Math.max(maxRows, list.length);
  }
  const usedColumns = Array.from(columns.keys()).sort((a, b) => a - b);
  const positionedNodes: PositionedNode[] = graph.nodes.map((node) => {
    const p = positions.get(node.id) ?? { x: PAD_X, y: PAD_Y };
    return { node, x: p.x, y: p.y };
  });
  const positionedEdges: PositionedEdge[] = graph.edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) {
      return { id: edge.id, x1: 0, y1: 0, x2: 0, y2: 0, label: "" };
    }
    return {
      id: edge.id,
      x1: from.x + NODE_W,
      y1: from.y + NODE_H / 2,
      x2: to.x,
      y2: to.y + NODE_H / 2,
      label: edge.label
    };
  });
  const colCount = usedColumns.length === 0 ? 1 : (usedColumns.at(-1) ?? 0) + 1;
  const width = Math.max(800, PAD_X * 2 + colCount * COL_W);
  const height = Math.max(320, PAD_Y + maxRows * ROW_H + 24);
  const columnTitles = usedColumns.map((c) => ({
    x: PAD_X + c * COL_W,
    title: COLUMN_TITLES[c] ?? `Column ${c}`
  }));
  return { width, height, nodes: positionedNodes, edges: positionedEdges, columnTitles };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

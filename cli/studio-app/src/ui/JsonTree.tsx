import { useMemo, useState } from "react";

import { Icon } from "./Icon";

interface JsonTreeProps {
  body: string;
}

const INITIAL_OPEN_DEPTH = 1;
const ARRAY_PREVIEW_LIMIT = 25;

export function JsonTree({ body }: JsonTreeProps) {
  const parsed = useMemo<{ ok: true; value: unknown } | { ok: false; error: string }>(() => {
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }, [body]);
  const [filter, setFilter] = useState("");

  if (!parsed.ok) {
    return (
      <pre className="code" style={{ whiteSpace: "pre-wrap" }}>
        {body}
      </pre>
    );
  }

  return (
    <div className="jtree">
      <div className="jtree__toolbar">
        <div className="search jtree__search">
          <Icon name="search" size={12} color="var(--rt-fog-dim)" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter keys or values..."
          />
        </div>
        <button
          className="btn btn--quiet btn--sm"
          onClick={() => navigator.clipboard?.writeText(JSON.stringify(parsed.value, null, 2))}
        >
          <Icon name="copy" size={12} /> Copy JSON
        </button>
      </div>
      <div className="jtree__body">
        <Node value={parsed.value} depth={0} path="" filter={filter.trim().toLowerCase()} keyName={null} />
      </div>
    </div>
  );
}

interface NodeProps {
  value: unknown;
  depth: number;
  path: string;
  keyName: string | null;
  filter: string;
}

function Node({ value, depth, path, keyName, filter }: NodeProps) {
  const [open, setOpen] = useState(depth < INITIAL_OPEN_DEPTH);

  if (value === null) return <Leaf keyName={keyName} value="null" valueClass="jtree__null" filter={filter} path={path} />;

  const t = typeof value;
  if (t === "string") {
    return <Leaf keyName={keyName} value={`"${value as string}"`} valueClass="jtree__string" filter={filter} path={path} />;
  }
  if (t === "number" || t === "boolean") {
    return <Leaf keyName={keyName} value={String(value)} valueClass={t === "number" ? "jtree__num" : "jtree__bool"} filter={filter} path={path} />;
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);

  // Hide collections that don't contain a filter match.
  if (filter && !nodeMatches(value, keyName, filter)) return null;

  // Auto-expand when filtering.
  const expanded = filter ? true : open;

  const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;
  const previewEntries = isArray && entries.length > ARRAY_PREVIEW_LIMIT && !filter
    ? entries.slice(0, ARRAY_PREVIEW_LIMIT)
    : entries;
  const truncated = previewEntries.length < entries.length;

  return (
    <div className="jtree__node">
      <button
        type="button"
        className="jtree__row"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={expanded ? "chevronDown" : "chevron"} size={11} color="var(--rt-fog-dim)" />
        {keyName != null && <span className="jtree__key">{keyName}:</span>}
        <span className="jtree__summary">
          {isArray ? "Array" : "Object"} {summary}
        </span>
      </button>
      {expanded && (
        <div className="jtree__children">
          {previewEntries.map(([k, v]) => (
            <Node
              key={k}
              keyName={k}
              value={v}
              depth={depth + 1}
              path={path ? `${path}.${k}` : k}
              filter={filter}
            />
          ))}
          {truncated && (
            <div className="jtree__truncated">
              {entries.length - previewEntries.length} more items hidden — use filter to find specific entries.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface LeafProps {
  keyName: string | null;
  value: string;
  valueClass: string;
  filter: string;
  path: string;
}

function Leaf({ keyName, value, valueClass, filter, path }: LeafProps) {
  if (filter) {
    const haystack = `${path} ${keyName ?? ""} ${value}`.toLowerCase();
    if (!haystack.includes(filter)) return null;
  }
  return (
    <div className="jtree__leaf">
      {keyName != null && <span className="jtree__key">{keyName}:</span>}
      <span className={valueClass}>{value}</span>
    </div>
  );
}

function nodeMatches(value: unknown, keyName: string | null, filter: string): boolean {
  if (keyName != null && keyName.toLowerCase().includes(filter)) return true;
  if (value === null) return "null".includes(filter);
  if (typeof value === "string") return value.toLowerCase().includes(filter);
  if (typeof value === "number" || typeof value === "boolean") return String(value).includes(filter);
  if (Array.isArray(value)) return value.some((v, i) => nodeMatches(v, String(i), filter));
  return Object.entries(value as Record<string, unknown>).some(([k, v]) => nodeMatches(v, k, filter));
}

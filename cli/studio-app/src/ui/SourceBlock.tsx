import { useEffect, useState } from "react";

import { api } from "../api";
import type { StudioSourcePayload } from "../studioTypes";
import { Icon } from "./Icon";
import { Kicker } from "./primitives";

interface SourceBlockProps {
  workspaceId: string;
  sourcePath: string | undefined | null;
  title?: string;
}

export function SourceBlock({ workspaceId, sourcePath, title = "SOURCE" }: SourceBlockProps) {
  const [payload, setPayload] = useState<StudioSourcePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setPayload(null);
    setError(null);
    setCopied(false);
    if (!sourcePath) return;
    let cancelled = false;
    setLoading(true);
    api
      .source({ workspaceId, path: sourcePath })
      .then((res) => {
        if (!cancelled) setPayload(res);
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
  }, [workspaceId, sourcePath]);

  if (!sourcePath) return null;

  function handleCopy() {
    if (!payload) return;
    navigator.clipboard.writeText(payload.content).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => undefined
    );
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <Kicker>{title}</Kicker>
        {payload && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>
              {payload.path} · {formatBytes(payload.bytes)}
            </span>
            <button className="btn btn--ghost btn--sm" onClick={handleCopy} disabled={!payload}>
              <Icon name="copy" size={12} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </div>
      {loading && <div style={{ font: "400 13px Inter", color: "var(--rt-fog-dim)" }}>Loading source…</div>}
      {error && (
        <div style={{ font: "400 13px Inter", color: "var(--rt-fail)" }}>
          Could not load source: {error}
        </div>
      )}
      {payload && (
        <pre
          style={{
            margin: 0,
            padding: 14,
            background: "#0A1620",
            border: "1px solid var(--rt-slate-line)",
            borderRadius: 6,
            font: '400 12.5px/1.55 "IBM Plex Mono", monospace',
            color: "var(--rt-fg-2)",
            overflow: "auto",
            maxHeight: 440,
            whiteSpace: "pre",
            tabSize: 2
          }}
        >
          {payload.content}
        </pre>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

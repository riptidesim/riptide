import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

import { Icon } from "./Icon";
import { Kicker, Pill, type PillKind } from "./primitives";

marked.setOptions({ gfm: true, breaks: true });

interface ParsedSection {
  level: number;
  title: string;
  anchor: string;
  body: string;
}

interface ParsedReport {
  title: string | null;
  preambleNote: string | null;
  preambleTail: string | null;
  headline: string | null;
  recommendation: string | null;
  narrative: string | null;
  metadata: Record<string, string>;
  kpis: Array<{ label: string; value: string; kind: PillKind | "neutral"; raw: string }>;
  sections: ParsedSection[];
}

function metricKey(raw: string): string {
  return raw.toLowerCase().replace(/[\s-]+/g, "_");
}

interface CollapsedMetric {
  name: string;
  value?: string;
  avg?: string;
  min?: string;
  max?: string;
}

interface MetricGroup {
  namespace: string;
  metrics: CollapsedMetric[];
}

function groupCollapseMetrics(
  kpis: Array<{ raw: string; value: string }>
): MetricGroup[] | null {
  if (kpis.length === 0) return null;
  // First, fold {x_avg, x_max, x_min} triplets into a single entry.
  const folded = new Map<string, CollapsedMetric>();
  for (const k of kpis) {
    const m = k.raw.match(/^(.+)_(avg|max|min)$/i);
    if (m) {
      const base = m[1];
      const agg = m[2].toLowerCase() as "avg" | "max" | "min";
      const entry = folded.get(base) ?? { name: base };
      entry[agg] = k.value;
      folded.set(base, entry);
    } else {
      folded.set(k.raw, { name: k.raw, value: k.value });
    }
  }
  // Group by first dot-separated namespace.
  const groupMap = new Map<string, CollapsedMetric[]>();
  for (const metric of folded.values()) {
    const segments = metric.name.split(".");
    const ns = segments.length > 1 ? segments[0] : "other";
    const local = segments.length > 1 ? segments.slice(1).join(".") : metric.name;
    const arr = groupMap.get(ns) ?? [];
    arr.push({ ...metric, name: local });
    groupMap.set(ns, arr);
  }
  // Stable order: keep namespaces in the order they first appeared.
  const seen = new Set<string>();
  const order: string[] = [];
  for (const k of kpis) {
    const m = k.raw.match(/^(.+?)_(avg|max|min)$/i);
    const base = (m ? m[1] : k.raw).split(".")[0];
    const ns = base.includes(".") ? base.split(".")[0] : (k.raw.includes(".") ? k.raw.split(".")[0] : "other");
    if (!seen.has(ns)) {
      seen.add(ns);
      order.push(ns);
    }
  }
  // Anything in groupMap not yet ordered (defensive)
  for (const ns of groupMap.keys()) if (!seen.has(ns)) order.push(ns);
  return order
    .filter((ns) => groupMap.has(ns))
    .map((ns) => ({ namespace: ns, metrics: groupMap.get(ns)! }));
}

function fmtNum(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (Number.isInteger(n)) return n.toLocaleString();
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2);
}

function fmtPct(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  // Heuristic: values 0..1 are ratios; bigger numbers are already in percent.
  const pct = n >= 0 && n <= 1 ? n * 100 : n;
  return `${pct < 1 && pct > 0 ? pct.toFixed(2) : pct.toFixed(0)}%`;
}

function buildNarrative(
  kpis: Array<{ raw: string; value: string }>,
  metadata: Record<string, string>
): string | null {
  const map = new Map<string, string>();
  for (const k of kpis) map.set(metricKey(k.raw), k.value);
  for (const [k, v] of Object.entries(metadata)) map.set(metricKey(k), v);

  // Lending-style run summary
  if (map.has("final_tvl") || map.has("total_bad_debt") || map.has("total_liquidations")) {
    return buildLendingNarrative(map);
  }
  // Sweep / cells summary (sweep-report.md)
  if (map.has("sweep_size") || map.has("completed_cells")) {
    return buildSweepNarrative(map);
  }
  return null;
}

function buildLendingNarrative(map: Map<string, string>): string | null {
  const parts: string[] = [];

  const tvl = map.get("final_tvl");
  const util = map.get("final_utilization");
  if (tvl != null && util != null) {
    parts.push(`TVL ended at ${fmtNum(tvl)}, with ${fmtPct(util)} borrow utilization.`);
  } else if (tvl != null) {
    parts.push(`TVL ended at ${fmtNum(tvl)}.`);
  } else if (util != null) {
    parts.push(`Borrow utilization ended at ${fmtPct(util)}.`);
  }

  const debt = map.get("total_bad_debt");
  const liq = map.get("total_liquidations");
  const debtN = debt != null ? Number(debt) : null;
  const liqN = liq != null ? Number(liq) : null;
  const safety: string[] = [];
  if (debt != null) {
    safety.push(debtN === 0 ? "no bad debt" : `${fmtNum(debt)} in bad debt`);
  }
  if (liq != null) {
    safety.push(liqN === 0 ? "no liquidations" : `${liqN} liquidation${liqN === 1 ? "" : "s"}`);
  }
  if (safety.length > 0) {
    const phrase = safety.join(", ");
    parts.push(`${phrase[0].toUpperCase()}${phrase.slice(1)}.`);
  }

  const dd = map.get("largest_single_tick_drawdown");
  if (dd != null) {
    parts.push(`Worst single-tick drawdown was ${fmtPct(dd)}.`);
  }

  return parts.length >= 2 ? parts.join(" ") : null;
}

function buildSweepNarrative(map: Map<string, string>): string | null {
  const size = map.get("sweep_size");
  const completed = map.get("completed_cells") ?? map.get("completed");
  const fired = map.get("fired") ?? map.get("invariant_fires");
  const parts: string[] = [];
  if (size != null && completed != null) {
    parts.push(`${completed} of ${size} cells completed.`);
  }
  if (fired != null) {
    const n = Number(fired);
    parts.push(n === 0 ? "No invariant fires across the sweep." : `${fired} invariant fires across the sweep.`);
  }
  return parts.length >= 2 ? parts.join(" ") : null;
}

function firstParagraph(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const paragraphs = trimmed.split(/\n\s*\n/);
  for (const p of paragraphs) {
    const text = p.trim();
    if (!text) continue;
    if (text.startsWith("|")) continue;
    if (/^[-*]\s/.test(text)) continue;
    if (text.startsWith("#")) continue;
    if (text.startsWith(">")) continue;
    return text;
  }
  return null;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function humanize(key: string): string {
  const cleaned = key.replace(/[_-]+/g, " ").trim();
  if (!cleaned) return key;
  return cleaned[0].toUpperCase() + cleaned.slice(1);
}

function stripCode(value: string): string {
  // Only strip backticks if the entire value is wrapped in them (single-token
  // like a path). Multi-token values keep inline backticks so we can render
  // them through marked.parseInline() into `<code>` spans.
  const trimmed = value.trim();
  if (/^`[^`]+`$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

function renderInline(value: string): string {
  try {
    const html = marked.parseInline(value, { async: false });
    return typeof html === "string" ? html : value;
  } catch {
    return value;
  }
}

function parseBullets(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+\*\*([^*]+?)\*\*\s*:?\s*(.+)$/);
    if (!m) continue;
    const key = m[1].replace(/:$/, "").trim();
    out[key] = stripCode(m[2].trim());
  }
  return out;
}

function stripFirstTable(block: string): string {
  const lines = block.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i].trim();
    const b = (lines[i + 1] ?? "").trim();
    if (a.startsWith("|") && /^\|[\s:|-]+\|?$/.test(b)) {
      start = i;
      break;
    }
  }
  if (start === -1) return block;
  let end = start + 2;
  while (end < lines.length && lines[end].trim().startsWith("|")) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
}

function parseFirstTable(block: string): { headers: string[]; rows: string[][] } | null {
  const lines = block.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i].trim();
    const b = (lines[i + 1] ?? "").trim();
    if (a.startsWith("|") && /^\|[\s:|-]+\|?$/.test(b)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const splitRow = (l: string) =>
    l
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  const headers = splitRow(lines[start]);
  const rows: string[][] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("|")) break;
    const cells = splitRow(t);
    // Cell values can contain unescaped pipes (e.g. "discrete(a|b|c)") which
    // makes the naive splitter produce more cells than the header. Collapse
    // any extras into the last expected column so the table stays aligned.
    if (cells.length > headers.length && headers.length > 0) {
      const overflow = cells.splice(headers.length - 1).join(" | ");
      cells.push(overflow);
    }
    while (cells.length < headers.length) cells.push("");
    rows.push(cells);
  }
  return { headers, rows };
}

function kpiKindFor(label: string, value: string): PillKind | "neutral" {
  const v = value.replace(/[%,]/g, "").trim();
  const num = Number(v);
  const finite = Number.isFinite(num);
  const lower = label.toLowerCase();
  const status = value.toLowerCase();
  if (status === "pass" || status === "all_pass" || status === "ok") return "pass";
  if (status === "fail" || status === "failed" || status === "error") return "fail";
  if (/(bad[_ ]?debt|liquidat|drawdown|loss|fires?|fired|failures?|errors?)/.test(lower)) {
    if (finite && num === 0) return "pass";
    if (finite && num > 0) return "warn";
  }
  return "neutral";
}

const KPI_LIMIT = 200;

export function parseRiptideReport(body: string): ParsedReport {
  const lines = body.split("\n");
  let title: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^# (.+)$/);
    if (m) {
      title = m[1].trim();
      i++;
      break;
    }
    i++;
  }

  const preambleBuf: string[] = [];
  while (i < lines.length && !/^#{2,3} /.test(lines[i])) {
    preambleBuf.push(lines[i]);
    i++;
  }

  const metadata = parseBullets(preambleBuf);
  const preambleNote =
    preambleBuf
      .map((l) => l.trim())
      .find((l) => l.startsWith(">"))
      ?.replace(/^>+\s*/, "") ?? null;
  const preambleTailLines = preambleBuf.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith(">")) return false;
    if (/^[-*]\s+\*\*/.test(t)) return false;
    return true;
  });
  const preambleTail = preambleTailLines.length > 0 ? preambleTailLines.join("\n").trim() : null;

  const sections: ParsedSection[] = [];
  while (i < lines.length) {
    const m = lines[i].match(/^(#{2,3}) (.+)$/);
    if (!m) {
      i++;
      continue;
    }
    const level = m[1].length;
    const sectionTitle = m[2].trim();
    i++;
    const buf: string[] = [];
    while (i < lines.length && !/^#{1,3} /.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    sections.push({ level, title: sectionTitle, anchor: slug(sectionTitle), body: buf.join("\n").trim() });
  }

  // If the preamble had no metadata bullets, look at the first metadata-shaped section.
  if (Object.keys(metadata).length === 0) {
    const meta = sections.find((s) => /metadata$/i.test(s.title) || /^run\s/i.test(s.title));
    if (meta) {
      const found = parseBullets(meta.body.split("\n"));
      for (const [k, v] of Object.entries(found)) metadata[k] = v;
      if (Object.keys(found).length > 0) {
        // Drop that section so it isn't repeated below.
        const idx = sections.indexOf(meta);
        if (idx >= 0) sections.splice(idx, 1);
      }
    }
  }

  const kpis: ParsedReport["kpis"] = [];
  const summarySection = sections.find((s) => /summary|cells/i.test(s.title));
  if (summarySection) {
    const t = parseFirstTable(summarySection.body);
    if (t && t.headers.length === 2) {
      for (const row of t.rows) {
        if (row.length < 2) continue;
        const label = humanize(row[0]);
        const value = row[1];
        kpis.push({ label, value, kind: kpiKindFor(row[0], value), raw: row[0] });
        if (kpis.length >= KPI_LIMIT) break;
      }
      // Strip the consumed table from the section so it doesn't render again.
      summarySection.body = stripFirstTable(summarySection.body);
    }
  }

  // Pull the "**Agent lifecycle**: N active, M liquidated, K depleted" line
  // out of any section and surface it as agents.* metrics so the orphaned
  // Summary section that only held this line goes away.
  for (const s of sections) {
    const match = s.body.match(
      /\*\*Agent lifecycle\*\*:\s*(\d+)\s*active(?:,\s*(\d+)\s*liquidated)?(?:,\s*(\d+)\s*depleted)?/i
    );
    if (!match) continue;
    const [whole, active, liquidated, depleted] = match;
    const agentRows: Array<[string, string]> = [];
    if (active != null) agentRows.push(["agents.active", active]);
    if (liquidated != null) agentRows.push(["agents.liquidated", liquidated]);
    if (depleted != null) agentRows.push(["agents.depleted", depleted]);
    for (const [raw, value] of agentRows) {
      kpis.push({ label: humanize(raw), value, kind: kpiKindFor(raw, value), raw });
    }
    s.body = s.body.replace(whole, "").replace(/\n{3,}/g, "\n\n").trim();
    break;
  }

  if (kpis.length === 0) {
    for (const s of sections) {
      if (!/outcome|summary|results/i.test(s.title)) continue;
      const bullets = parseBullets(s.body.split("\n"));
      if (Object.keys(bullets).length < 3) continue;
      for (const [k, v] of Object.entries(bullets)) {
        kpis.push({ label: humanize(k), value: v, kind: kpiKindFor(k, v), raw: k });
        if (kpis.length >= KPI_LIMIT) break;
      }
      // Strip the bullets we promoted so the section doesn't repeat them.
      const remaining = s.body
        .split("\n")
        .filter((line) => !/^\s*[-*]\s+\*\*/.test(line))
        .join("\n")
        .trim();
      s.body = remaining;
      break;
    }
  }

  let headline: string | null = null;
  const outcomeSection = sections.find((s) => /^outcome$/i.test(s.title));
  if (outcomeSection) {
    const para = firstParagraph(outcomeSection.body);
    if (para) {
      headline = para;
      outcomeSection.body = outcomeSection.body.replace(para, "").trim();
    }
  }
  if (!headline && metadata.Outcome) {
    headline = metadata.Outcome;
  }
  if (headline && metadata.Outcome === headline) {
    delete metadata.Outcome;
  }

  let recommendation: string | null = null;
  const recoSection = sections.find((s) => /^recommendation$/i.test(s.title));
  if (recoSection) {
    const para = firstParagraph(recoSection.body);
    if (para) {
      recommendation = para;
      recoSection.body = recoSection.body.replace(para, "").trim();
    }
  }

  const finalSections = sections.filter((s) => s.body.length > 0);

  const narrative = buildNarrative(kpis, metadata);

  return {
    title,
    preambleNote,
    preambleTail,
    headline,
    recommendation,
    narrative,
    metadata,
    kpis,
    sections: finalSections
  };
}

function renderMarkdown(body: string): string {
  try {
    const html = marked.parse(body, { async: false });
    return typeof html === "string" ? html : "";
  } catch {
    return body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

interface ReportRendererProps {
  body: string;
}

export function ReportRenderer({ body }: ReportRendererProps) {
  const parsed = useMemo(() => parseRiptideReport(body), [body]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(parsed.sections[0]?.anchor ?? null);

  useEffect(() => {
    setActiveAnchor(parsed.sections[0]?.anchor ?? null);
  }, [parsed]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const headings = Array.from(root.querySelectorAll<HTMLElement>("[data-section-anchor]"));
    if (headings.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          const anchor = visible[0].target.getAttribute("data-section-anchor");
          if (anchor) setActiveAnchor(anchor);
        }
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: 0 }
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [parsed.sections.length]);

  const [showRawMetrics, setShowRawMetrics] = useState(false);
  const hasStructure =
    parsed.headline != null ||
    parsed.recommendation != null ||
    parsed.narrative != null ||
    parsed.kpis.length > 0 ||
    Object.keys(parsed.metadata).length > 0 ||
    parsed.sections.length > 0;

  if (!hasStructure) {
    return (
      <div
        className="chat-md"
        style={{ color: "var(--rt-fg-2)", font: "400 14px/1.6 Inter" }}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
      />
    );
  }

  function jumpTo(anchor: string) {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-section-anchor="${anchor}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveAnchor(anchor);
  }

  const showToc = parsed.sections.length >= 2;

  return (
    <div className="rrep" ref={containerRef}>
      {parsed.preambleNote && (
        <div className="rrep__note">
          <Icon name="shield" size={12} color="var(--rt-fog-dim)" />
          <span>{parsed.preambleNote}</span>
        </div>
      )}
      {(parsed.headline || parsed.recommendation) && (
        <div className="rrep__hero">
          {parsed.headline && (
            <div className="rrep__hero-block">
              <Kicker accent>WHAT HAPPENED</Kicker>
              <div
                className="rrep__hero-line chat-md"
                dangerouslySetInnerHTML={{ __html: renderInline(parsed.headline) }}
              />
            </div>
          )}
          {parsed.recommendation && (
            <div className="rrep__hero-block">
              <Kicker>NEXT STEP</Kicker>
              <div
                className="rrep__hero-next chat-md"
                dangerouslySetInnerHTML={{ __html: renderInline(parsed.recommendation) }}
              />
            </div>
          )}
        </div>
      )}
      {parsed.narrative && (
        <div className="rrep__glance">
          <Kicker style={{ marginBottom: 6 }}>AT A GLANCE</Kicker>
          <p className="rrep__glance-line">{parsed.narrative}</p>
        </div>
      )}

      {parsed.kpis.length > 0 && (
        <MetricsBlock
          kpis={parsed.kpis}
          collapsed={parsed.narrative != null && !showRawMetrics}
          onToggle={parsed.narrative != null ? () => setShowRawMetrics((s) => !s) : null}
          expanded={showRawMetrics}
        />
      )}

      {Object.keys(parsed.metadata).length > 0 && (
        <div className="rrep__meta">
          <Kicker style={{ marginBottom: 10 }}>RUN METADATA</Kicker>
          <div className="rrep__meta-grid">
            {Object.entries(parsed.metadata).map(([k, v]) => (
              <div key={k} className="rrep__meta-row">
                <div className="rrep__meta-key">{humanize(k)}</div>
                <div
                  className="rrep__meta-val chat-md"
                  title={v}
                  dangerouslySetInnerHTML={{ __html: renderInline(v) }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {parsed.preambleTail && (
        <div
          className="chat-md rrep__md"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.preambleTail) }}
        />
      )}

      <div className={`rrep__body${showToc ? " rrep__body--with-toc" : ""}`}>
        <div className="rrep__sections">
          {parsed.sections.map((s) => (
            <section
              key={s.anchor}
              data-section-anchor={s.anchor}
              id={`rrep-${s.anchor}`}
              className="rrep__section"
            >
              <h3 className="rrep__section-title">
                <a href={`#rrep-${s.anchor}`} className="rrep__anchor" aria-label="Anchor link">
                  #
                </a>
                {s.title}
              </h3>
              <SectionBody body={s.body} />
            </section>
          ))}
        </div>
        {showToc && (
          <nav className="rrep__toc" aria-label="Report sections">
            <Kicker style={{ marginBottom: 10 }}>ON THIS PAGE</Kicker>
            <ul>
              {parsed.sections.map((s) => (
                <li key={s.anchor}>
                  <button
                    type="button"
                    className={`rrep__toc-link${activeAnchor === s.anchor ? " is-active" : ""}`}
                    onClick={() => jumpTo(s.anchor)}
                  >
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </div>
  );
}

const TABLE_FILTER_THRESHOLD = 12;

function SectionBody({ body }: { body: string }) {
  const table = useMemo(() => parseFirstTable(body), [body]);
  const [filter, setFilter] = useState("");

  if (!table) {
    return (
      <div
        className="chat-md rrep__md"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
      />
    );
  }

  const before = body.split("\n").slice(0, body.split("\n").findIndex((l) => l.trim().startsWith("|"))).join("\n").trim();
  const lastTableLineIdx = (() => {
    const lines = body.split("\n");
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("|")) last = i;
    }
    return last;
  })();
  const after = body
    .split("\n")
    .slice(lastTableLineIdx + 1)
    .join("\n")
    .trim();

  const lower = filter.trim().toLowerCase();
  const filtered = lower
    ? table.rows.filter((r) => r.some((c) => c.toLowerCase().includes(lower)))
    : table.rows;

  return (
    <div className="rrep__md">
      {before && (
        <div className="chat-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(before) }} />
      )}
      {table.rows.length > TABLE_FILTER_THRESHOLD && (
        <div className="rrep__table-toolbar">
          <div className="search rrep__table-search">
            <Icon name="search" size={12} color="var(--rt-fog-dim)" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${table.rows.length} rows...`}
            />
          </div>
          <span className="rrep__table-count">
            {filtered.length} / {table.rows.length}
          </span>
        </div>
      )}
      <div className="rrep__table-wrap">
        <table className="rrep__table">
          <thead>
            <tr>
              {table.headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, rIdx) => (
              <tr key={rIdx}>
                {row.map((cell, cIdx) => (
                  <td key={cIdx}>
                    {isStatusCell(table.headers[cIdx]) ? (
                      <Pill kind={statusPill(cell)}>{cell || "—"}</Pill>
                    ) : (
                      cell || "—"
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td className="rrep__table-empty" colSpan={table.headers.length}>
                  No rows match "{filter}"
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {after && (
        <div className="chat-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(after) }} />
      )}
    </div>
  );
}

interface MetricsBlockProps {
  kpis: Array<{ label: string; value: string; kind: PillKind | "neutral"; raw: string }>;
  collapsed: boolean;
  expanded: boolean;
  onToggle: (() => void) | null;
}

function MetricsBlock({ kpis, collapsed, expanded, onToggle }: MetricsBlockProps) {
  const groups = useMemo(() => groupCollapseMetrics(kpis), [kpis]);
  const hasAggregations = useMemo(() => kpis.some((k) => /_(avg|max|min)$/i.test(k.raw)), [kpis]);
  const useGroupedTable = hasAggregations || kpis.length > 6;

  const body = useGroupedTable && groups
    ? (
      <div className="rrep__metric-groups">
        {groups.map((g) => (
          <MetricGroupTable key={g.namespace} group={g} />
        ))}
      </div>
    )
    : (
      <div className="rrep__kpis">
        {kpis.map((k) => (
          <div key={k.raw} className={`rrep__kpi rrep__kpi--${k.kind}`}>
            <div className="rrep__kpi-label">{k.label}</div>
            <div
              className="rrep__kpi-value chat-md"
              dangerouslySetInnerHTML={{ __html: renderInline(k.value) }}
            />
          </div>
        ))}
      </div>
    );

  if (!onToggle) return body;

  const total = kpis.length;
  return (
    <div className="rrep__metrics">
      <button
        type="button"
        className="rrep__metrics-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <Icon name={expanded ? "chevronDown" : "chevron"} size={11} color="var(--rt-fog-dim)" />
        {expanded ? "Hide" : "Show"} all {total} metrics
      </button>
      {!collapsed && body}
    </div>
  );
}

function MetricGroupTable({ group }: { group: MetricGroup }) {
  return (
    <div className="rrep__metric-group">
      <Kicker style={{ marginBottom: 8 }}>{humanize(group.namespace)}</Kicker>
      <table className="rrep__metric-table">
        <tbody>
          {group.metrics.map((m) => (
            <tr key={m.name}>
              <td className="rrep__metric-name">{humanize(m.name)}</td>
              <td className="rrep__metric-value">{renderMetricValue(m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderMetricValue(m: CollapsedMetric): ReactNode {
  if (m.value != null) return fmtNum(m.value);
  const avg = m.avg;
  const min = m.min;
  const max = m.max;
  const allSame = avg != null && avg === min && avg === max;
  if (allSame) return fmtNum(avg!);
  if (min === max && avg != null && min != null) {
    return (
      <>
        <strong>{fmtNum(avg)}</strong>{" "}
        <span className="rrep__metric-range">(steady at {fmtNum(min)})</span>
      </>
    );
  }
  if (avg != null) {
    return (
      <>
        <strong>{fmtNum(avg)}</strong>
        {min != null && max != null && (
          <span className="rrep__metric-range"> · range {fmtNum(min)}–{fmtNum(max)}</span>
        )}
      </>
    );
  }
  if (min != null || max != null) {
    return (
      <span className="rrep__metric-range">
        {min != null && `min ${fmtNum(min)}`}
        {min != null && max != null && " · "}
        {max != null && `max ${fmtNum(max)}`}
      </span>
    );
  }
  return "—";
}

function isStatusCell(header: string | undefined): boolean {
  if (!header) return false;
  return /^(status|verdict|outcome|fires?)$/i.test(header.trim());
}

function statusPill(value: string): PillKind {
  const v = value.toLowerCase().trim();
  if (!v || v === "—" || v === "none" || v === "n/a") return "neutral";
  if (/(pass|ok|success|no[_ -]?failure)/.test(v)) return "pass";
  if (/(fail|error)/.test(v)) return "fail";
  if (/(warn|inconclusive)/.test(v)) return "warn";
  if (/(running|queued)/.test(v)) return "running";
  return "neutral";
}

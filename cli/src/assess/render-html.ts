import type {
  RiskSurfaceAxis,
  RiskSurfaceCell,
  RiskSurfaceDocument
} from "../campaign/surface.js";

import type { AssessmentModel } from "./model.js";

/**
 * render-html.ts — the design-system presentation export (R5).
 *
 * ## What this is
 *
 * A deterministic renderer that turns the canonical, hashed `assessment.md`
 * (R2) into a Riptide-design-system-styled HTML document, with the risk-surface
 * failure-rate heatmap rendered **visually** (a colored CSS/HTML grid built from
 * the model's surface) instead of the markdown glyph table.
 *
 * ## NOT under the byte-hash gate (R5.3 — load-bearing)
 *
 * `assessment.json` + `assessment.md` are the canonical, byte-stable artifacts.
 * This HTML (and any PDF rendered from it) is a *presentation rendering* of the
 * hashed markdown: it derives from those bytes but is explicitly out of the
 * determinism gate, so the look can evolve without moving a hash. The render is
 * nonetheless pure and stable for a fixed `(markdown, model)` pair — no
 * wall-clock, randomness, or insertion-order dependence — so it is testable.
 *
 * ## No new CDN dependency (R5.2)
 *
 * The heatmap is plain HTML + inline styles using the design-system color
 * tokens; there is no chart library and no remote asset. The document uses the
 * Riptide font *stacks* (Inter / IBM Plex Mono) with system fallbacks rather
 * than fetching webfonts, so the export renders identically offline (and a
 * headless-browser PDF pass needs no network).
 */
export interface RenderAssessmentHtmlOptions {
  /** Document `<title>`; defaults to the protocol name. */
  title?: string;
}

export function renderAssessmentHtml(
  markdown: string,
  model: AssessmentModel,
  options: RenderAssessmentHtmlOptions = {}
): string {
  const title = options.title ?? `Protocol assessment — ${model.protocol.name}`;
  let body = markdownToHtml(markdown);

  // Lift the report H1 out of the body and into the branded masthead (R4.1) so
  // the document opens with the Riptide wordmark + report metadata, not a bare
  // heading. The H1 keeps its `rt-h1` chrome (the teal rule) inside the cover.
  const { masthead, body: bodyWithoutH1 } = liftMasthead(body, model);
  body = bodyWithoutH1;

  // Swap the markdown glyph heatmap for a visual one built from the model. The
  // surface-less correctness shape has no heatmap to swap, so skip it.
  const heatmap = model.surface ? renderHeatmapHtml(model.surface) : null;
  const marker = '<h3 class="rt-h3">Failure-rate heatmap</h3>';
  if (heatmap) {
    body = replaceFailureHeatmapSection(body, marker, heatmap);
  }

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    "</head>",
    '<body class="rt-bg">',
    '<main class="rt-doc">',
    masthead,
    body,
    "</main>",
    "</body>",
    "</html>",
    ""
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Masthead / cover (R4.1) — Riptide wordmark + report metadata, design-system
// ---------------------------------------------------------------------------

/**
 * Build the branded masthead from the model and remove the duplicate report H1
 * from the body. The masthead opens the document with the Riptide wordmark, the
 * report title (the `rt-h1` lifted from the body, teal rule intact), the
 * protocol, and a metadata strip (verdict, date, commit) — deterministic, no
 * remote assets (R4.3). Returns the masthead HTML plus the body with its leading
 * H1 stripped so the title is not rendered twice.
 */
function liftMasthead(body: string, model: AssessmentModel): { masthead: string; body: string } {
  const h1Match = body.match(/<h1 class="rt-h1">[\s\S]*?<\/h1>/);
  const titleHtml = h1Match ? h1Match[0] : `<h1 class="rt-h1">${escapeHtml(`Protocol assessment — ${model.protocol.name}`)}</h1>`;
  const strippedBody = h1Match ? body.replace(h1Match[0], "").replace(/^\n+/, "") : body;

  const meta: string[] = [
    metaItem("Protocol", model.protocol.name),
    metaItem("Verdict", model.verdict.value)
  ];
  if (present(model.protocol.assessment_date)) meta.push(metaItem("Date", model.protocol.assessment_date!));
  if (present(model.protocol.commit)) meta.push(metaItem("Commit", model.protocol.commit!));

  const masthead = [
    '<header class="rt-masthead">',
    '<div class="rt-brand"><span class="rt-mark" aria-hidden="true">≈</span><span class="rt-wordmark">RIPTIDE</span><span class="rt-brand-kicker">Protocol assessment</span></div>',
    titleHtml,
    `<dl class="rt-cover-meta">${meta.join("")}</dl>`,
    '<p class="rt-cover-boundary">Simulation evidence over a declared, fixed-seed region — not audit signoff, formal verification, complete protocol safety, or a mainnet prediction.</p>',
    "</header>"
  ].join("\n");

  return { masthead, body: strippedBody };
}

function metaItem(label: string, value: string): string {
  return `<div class="rt-cover-cell"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function present(value: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

function replaceFailureHeatmapSection(body: string, marker: string, heatmap: string): string {
  const start = body.indexOf(marker);
  if (start < 0) return body;

  const contentStart = start + marker.length;
  const nextH3 = body.indexOf('<h3 class="rt-h3">', contentStart);
  const nextH2 = body.indexOf('<h2 class="rt-h2">', contentStart);
  const candidates = [nextH3, nextH2].filter((index) => index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : body.length;
  return `${body.slice(0, contentStart)}\n${heatmap}\n${body.slice(end)}`;
}

// ---------------------------------------------------------------------------
// Visual failure-rate heatmap (R5.2) — built from the model's surface
// ---------------------------------------------------------------------------

interface PooledRate {
  runs: number;
  rate: number | null;
}

/** Render the visual heatmap, or `""` when the surface has no placeable runs. */
function renderHeatmapHtml(surface: RiskSurfaceDocument): string {
  const ranked = surface.sensitivity.ranking;
  if (surface.axes.length === 0 || ranked.length === 0) return "";
  if (!surface.cells.some((cell) => cell.run_count > 0)) return "";

  const rowAxis = axisByName(surface, ranked[0]!.axis);
  if (!rowAxis) return "";
  const colAxis = ranked.length >= 2 ? axisByName(surface, ranked[1]!.axis) ?? null : null;

  return colAxis ? render2dHeatmap(surface, rowAxis, colAxis) : render1dHeatmap(surface, rowAxis);
}

function render2dHeatmap(
  surface: RiskSurfaceDocument,
  rowAxis: RiskSurfaceAxis,
  colAxis: RiskSurfaceAxis
): string {
  const head = [
    `<th class="rt-hm-corner" scope="col">${escapeHtml(rowAxis.name)} ↓ / ${escapeHtml(colAxis.name)} →</th>`,
    ...colAxis.bins.map((bin) => `<th class="rt-hm-axis" scope="col">${escapeHtml(bin.label)}</th>`)
  ].join("");

  const rows = rowAxis.bins
    .map((rowBin) => {
      const cells = colAxis.bins
        .map((colBin) =>
          heatmapCell(
            poolCells(surface.cells, [
              [rowAxis.name, rowBin.index],
              [colAxis.name, colBin.index]
            ])
          )
        )
        .join("");
      return `<tr><th class="rt-hm-axis" scope="row">${escapeHtml(rowBin.label)}</th>${cells}</tr>`;
    })
    .join("\n");

  return [
    '<figure class="rt-heatmap">',
    `<figcaption class="rt-label">Rows: ${escapeHtml(rowAxis.name)} (rank 1) · Columns: ${escapeHtml(colAxis.name)} (rank 2)</figcaption>`,
    '<table class="rt-hm-grid">',
    `<thead><tr>${head}</tr></thead>`,
    `<tbody>\n${rows}\n</tbody>`,
    "</table>",
    HEATMAP_LEGEND,
    "</figure>"
  ].join("\n");
}

function render1dHeatmap(surface: RiskSurfaceDocument, rowAxis: RiskSurfaceAxis): string {
  const rows = rowAxis.bins
    .map((bin) => {
      const pooled = poolCells(surface.cells, [[rowAxis.name, bin.index]]);
      return `<tr><th class="rt-hm-axis" scope="row">${escapeHtml(bin.label)}</th>${heatmapCell(pooled)}<td class="rt-hm-n-col">${pooled.runs}</td></tr>`;
    })
    .join("\n");
  return [
    '<figure class="rt-heatmap">',
    `<figcaption class="rt-label">Axis: ${escapeHtml(rowAxis.name)} (most sensitive)</figcaption>`,
    '<table class="rt-hm-grid">',
    `<thead><tr><th class="rt-hm-corner" scope="col">${escapeHtml(rowAxis.name)}</th><th class="rt-hm-axis" scope="col">Failure rate</th><th class="rt-hm-axis" scope="col">Runs</th></tr></thead>`,
    `<tbody>\n${rows}\n</tbody>`,
    "</table>",
    HEATMAP_LEGEND,
    "</figure>"
  ].join("\n");
}

function heatmapCell(pooled: PooledRate): string {
  if (pooled.rate === null) {
    return '<td class="rt-hm-cell rt-hm-empty">—</td>';
  }
  const bucket = shadeBucket(pooled.rate);
  return (
    `<td class="rt-hm-cell ${bucket.cls}">` +
    `<span class="rt-hm-rate">${formatPercent(pooled.rate)}</span>` +
    `<span class="rt-hm-n">n=${pooled.runs}</span>` +
    "</td>"
  );
}

const HEATMAP_LEGEND =
  '<div class="rt-hm-legend">' +
  '<span class="rt-hm-key rt-hm-b0">0–25%</span>' +
  '<span class="rt-hm-key rt-hm-b1">25–50%</span>' +
  '<span class="rt-hm-key rt-hm-b2">50–75%</span>' +
  '<span class="rt-hm-key rt-hm-b3">75–100%</span>' +
  '<span class="rt-hm-key rt-hm-empty">no runs</span>' +
  "</div>";

function shadeBucket(rate: number): { cls: string } {
  if (rate < 0.25) return { cls: "rt-hm-b0" };
  if (rate < 0.5) return { cls: "rt-hm-b1" };
  if (rate < 0.75) return { cls: "rt-hm-b2" };
  return { cls: "rt-hm-b3" };
}

/**
 * Pool every cell whose coordinates match all `constraints` (axis → bin index),
 * recovering failed counts as `round(rate × run_count)`. Mirrors the
 * surface-narrative pooling so the visual heatmap agrees with the markdown one.
 */
function poolCells(cells: RiskSurfaceCell[], constraints: Array<[string, number]>): PooledRate {
  let runs = 0;
  let failed = 0;
  for (const cell of cells) {
    const match = constraints.every(([axis, binIndex]) =>
      cell.coords.some((coord) => coord.axis === axis && coord.bin_index === binIndex)
    );
    if (!match) continue;
    runs += cell.run_count;
    failed += Math.round(cell.invariant_failure_rate * cell.run_count);
  }
  return { runs, rate: runs === 0 ? null : failed / runs };
}

function axisByName(surface: RiskSurfaceDocument, name: string): RiskSurfaceAxis | undefined {
  return surface.axes.find((axis) => axis.name === name);
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Minimal, deterministic markdown → HTML for the assessment template subset
// ---------------------------------------------------------------------------

/**
 * A focused converter for the constrained markdown `render-markdown.ts` emits:
 * ATX headings, paragraphs, `-`/`- [ ]` bullet lists, fenced code blocks,
 * GFM pipe tables, plus inline bold (`**`) and code (`` ` ``). It is not a
 * general markdown engine; it covers exactly what the assessment template
 * produces so the presentation export stays dependency-free and deterministic.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    // Fenced code block.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      index += 1; // closing fence
      out.push(`<pre class="rt-code"><code>${code.map(escapeHtml).join("\n")}</code></pre>`);
      continue;
    }

    // ATX heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(renderHeading(level, heading[2]!));
      index += 1;
      continue;
    }

    // Pipe table: a `|`-row immediately followed by a separator row.
    if (line.trimStart().startsWith("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]!)) {
      const table: string[] = [line];
      index += 2; // header + separator
      while (index < lines.length && lines[index]!.trimStart().startsWith("|")) {
        table.push(lines[index]!);
        index += 1;
      }
      out.push(renderTable(table));
      continue;
    }

    // Bullet list (including `- [ ]` checklist items).
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*-\s+/.test(lines[index]!)) {
        items.push(renderListItem(lines[index]!));
        index += 1;
      }
      out.push(`<ul class="rt-list">\n${items.join("\n")}\n</ul>`);
      continue;
    }

    // Paragraph: gather consecutive plain lines.
    const para: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim().length > 0 &&
      !/^(#{1,6})\s+/.test(lines[index]!) &&
      !/^```/.test(lines[index]!) &&
      !/^\s*-\s+/.test(lines[index]!) &&
      !(lines[index]!.trimStart().startsWith("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]!))
    ) {
      para.push(lines[index]!);
      index += 1;
    }
    out.push(`<p class="rt-body">${inline(para.join(" "))}</p>`);
  }

  return out.join("\n");
}

function renderHeading(level: number, text: string): string {
  const cls = level === 1 ? "rt-h1" : level === 2 ? "rt-h2" : level === 3 ? "rt-h3" : "rt-subhead";
  const tag = `h${Math.min(level, 4)}`;
  return `<${tag} class="${cls}">${inline(text)}</${tag}>`;
}

function renderListItem(line: string): string {
  const content = line.replace(/^\s*-\s+/, "");
  const checkbox = content.match(/^\[( |x|X)\]\s+(.*)$/);
  if (checkbox) {
    const checked = checkbox[1]!.toLowerCase() === "x";
    return `<li class="rt-check"><span class="rt-box">${checked ? "☑" : "☐"}</span> ${inline(checkbox[2]!)}</li>`;
  }
  return `<li>${inline(content)}</li>`;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?[\s:|-]+\|[\s:|-]*$/.test(trimmed) && trimmed.includes("-");
}

function renderTable(rows: string[]): string {
  const header = splitRow(rows[0]!);
  const bodyRows = rows.slice(1);
  const head = `<tr>${header.map((cellText) => `<th>${inline(cellText)}</th>`).join("")}</tr>`;
  const body = bodyRows
    .map((row) => {
      const cells = splitRow(row);
      return `<tr>${cells.map((cellText) => `<td>${inline(cellText)}</td>`).join("")}</tr>`;
    })
    .join("\n");
  return `<div class="rt-table-wrap"><table class="rt-table">\n<thead>${head}</thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`;
}

/** Split a pipe-table row into trimmed cells, honoring the renderer's `\|` escape. */
function splitRow(row: string): string[] {
  let trimmed = row.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cellText) => cellText.replace(/\\\|/g, "|").trim());
}

// ---------------------------------------------------------------------------
// Inline formatting + escaping
// ---------------------------------------------------------------------------

function inline(text: string): string {
  let html = escapeHtml(text);
  // Inline code first so `**` inside a code span is not treated as bold.
  html = html.replace(/`([^`]+)`/g, (_match, code: string) => `<code class="rt-ic">${code}</code>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Design-system styles (Riptide tokens; self-contained, no remote assets)
// ---------------------------------------------------------------------------

const STYLES = `
:root{
  --rt-ink:#070B11;--rt-deep-ocean:#0B141C;--rt-slate-panel:#121A24;--rt-slate-2:#17212E;
  --rt-slate-line:#1E2A38;--rt-slate-strong:#2A3B4E;--rt-signal-cyan:#22F0E6;--rt-teal:#14B8B6;
  --rt-off-white:#E6EEF2;--rt-fog:#AEBDCB;--rt-fog-dim:#7A8A99;
  --rt-pass:#22C55E;--rt-fail:#EF4444;--rt-warn:#F5B041;--rt-orange:#F97316;
  --rt-font-sans:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
  --rt-font-mono:'IBM Plex Mono',ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace;
}
*{box-sizing:border-box;}
body.rt-bg{margin:0;background:var(--rt-ink);color:var(--rt-fog);font-family:var(--rt-font-sans);
  font-size:15px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.rt-doc{max-width:880px;margin:0 auto;padding:48px 40px 80px;}
header.rt-masthead{margin:0 0 44px;}
.rt-brand{display:flex;align-items:center;gap:10px;margin:0 0 22px;}
.rt-brand .rt-mark{font-size:22px;color:var(--rt-signal-cyan);line-height:1;}
.rt-brand .rt-wordmark{font-family:var(--rt-font-mono);font-weight:600;font-size:15px;letter-spacing:0.32em;
  color:var(--rt-off-white);text-transform:uppercase;}
.rt-brand .rt-brand-kicker{font-family:var(--rt-font-mono);font-size:11px;letter-spacing:0.18em;
  text-transform:uppercase;color:var(--rt-fog-dim);margin-left:auto;}
h1.rt-h1{font-size:38px;line-height:1.08;font-weight:600;color:var(--rt-off-white);letter-spacing:-0.01em;
  margin:0 0 24px;padding-bottom:16px;border-bottom:2px solid var(--rt-teal);}
header.rt-masthead h1.rt-h1{margin-bottom:20px;}
dl.rt-cover-meta{display:flex;flex-wrap:wrap;gap:10px 28px;margin:0 0 18px;}
dl.rt-cover-meta .rt-cover-cell{margin:0;}
dl.rt-cover-meta dt{font-family:var(--rt-font-mono);font-size:10px;letter-spacing:0.14em;text-transform:uppercase;
  color:var(--rt-fog-dim);margin:0 0 3px;}
dl.rt-cover-meta dd{margin:0;font-size:14px;font-weight:600;color:var(--rt-off-white);}
p.rt-cover-boundary{margin:0;font-size:12px;line-height:1.5;color:var(--rt-fog-dim);
  border-left:2px solid var(--rt-slate-strong);padding-left:12px;}
h2.rt-h2{font-size:26px;line-height:1.15;font-weight:600;color:var(--rt-off-white);letter-spacing:-0.01em;
  margin:48px 0 16px;padding-bottom:8px;border-bottom:1px solid var(--rt-slate-line);}
h3.rt-h3{font-size:19px;font-weight:600;color:var(--rt-off-white);margin:28px 0 12px;}
h4.rt-subhead{font-size:16px;font-weight:600;color:var(--rt-fog);margin:20px 0 10px;}
p.rt-body{margin:0 0 14px;}
strong{color:var(--rt-off-white);font-weight:600;}
code.rt-ic{font-family:var(--rt-font-mono);font-size:0.88em;color:var(--rt-signal-cyan);
  background:var(--rt-slate-2);border:1px solid var(--rt-slate-line);border-radius:4px;padding:1px 5px;}
pre.rt-code{font-family:var(--rt-font-mono);font-size:12px;line-height:1.5;color:var(--rt-off-white);
  background:var(--rt-slate-2);border:1px solid var(--rt-slate-line);border-radius:8px;
  padding:14px 16px;overflow-x:auto;margin:0 0 16px;}
pre.rt-code code{font-family:inherit;}
ul.rt-list{margin:0 0 16px;padding-left:22px;}
ul.rt-list li{margin:4px 0;}
li.rt-check{list-style:none;margin-left:-22px;}
li.rt-check .rt-box{color:var(--rt-teal);font-size:1.05em;}
.rt-table-wrap{overflow-x:auto;margin:0 0 18px;}
table.rt-table{border-collapse:collapse;width:100%;font-size:13px;}
table.rt-table th{text-align:left;font-weight:600;color:var(--rt-off-white);background:var(--rt-deep-ocean);
  border:1px solid var(--rt-slate-line);padding:8px 10px;}
table.rt-table td{border:1px solid var(--rt-slate-line);padding:8px 10px;vertical-align:top;
  color:var(--rt-fog);}
table.rt-table tbody tr:nth-child(even){background:rgba(18,26,36,0.5);}
.rt-label{font-family:var(--rt-font-mono);font-size:11px;letter-spacing:0.14em;text-transform:uppercase;
  color:var(--rt-fog-dim);}
figure.rt-heatmap{margin:0 0 22px;padding:18px;background:var(--rt-slate-panel);
  border:1px solid var(--rt-slate-line);border-radius:12px;}
figure.rt-heatmap figcaption{margin-bottom:12px;}
table.rt-hm-grid{border-collapse:separate;border-spacing:4px;width:100%;}
.rt-hm-corner{font-family:var(--rt-font-mono);font-size:11px;color:var(--rt-fog-dim);text-align:left;
  padding:6px 8px;white-space:nowrap;}
.rt-hm-axis{font-family:var(--rt-font-mono);font-size:11px;color:var(--rt-off-white);
  background:var(--rt-slate-2);border-radius:6px;padding:6px 8px;text-align:center;white-space:nowrap;}
.rt-hm-cell{border-radius:6px;padding:8px 6px;text-align:center;min-width:64px;line-height:1.25;}
.rt-hm-cell .rt-hm-rate{display:block;font-weight:600;font-size:13px;}
.rt-hm-cell .rt-hm-n{display:block;font-family:var(--rt-font-mono);font-size:10px;opacity:0.75;}
.rt-hm-n-col{font-family:var(--rt-font-mono);font-size:12px;color:var(--rt-fog);text-align:right;padding:0 10px;}
.rt-hm-b0{background:var(--rt-pass);color:#07140d;}
.rt-hm-b1{background:var(--rt-warn);color:#2a1c05;}
.rt-hm-b2{background:var(--rt-orange);color:#2a1405;}
.rt-hm-b3{background:var(--rt-fail);color:#2a0b0b;}
.rt-hm-empty{background:var(--rt-slate-2);color:var(--rt-fog-dim);}
.rt-hm-legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;}
.rt-hm-key{font-family:var(--rt-font-mono);font-size:10px;padding:3px 8px;border-radius:999px;}
@media print{.rt-doc{max-width:none;padding:0 0 24px;}h2.rt-h2{page-break-after:avoid;}
  figure.rt-heatmap,pre.rt-code,table.rt-table{page-break-inside:avoid;}}
`.trim();

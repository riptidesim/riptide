import type {
  RiskSurfaceAxis,
  RiskSurfaceAxisBound,
  RiskSurfaceCell,
  RiskSurfaceDocument
} from "../campaign/surface.js";

/**
 * Render the cold-readable risk-surface section of the campaign report (R5.1).
 *
 * The output is a markdown block with three parts, each driven only by the
 * already-deterministic {@link RiskSurfaceDocument}: the parameter-sensitivity
 * ranking (T03), a 2D failure-rate heatmap over the two most-sensitive axes
 * (cell = failure rate + shading glyph), and the safe-region summary (T04).
 *
 * ## Determinism (R5.2)
 *
 * The render is byte-deterministic for a fixed surface. It adds no time,
 * randomness, or insertion-order dependence: axis/bin ordering comes from the
 * surface's canonical ordering, the heatmap axes are the surface's own
 * sensitivity ranks (rank 1 → rows, rank 2 → columns), percentages use a fixed
 * one-decimal format, and shading buckets are fixed quartiles of the failure
 * rate. When the surface has more than two axes the heatmap marginalizes the
 * other axes by pooling each (row-bin, column-bin) pair's runs, which is exact
 * because per-cell failed counts are recovered as `round(rate × run_count)`.
 */
export function renderRiskSurfaceNarrative(doc: RiskSurfaceDocument): string {
  const lines: string[] = [];
  lines.push("## Risk Surface", "");
  lines.push(doc.claim_boundary, "");
  renderSensitivity(doc, lines);
  renderHeatmap(doc, lines);
  renderSafeRegion(doc, lines);
  return lines.join("\n");
}

// --- Sensitivity ranking (T03) ---------------------------------------------

function renderSensitivity(doc: RiskSurfaceDocument, lines: string[]): void {
  lines.push("### Parameter sensitivity", "");
  if (doc.sensitivity.ranking.length === 0) {
    lines.push(
      "No parameter varied across this campaign, so no axis sensitivity could be ranked.",
      ""
    );
    return;
  }
  lines.push(`Method: ${doc.sensitivity.method}`, "");
  lines.push(
    "| Rank | Parameter | Failure-rate spread | Min bin | Max bin | Trend | Elasticity / bin step |",
    "|---:|---|---:|---:|---:|---|---:|"
  );
  for (const entry of doc.sensitivity.ranking) {
    lines.push(
      `| ${entry.rank} | ${entry.axis} | ${formatPercent(entry.failure_rate_spread)} | ` +
        `${formatPercent(entry.min_bin_failure_rate)} | ${formatPercent(entry.max_bin_failure_rate)} | ` +
        `${entry.monotonic ?? "—"} | ${entry.elasticity === null ? "—" : formatSignedPercent(entry.elasticity)} |`
    );
  }
  lines.push("");
}

// --- Failure-rate heatmap (T05) --------------------------------------------

const SHADE_LEGEND = "Legend: `░` 0–25%  `▒` 25–50%  `▓` 50–75%  `█` 75–100%  `·` no runs";

function renderHeatmap(doc: RiskSurfaceDocument, lines: string[]): void {
  lines.push("### Failure-rate heatmap", "");

  if (doc.axes.length === 0) {
    const cell = doc.cells[0];
    if (!cell || cell.run_count === 0) {
      lines.push("No runs were placed on the surface, so no heatmap is available.", "");
      return;
    }
    lines.push(
      `Single aggregate cell (no varying parameters): ${shade(cell.invariant_failure_rate)} ` +
        `${formatPercent(cell.invariant_failure_rate)} failure rate over ${cell.run_count} run(s).`,
      ""
    );
    return;
  }

  const ranked = doc.sensitivity.ranking;
  const rowAxis = axisByName(doc, ranked[0]!.axis)!;
  const colAxisName = ranked.length >= 2 ? ranked[1]!.axis : null;
  const colAxis = colAxisName ? axisByName(doc, colAxisName) : null;

  lines.push(SHADE_LEGEND, "");

  if (!colAxis) {
    // 1D surface: one row per bin of the single (most-sensitive) axis.
    lines.push(`Axis: \`${rowAxis.name}\` (most sensitive).`, "");
    lines.push(`| ${rowAxis.name} | Failure rate | Runs |`, "|---|---|---:|");
    for (const bin of rowAxis.bins) {
      const pooled = poolCells(doc.cells, [[rowAxis.name, bin.index]]);
      lines.push(`| ${bin.label} | ${renderShadedRate(pooled)} | ${pooled.runs} |`);
    }
    lines.push("");
    return;
  }

  lines.push(
    `Rows: \`${rowAxis.name}\` (most sensitive, rank 1). ` +
      `Columns: \`${colAxis.name}\` (rank 2).` +
      (doc.axes.length > 2
        ? " Cells pool the remaining axes' runs at each row/column intersection."
        : ""),
    ""
  );

  const header = [`${rowAxis.name} ↓ \\ ${colAxis.name} →`, ...colAxis.bins.map((bin) => bin.label)];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const rowBin of rowAxis.bins) {
    const row = [rowBin.label];
    for (const colBin of colAxis.bins) {
      const pooled = poolCells(doc.cells, [
        [rowAxis.name, rowBin.index],
        [colAxis.name, colBin.index]
      ]);
      row.push(renderShadedRate(pooled));
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
}

interface PooledRate {
  runs: number;
  rate: number | null;
}

/**
 * Pool every cell whose coordinates match all of `constraints` (axis → bin
 * index), summing runs and the recovered failed counts. `rate` is `null` when
 * no runs landed there. Deterministic and exact: failed counts are recovered as
 * `round(rate × run_count)`, and `run_count` is small at campaign budgets.
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

function renderShadedRate(pooled: PooledRate): string {
  if (pooled.rate === null) return "· —";
  return `${shade(pooled.rate)} ${formatPercent(pooled.rate)}`;
}

function shade(rate: number): string {
  if (rate < 0.25) return "░";
  if (rate < 0.5) return "▒";
  if (rate < 0.75) return "▓";
  return "█";
}

// --- Safe region (T04) ------------------------------------------------------

function renderSafeRegion(doc: RiskSurfaceDocument, lines: string[]): void {
  const region = doc.safe_region;
  lines.push(`### Safe region (failure rate ≤ ${formatPercent(region.threshold)})`, "");
  lines.push(region.message, "");
  if (region.status !== "none" && region.bounds.length > 0) {
    lines.push("Recommended bounds within this declared, fixed-seed parameter region:", "");
    for (const bound of region.bounds) {
      lines.push(`- **${bound.axis}:** ${formatBound(bound)}`);
    }
    lines.push("");
  }
  if (region.worst_case_failure_rate !== null) {
    lines.push(
      `Worst-case in-region failure rate: ${formatPercent(region.worst_case_failure_rate)}.`,
      ""
    );
  }
}

function formatBound(bound: RiskSurfaceAxisBound): string {
  if (bound.kind === "discrete") {
    const values = bound.allowed_values ?? [];
    if (values.length === 0) return "no value stays under threshold";
    return `allow ${values.map((value) => `\`${value === null ? "null" : String(value)}\``).join(", ")}`;
  }
  const range = bound.bin_range;
  if (!range) return "no range stays under threshold";
  const lower = range.lower === null ? "(open)" : String(range.lower);
  const upper = range.upper === null ? "(open)" : String(range.upper);
  return `keep within \`[${lower}, ${upper}]\``;
}

// --- Formatting helpers (fixed, deterministic) -----------------------------

function axisByName(doc: RiskSurfaceDocument, name: string): RiskSurfaceAxis | undefined {
  return doc.axes.find((axis) => axis.name === name);
}

/** Fixed one-decimal percentage, e.g. `0.5 → "50.0%"`. Byte-stable. */
function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Signed one-decimal percentage for elasticity, e.g. `0.25 → "+25.0%"`. */
function formatSignedPercent(rate: number): string {
  const sign = rate > 0 ? "+" : rate < 0 ? "−" : "";
  return `${sign}${(Math.abs(rate) * 100).toFixed(1)}%`;
}

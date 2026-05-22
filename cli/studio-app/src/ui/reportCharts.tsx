// Derives chart models from a report's sibling structured JSON and renders
// them with the shared chart primitives. The derivation is intentionally
// defensive: report JSON is untrusted on-disk data, so every field is guarded
// and an unrecognised shape collapses to `null` (no charts, no crash).

import { useMemo } from "react";

import { Donut, HorizontalBars, StackedBars } from "./charts";
import { Kicker } from "./primitives";

const COLOR_PASS = "#22C55E";
const COLOR_FAIL = "#EF4444";
const COLOR_INCONCLUSIVE = "#7A8A99";

interface CampaignChartModel {
  outcomes: { pass: number; fail: number; inconclusive: number } | null;
  families: { labels: string[]; data: Array<{ pass: number; fail: number }> } | null;
  failureTiming: Array<{ label: string; value: number }> | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse a `campaign-summary.v1` JSON blob into chart models. Returns `null`
 * when the blob is not a recognised campaign summary or yields nothing
 * worth charting.
 */
export function deriveCampaignCharts(raw: unknown): CampaignChartModel | null {
  if (!isObject(raw) || raw.schema_version !== "campaign-summary.v1") return null;

  let outcomes: CampaignChartModel["outcomes"] = null;
  if (isObject(raw.totals)) {
    const pass = finiteNumber(raw.totals.passed_runs) ?? 0;
    const fail = finiteNumber(raw.totals.invariant_failed_runs) ?? 0;
    const inconclusive =
      (finiteNumber(raw.totals.setup_errors) ?? 0) + (finiteNumber(raw.totals.skipped_runs) ?? 0);
    if (pass + fail + inconclusive > 0) outcomes = { pass, fail, inconclusive };
  }

  let families: CampaignChartModel["families"] = null;
  if (isObject(raw.scenario_families)) {
    const labels: string[] = [];
    const data: Array<{ pass: number; fail: number }> = [];
    for (const [name, row] of Object.entries(raw.scenario_families)) {
      if (!isObject(row)) continue;
      labels.push(name);
      data.push({
        pass: finiteNumber(row.passed_runs) ?? 0,
        fail: finiteNumber(row.invariant_failed_runs) ?? 0
      });
    }
    if (data.length > 0 && data.some((d) => d.pass + d.fail > 0)) {
      families = { labels, data };
    }
  }

  let failureTiming: CampaignChartModel["failureTiming"] = null;
  if (isObject(raw.first_failure_ticks) && (finiteNumber(raw.first_failure_ticks.count) ?? 0) > 0) {
    const distribution = raw.first_failure_ticks.distribution;
    if (isObject(distribution)) {
      const bars = Object.entries(distribution)
        .map(([label, count]) => ({ label, value: finiteNumber(count) ?? 0 }))
        .filter((bar) => bar.value > 0);
      if (bars.length > 0) failureTiming = bars;
    }
  }

  if (!outcomes && !families && !failureTiming) return null;
  return { outcomes, families, failureTiming };
}

function ChartLegend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div className="rrep__chart-legend">
      {items.map((item) => (
        <span key={item.label}>
          <span className="rrep__chart-dot" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

interface ReportChartsProps {
  /** A report's sibling structured JSON (parsed). Anything unrecognised renders nothing. */
  summary: unknown;
}

/** Visual summary block: charts derived from a report's structured sibling JSON. */
export function ReportCharts({ summary }: ReportChartsProps) {
  const charts = useMemo(() => deriveCampaignCharts(summary), [summary]);
  if (!charts) return null;

  return (
    <div className="rrep__charts">
      <Kicker>VISUAL SUMMARY</Kicker>
      <div className="rrep__charts-grid">
        {charts.outcomes && (
          <div className="rrep__chart">
            <div className="rrep__chart-title">Run outcomes</div>
            <Donut
              pass={charts.outcomes.pass}
              fail={charts.outcomes.fail}
              inconclusive={charts.outcomes.inconclusive}
              legend={
                <ChartLegend
                  items={[
                    { color: COLOR_PASS, label: `pass · ${charts.outcomes.pass}` },
                    { color: COLOR_FAIL, label: `fail · ${charts.outcomes.fail}` },
                    { color: COLOR_INCONCLUSIVE, label: `inconclusive · ${charts.outcomes.inconclusive}` }
                  ]}
                />
              }
            />
          </div>
        )}
        {charts.families && (
          <div className="rrep__chart rrep__chart--wide">
            <div className="rrep__chart-title">Scenario families</div>
            <StackedBars data={charts.families.data} labels={charts.families.labels} />
            <ChartLegend
              items={[
                { color: COLOR_PASS, label: "pass" },
                { color: COLOR_FAIL, label: "fail" }
              ]}
            />
          </div>
        )}
        {charts.failureTiming && (
          <div className="rrep__chart rrep__chart--wide">
            <div className="rrep__chart-title">First failure tick</div>
            <HorizontalBars
              data={charts.failureTiming.map((bar) => ({ ...bar, color: COLOR_FAIL }))}
            />
          </div>
        )}
      </div>
    </div>
  );
}

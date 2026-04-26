import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface DashboardMetricHarness {
  metricMeta: (key: string) => {
    known: boolean;
    label: string;
    unit: string;
    hint: string;
    format: string;
    normalized_key: string;
    aggregate: string;
    basis_points: boolean;
  };
  formatMetricValue: (value: unknown, meta: { format: string }) => string;
  metricSeverity: (key: string, value: unknown, meta: { format: string }) => string;
  fmtValue: (value: unknown) => string;
}

async function loadMetricHarness(): Promise<DashboardMetricHarness> {
  const html = await readFile(path.join("assets", "dashboard.html"), "utf8");
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "dashboard inline script not found");
  const script = match[1]!.replace(/\n\s*boot\(\);\s*$/, "");
  return new Function(
    `${script}; return { metricMeta, formatMetricValue, metricSeverity, fmtValue };`
  )() as DashboardMetricHarness;
}

async function readSummary(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as { summary?: Record<string, unknown> };
  assert.ok(parsed.summary, `${filePath} summary missing`);
  return parsed.summary;
}

test("dashboard metric registry handles stablecoin bps aggregate ratio keys", async () => {
  const harness = await loadMetricHarness();
  const summary = await readSummary(
    path.join(
      "..",
      "fixtures",
      "replays",
      "stablecoin-uxd-style-collateral-cascade",
      "riptide-output",
      "replays",
      "stablecoin-uxd-style-collateral-cascade",
      "simulation-result.json"
    )
  );

  const key = "pool.effective_collateral_ratio_bps_avg";
  const meta = harness.metricMeta(key);
  assert.equal(meta.known, true);
  assert.equal(meta.normalized_key, "effective_collateral_ratio");
  assert.equal(meta.aggregate, "avg");
  assert.equal(meta.basis_points, true);
  assert.equal(meta.format, "bps");
  assert.equal(meta.unit, "%");
  assert.equal(meta.label, "Average effective collateral ratio");
  assert.match(meta.hint, /basis points/i);
  assert.equal(harness.formatMetricValue(summary[key], meta), "92.948571%");
  assert.equal(/929,485/.test(harness.formatMetricValue(summary[key], meta)), false);
  assert.equal(harness.metricSeverity(key, summary[key], meta), "danger");
});

test("dashboard metric registry handles LST exchange-rate bps aggregates", async () => {
  const harness = await loadMetricHarness();
  const summary = await readSummary(
    path.join(
      "..",
      "fixtures",
      "replays",
      "liquid-staking-depeg-redemption-run",
      "riptide-output",
      "replays",
      "liquid-staking-depeg-redemption-run",
      "simulation-result.json"
    )
  );

  const key = "pool.exchange_rate_bps_avg";
  const meta = harness.metricMeta(key);
  assert.equal(meta.known, true);
  assert.equal(meta.normalized_key, "exchange_rate");
  assert.equal(meta.aggregate, "avg");
  assert.equal(meta.basis_points, true);
  assert.equal(meta.format, "bps");
  assert.equal(meta.label, "Average exchange rate");
  assert.equal(harness.formatMetricValue(summary[key], meta), "88.571429%");
  assert.equal(/885,714/.test(harness.formatMetricValue(summary[key], meta)), false);
});

test("dashboard metric registry normalizes qualified component summary keys", async () => {
  const harness = await loadMetricHarness();
  const summary = await readSummary(
    path.join(
      "..",
      "fixtures",
      "replays",
      "lst-lending-contagion-proof",
      "riptide-output",
      "replays",
      "lst-lending-contagion-proof",
      "simulation-result.json"
    )
  );

  const key = "liquid_staking.summary.pool.exchange_rate_bps_avg";
  const meta = harness.metricMeta(key);
  assert.equal(meta.known, true);
  assert.equal(meta.normalized_key, "exchange_rate");
  assert.equal(meta.aggregate, "avg");
  assert.equal(meta.basis_points, true);
  assert.equal(meta.label, "Average exchange rate");
  assert.equal(harness.formatMetricValue(summary[key], meta), "84%");

  const queueMeta = harness.metricMeta("liquid_staking.summary.pool.pending_unstake_count_max");
  assert.equal(queueMeta.known, true);
  assert.equal(queueMeta.normalized_key, "pending_unstake_count");
  assert.equal(queueMeta.aggregate, "max");
  assert.equal(queueMeta.label, "Maximum pending unstakes");
});

test("dashboard metric fallback keeps aggregate suffix readable without object rendering", async () => {
  const harness = await loadMetricHarness();
  const meta = harness.metricMeta("component.summary.custom_observation_avg");
  assert.equal(meta.known, true);
  assert.equal(meta.aggregate, "avg");
  assert.equal(meta.label, "Average custom observation");
  assert.equal(harness.fmtValue({ nested: { value: 1 } }), "{\"nested\":{\"value\":1}}");
});

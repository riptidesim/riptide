import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SimulationResultSchema } from "../src/compiler/schema.js";
import { writeArtifacts } from "../src/report/artifacts.js";
import { renderSummary } from "../src/report/summary.js";
import { renderTimeline } from "../src/report/timeline.js";

async function loadFixture() {
  const raw = await readFile(await resolveFixturePath("simulation-result.sample.json"), "utf8");
  return SimulationResultSchema.parse(JSON.parse(raw));
}

async function resolveFixturePath(name: string): Promise<string> {
  const candidates = [
    fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url))
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return candidates[candidates.length - 1]!;
}

test("summary renders all required sections", async () => {
  const result = await loadFixture();
  const summary = renderSummary(result);
  assert.match(summary, /Scenario:/);
  assert.match(summary, /Final TVL:/);
  assert.match(summary, /Simulation Boundaries:/);
});

test("timeline renders tick-ordered events with persona labels", async () => {
  const result = await loadFixture();
  const timeline = renderTimeline(result);
  assert.match(timeline, /Cautious Yield Farmer/);
  assert.match(timeline, /T0/);
});

test("artifacts are written to disk", async () => {
  const result = await loadFixture();
  const dir = await mkdtemp(path.join(os.tmpdir(), "riptide-report-"));
  const target = await writeArtifacts(result, dir);
  const raw = await readFile(target, "utf8");
  assert.match(raw, /simulation_boundaries/);
});

// `renderSummary` must handle both the historical lending shape and
// the generic/adapter-declared shape without crashing or silently
// dropping keys. These tests drive the renderer directly with synthetic
// `SimulationResult` payloads that mimic both outputs.

function baseResult(summary: Record<string, number | string | boolean | null>) {
  return {
    run_config: {
      agents: 3,
      ticks: 5,
      scenario: "baseline",
      seed: 42,
      personas: ["test-lp"],
      validator_url: "http://localhost:8899",
      output_path: "out"
    },
    seed: 42,
    total_ticks: 5,
    timeseries: [],
    events: [],
    agents: [],
    summary,
    simulation_boundaries: ["unit-test"]
  } as unknown as Parameters<typeof renderSummary>[0];
}

test("renderSummary handles a lending-shaped summary with all historical keys", () => {
  const rendered = renderSummary(
    baseResult({
      final_tvl: 633.0,
      final_utilization: 7.898894154818326,
      total_liquidations: 0,
      total_bad_debt: 0.0,
      agents_active: 5,
      agents_liquidated: 0,
      agents_depleted: 0,
      largest_single_tick_drawdown: 0.00358360567624929
    })
  );
  assert.match(rendered, /Final TVL: /);
  assert.match(rendered, /Final Utilization: /);
  assert.match(rendered, /Liquidations: 0/);
  assert.match(rendered, /Bad Debt: /);
  assert.match(rendered, /Agent Status Counts: /);
  assert.match(rendered, /Largest Drawdown: /);
});

test("renderSummary renders generic/adapter observation aggregates in a fallback metrics table", () => {
  const rendered = renderSummary(
    baseResult({
      agents_active: 6,
      agents_depleted: 0,
      agents_liquidated: 0,
      "player.gold_avg": 0.3846,
      "player.gold_max": 0.6667,
      "player.gold_min": 0.0,
      "player.wood_avg": 2.4487,
      "player.wood_max": 5.1667,
      "player.wood_min": 0.0,
      "marketplace.listings_entry_count_avg": 2.7692,
      "marketplace.listings_entry_count_max": 4.0
    })
  );
  // No lending labels should appear — there are no lending keys.
  assert.doesNotMatch(rendered, /Final TVL:/);
  assert.doesNotMatch(rendered, /Final Utilization:/);
  assert.doesNotMatch(rendered, /Liquidations:/);
  // Lifecycle counters are shown for both paths.
  assert.match(rendered, /Agent Status Counts: /);
  // The fallback metrics table lists each adapter-declared key.
  assert.match(rendered, /Metrics:/);
  assert.match(rendered, /player\.gold_avg:/);
  assert.match(rendered, /player\.gold_max:/);
  assert.match(rendered, /player\.gold_min:/);
  assert.match(rendered, /player\.wood_avg:/);
  assert.match(rendered, /marketplace\.listings_entry_count_avg:/);
  assert.match(rendered, /marketplace\.listings_entry_count_max:/);
});

test("renderSummary does not crash on an empty summary", () => {
  const rendered = renderSummary(baseResult({}));
  assert.match(rendered, /Riptide Simulation Summary/);
  assert.match(rendered, /Simulation Boundaries:/);
});

// Defense-in-depth — even if a malformed summary somehow slips past
// adapter validation, the
// renderer must not forward raw control bytes to the terminal. These
// tests feed synthetic payloads containing ANSI escape sequences and
// assert the rendered output has no ESC / BEL / DEL characters.

function containsControlBytes(rendered: string): boolean {
  for (const ch of rendered) {
    const code = ch.codePointAt(0)!;
    // Allow \n (0x0A) so multi-line output still works; reject every
    // other C0/C1 control and DEL. Colors from chalk come out as ESC
    // sequences too, so strip them first.
    const stripped = ch;
    if (stripped === "\n") continue;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
      return true;
    }
  }
  return false;
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

test("renderSummary sanitizes observation keys carrying ANSI escape sequences", () => {
  const rendered = renderSummary(
    baseResult({
      agents_active: 2,
      agents_depleted: 0,
      agents_liquidated: 0,
      "player.\u001b[31mgold_avg": 1.23
    })
  );
  const clean = stripAnsi(rendered);
  assert.equal(
    containsControlBytes(clean),
    false,
    "renderer must not emit raw ESC/BEL/DEL bytes"
  );
  assert.match(clean, /sanitized/);
});

test("renderSummary sanitizes string metric values carrying bell byte", () => {
  const rendered = renderSummary(
    baseResult({
      agents_active: 2,
      agents_depleted: 0,
      agents_liquidated: 0,
      "custom_label": "oops\u0007bell"
    })
  );
  const clean = stripAnsi(rendered);
  assert.equal(containsControlBytes(clean), false);
  // The `?` replacement for the bell byte should be present.
  assert.match(clean, /oops\?bell/);
});

test("renderSummary sanitizes simulation boundary lines", () => {
  const result = baseResult({
    agents_active: 2,
    agents_depleted: 0,
    agents_liquidated: 0
  });
  (result as { simulation_boundaries: string[] }).simulation_boundaries = [
    "legit boundary",
    "evil\u001b[2J"
  ];
  const rendered = renderSummary(result);
  const clean = stripAnsi(rendered);
  assert.equal(containsControlBytes(clean), false);
});

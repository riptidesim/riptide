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

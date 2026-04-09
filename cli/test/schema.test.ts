import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  PolicySchema,
  RunConfigSchema,
  SimulationResultSchema
} from "../src/compiler/schema.js";

async function readFixture(name: string): Promise<unknown> {
  const fixturePath = path.resolve(process.cwd(), "../fixtures", name);
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw);
}

test("PolicySchema validates the shared policy fixture", async () => {
  const fixture = await readFixture("policy.sample.json");
  const policy = PolicySchema.parse(fixture);

  assert.equal(policy.persona_id, "cautious-yield-farmer");
  assert.equal(policy.triggers.length, 5);
});

test("RunConfigSchema validates the shared run config fixture", async () => {
  const fixture = await readFixture("run-config.sample.json");
  const runConfig = RunConfigSchema.parse(fixture);

  assert.equal(runConfig.agents, 5);
  assert.equal(runConfig.personas.length, 2);
});

test("SimulationResultSchema validates the shared simulation result fixture", async () => {
  const fixture = await readFixture("simulation-result.sample.json");
  const result = SimulationResultSchema.parse(fixture);

  assert.equal(result.total_ticks, 10);
  assert.equal(result.events.length, 2);
});

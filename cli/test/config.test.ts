import test from "node:test";
import assert from "node:assert/strict";

import { buildSimulateOptions } from "../src/config.js";

test("parses defaults and generates a seed", () => {
  const { config, generatedSeed } = buildSimulateOptions({});
  assert.equal(config.agents, 15);
  assert.equal(config.ticks, 50);
  assert.equal(config.scenario, "price-shock");
  assert.equal(config.personas.length, 5);
  assert.equal(generatedSeed, true);
});

test("parses comma-separated personas", () => {
  const { config } = buildSimulateOptions({ personas: "cautious-yield-farmer,panic-whale", seed: 42 });
  assert.deepEqual(config.personas, ["cautious-yield-farmer", "panic-whale"]);
});

test("accepts validator url overrides", () => {
  const { config } = buildSimulateOptions({ seed: 42, validatorUrl: "http://localhost:8899" });
  assert.equal(config.validator_url, "http://localhost:8899");
});

test("rejects invalid values", () => {
  assert.throws(() => buildSimulateOptions({ agents: 0, seed: 42 }));
});

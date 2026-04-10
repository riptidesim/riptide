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

test("rejects persona ids with path traversal", () => {
  assert.throws(
    () => buildSimulateOptions({ seed: 42, personas: "steady-lp,../../../../etc/passwd" }),
    /persona id must be lowercase alphanumerics and dashes/
  );
});

test("rejects persona ids with uppercase, slashes, or spaces", () => {
  assert.throws(() => buildSimulateOptions({ seed: 42, personas: "Steady-LP" }), /persona id/);
  assert.throws(() => buildSimulateOptions({ seed: 42, personas: "steady/lp" }), /persona id/);
  assert.throws(() => buildSimulateOptions({ seed: 42, personas: "steady lp" }), /persona id/);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  scenarioChoicesFor,
  scenarioPathCandidates
} from "../src/init/scenarios-catalog.js";

test("scenario catalog: lending exposes only engine-backed init scenarios", () => {
  const choices = scenarioChoicesFor("lending");
  assert.deepEqual(choices.map((choice) => choice.name), [
    "baseline",
    "oracle-price-shock",
    "bank-run"
  ]);

  const baseline = choices[0]!;
  assert.equal(baseline.scenario, "baseline");
  assert.equal(baseline.required, true);
  assert.equal(baseline.recommended, true);

  const oracleShock = choices[1]!;
  assert.equal(oracleShock.scenario, "price-shock");
  assert.equal(oracleShock.agents, 50);
  assert.equal(oracleShock.ticks, 60);
  assert.deepEqual(oracleShock.defaultPersonas, [
    "steady-lp",
    "panic-whale",
    "degen-borrower"
  ]);

  const bankRun = choices[2]!;
  assert.equal(bankRun.scenario, "bank-run");
  assert.equal(bankRun.recommended, false);
});

test("scenario catalog: protocol baseline dedupes the custom fallback", () => {
  const choices = scenarioChoicesFor("amm");
  assert.deepEqual(choices.map((choice) => choice.name), ["baseline"]);
  assert.equal(choices[0]!.source.includes("/amm/"), true);
});

test("scenario catalog: path candidates search protocol bucket before custom fallback", () => {
  const candidates = scenarioPathCandidates("lending", "baseline");
  const lendingIndex = candidates.findIndex((candidate) =>
    candidate.includes("/init-scenarios/lending/baseline.toml")
  );
  const customIndex = candidates.findIndex((candidate) =>
    candidate.includes("/init-scenarios/custom/baseline.toml")
  );
  assert.notEqual(lendingIndex, -1);
  assert.notEqual(customIndex, -1);
  assert.equal(lendingIndex < customIndex, true);
});

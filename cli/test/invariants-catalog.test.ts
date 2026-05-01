import test from "node:test";
import assert from "node:assert/strict";

import {
  invariantChoicesFor,
  invariantPathCandidates
} from "../src/init/invariants-catalog.js";

test("invariant catalog: lending exposes flat and semantic starter checks in priority order", () => {
  const choices = invariantChoicesFor("lending");
  assert.equal(choices.length, 6);
  assert.deepEqual(new Set(choices.map((choice) => choice.name)), new Set([
    "no_bad_debt",
    "active_agents_survive",
    "utilization_bound",
    "health_factor_positive",
    "debt_below_collateral",
    "debt_below_max_borrow"
  ]));

  assert.deepEqual(choices.slice(0, 2).map((choice) => choice.required), [true, true]);
  assert.equal(choices.slice(2).every((choice) => choice.recommended), true);

  const byName = new Map(choices.map((choice) => [choice.name, choice]));
  assert.equal(byName.get("no_bad_debt")?.form, "flat");
  assert.equal(byName.get("active_agents_survive")?.field, "active_agents");
  assert.equal(byName.get("utilization_bound")?.severity, "warn");
  assert.equal(byName.get("health_factor_positive")?.form, "semantic");
  assert.equal(byName.get("debt_below_collateral")?.form, "semantic");
  assert.equal(byName.get("debt_below_max_borrow")?.form, "semantic");
});

test("invariant catalog: semantic entries require the semantics block", () => {
  const semanticEntries = invariantChoicesFor("lending").filter(
    (choice) => choice.form === "semantic"
  );
  assert.equal(semanticEntries.length, 3);
  assert.equal(semanticEntries.every((choice) => choice.requiresSemantics), true);
});

test("invariant catalog: path candidates search protocol bucket before custom fallback", () => {
  const candidates = invariantPathCandidates("lending", "no-bad-debt");
  const lendingIndex = candidates.findIndex((candidate) =>
    candidate.includes("/init-invariants/lending/no-bad-debt.toml")
  );
  const customIndex = candidates.findIndex((candidate) =>
    candidate.includes("/init-invariants/custom/no-bad-debt.toml")
  );
  assert.notEqual(lendingIndex, -1);
  assert.notEqual(customIndex, -1);
  assert.equal(lendingIndex < customIndex, true);
});

test("invariant catalog: non-lending protocols expose commented templates", () => {
  for (const protocol of ["perpetuals", "amm", "liquid-staking", "stablecoin", "custom"] as const) {
    const choices = invariantChoicesFor(protocol);
    assert.ok(choices.length > 0, `${protocol} should expose at least one invariant template`);
    assert.ok(
      choices.some((choice) => choice.commented),
      `${protocol} should expose commented invariant templates`
    );
  }
});


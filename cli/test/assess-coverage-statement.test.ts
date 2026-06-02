import test from "node:test";
import assert from "node:assert/strict";

import {
  ASSESSMENT_COVERAGE_STATEMENT_SCHEMA,
  buildCoverageStatement,
  serializeAssessment
} from "../src/assess/model.js";
import { canonicalJson, type JsonValue } from "../src/state-pack/json.js";
import {
  buildCleanCorrectnessModel,
  buildCleanModel,
  buildCorrectnessModelWithBlockedCoverage,
  loadFlagshipModel
} from "./assess-fixture.js";

test("assess coverage statement: cartography captures swept axes, hot cells, and no-signal cells", async () => {
  const model = await loadFlagshipModel();
  const block = model.coverage_statement;

  assert.equal(block.schema_version, ASSESSMENT_COVERAGE_STATEMENT_SCHEMA);
  assert.equal(block.shape, "cartography");
  assert.equal(block.probed.kind, "swept-gradient");
  assert.equal(block.probed.completed_runs, 80);
  assert.equal(block.probed.invariant_failed_runs, 33);

  const whaleAxis = block.probed.axes.find((axis) => axis.axis === "whale_share_bps");
  assert.ok(whaleAxis);
  assert.equal(whaleAxis.granularity.method, "fixed-width");
  assert.equal(whaleAxis.granularity.bin_count, 4);
  assert.equal(whaleAxis.range.kind, "interval");
  if (whaleAxis.range.kind === "interval") {
    assert.deepEqual(whaleAxis.range.edges, [500, 1125, 1750, 2375, 3000]);
  }

  assert.equal(block.hot_regions[0]?.kind, "failing_cell");
  assert.equal(block.hot_regions[0]?.invariant_failure_rate, 1);
  assert.ok(block.hot_regions.every((region) => region.kind === "failing_cell"));

  const noSignal = block.flat_no_signal_regions.find(
    (region) =>
      region.kind === "zero_failure_cell" &&
      region.coords?.some((coord) => coord.axis === "shock_profile" && coord.bin_label === "bank-run") &&
      region.coords?.some((coord) => coord.axis === "whale_share_bps" && coord.bin_label === "[2375, 3000]")
  );
  assert.ok(noSignal);
  assert.equal(noSignal.interpretation, "no signal in this campaign");
  assert.equal(noSignal.not_safety_claim, true);
  assert.equal(block.blocked.length, 0);
});

test("assess coverage statement: flat zero cartography is labelled no-signal, not clearance", () => {
  const model = buildCleanModel();
  const block = model.coverage_statement;

  assert.equal(block.shape, "cartography");
  assert.equal(block.hot_regions.length, 0);

  const flatAxis = block.flat_no_signal_regions.find(
    (region) => region.kind === "flat_axis_zero_failure" && region.axis === "whale_share_bps"
  );
  assert.ok(flatAxis);
  assert.equal(flatAxis.interpretation, "no signal in this campaign");
  assert.equal(flatAxis.not_safety_claim, true);
  if (flatAxis.kind === "flat_axis_zero_failure") {
    assert.equal(flatAxis.invariant_failure_rate, 0);
  }
});

test("assess coverage statement: correctness captures guided-sim flow coverage and negative controls", () => {
  const model = buildCleanCorrectnessModel();
  const block = model.coverage_statement;

  assert.equal(block.schema_version, ASSESSMENT_COVERAGE_STATEMENT_SCHEMA);
  assert.equal(block.shape, "correctness");
  assert.equal(block.probed.kind, "guided-sim-flow-coverage");
  assert.equal(block.probed.guided_sim?.flows, 40);
  assert.equal(block.probed.guided_sim?.expected_errors, 16);
  assert.equal(block.probed.negative_controls.length, 1);
  assert.equal(block.probed.negative_controls[0]?.negative_control, true);
  assert.equal(block.probed.negative_controls[0]?.guided_sim_flow, "payout_session_negative_controls");
  assert.equal(block.probed.negative_controls[0]?.dispatched_count, 16);
  assert.equal(block.probed.negative_controls[0]?.expected_rejections, 16);
  assert.equal(block.hot_regions.length, 0);
  assert.ok(
    block.flat_no_signal_regions.some(
      (region) => region.kind === "no_swept_gradient" && region.signal_type === "parameter_gradient"
    )
  );
  assert.ok(
    block.flat_no_signal_regions.some(
      (region) =>
        region.kind === "guided_sim_no_unexpected_result" &&
        region.signal_type === "unexpected_error_or_panic" &&
        region.interpretation === "no signal in this campaign" &&
        region.not_safety_claim === true
    )
  );
});

test("assess coverage statement: correctness blocked/not-assessed rows come from the coverage matrix", () => {
  const model = buildCorrectnessModelWithBlockedCoverage();
  const block = model.coverage_statement;

  assert.equal(block.shape, "correctness");
  assert.equal(block.probed.kind, "guided-sim-flow-coverage");
  const tokenFlow = block.probed.flows.find((row) => row.flow === "Token withdrawal finalization");
  assert.ok(tokenFlow);
  assert.equal(tokenFlow.guided_sim_flow, "withdrawal_finalize_token_happy_path");
  assert.equal(tokenFlow.dispatched_count, 12);
  assert.equal(tokenFlow.expected_rejections, null);

  const payoutNegative = block.probed.flows.find((row) => row.flow === "Payout session negative controls");
  assert.ok(payoutNegative);
  assert.equal(payoutNegative.guided_sim_flow, "payout_session_negative_controls");
  assert.equal(payoutNegative.dispatched_count, 16);
  assert.equal(payoutNegative.expected_rejections, 16);

  assert.deepEqual(
    block.blocked.map((row) => row.status),
    ["blocked", "not assessed"]
  );
  assert.match(block.blocked[0]?.notes ?? "", /signer material/);
  assert.match(block.blocked[1]?.notes ?? "", /prioritized/);
});

test("assess coverage statement: recomputing the block over the same model is byte-identical", async () => {
  for (const model of [await loadFlagshipModel(), buildCleanCorrectnessModel()]) {
    const first = buildCoverageStatement(model);
    const second = buildCoverageStatement(model);
    assert.deepEqual(first, model.coverage_statement);
    assert.deepEqual(second, model.coverage_statement);
    assert.equal(
      canonicalJson(first as unknown as JsonValue),
      canonicalJson(second as unknown as JsonValue)
    );
    assert.equal(serializeAssessment(model), serializeAssessment(model));
  }
});

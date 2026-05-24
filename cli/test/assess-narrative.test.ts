import test from "node:test";
import assert from "node:assert/strict";

import { generateAssessmentNarrative } from "../src/assess/narrative.js";
import type { AssessmentNarrative } from "../src/assess/model.js";
import {
  buildCleanModel,
  buildThresholdNonZeroSafeRegionModel,
  loadFlagshipModel
} from "./assess-fixture.js";

const OVERCLAIM = /guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety/i;

test("assess narrative: flagship model yields a finding, a bounded recommendation, and cites the threshold", async () => {
  const model = await loadFlagshipModel();
  const narrative = generateAssessmentNarrative(model);

  // A declared invariant fired, so there is exactly one finding (not a non-finding).
  assert.equal(narrative.findings.length, 1);
  assert.equal(narrative.non_findings.length, 1);
  assert.match(narrative.main_finding, /Invariant failures/);
  assert.notEqual(narrative.main_finding, "No finding under the declared inputs.");

  // Recommendation is bounded, names the most-sensitive axis, and cites the 5% threshold.
  assert.equal(narrative.recommendation.kind, "bounded");
  assert.equal(narrative.recommendation.primary_axis, "whale_share_bps");
  assert.match(narrative.recommendation.statement, /Keep `whale_share_bps` within \[500, 1750\]/);
  assert.match(narrative.recommendation.statement, /5% threshold/);
  assert.match(narrative.recommendation.statement, /declared, fixed-seed parameter region/);

  // Executive summary carries the failure rate and closes on the claim boundary.
  assert.match(narrative.executive_summary.join("\n"), /41\.25% of completed runs/);
  assert.equal(narrative.executive_summary.at(-1), model.claim_boundary);
});

test("assess narrative: clean model reads as a non-finding, never as proof of safety", () => {
  const model = buildCleanModel();
  const narrative = generateAssessmentNarrative(model);

  assert.equal(narrative.findings.length, 0);
  assert.equal(narrative.main_finding, "No finding under the declared inputs.");
  assert.equal(narrative.non_findings.length, 1);
  assert.match(narrative.non_findings[0]!.statement, /No declared invariant fired under these inputs\./);
  // The bounded non-finding must not drift into safety language.
  assert.doesNotMatch(narrative.non_findings[0]!.statement, /safe|proven|guarantee/i);
});

test("assess narrative: threshold-safe regions with non-zero failures are not non-findings", () => {
  const model = buildThresholdNonZeroSafeRegionModel();
  const narrative = generateAssessmentNarrative(model);

  assert.equal(model.surface.safe_region.status, "entire-region");
  assert.equal(model.surface.safe_region.worst_case_failure_rate, 0.5);
  assert.equal(narrative.findings.length, 1);
  assert.equal(narrative.non_findings.length, 0);
  assert.match(narrative.recommendation.statement, /50% threshold/);
  assert.doesNotMatch(
    JSON.stringify(narrative),
    /No declared invariant fired under the inputs that fell inside the recommended bounds/
  );
});

test("assess narrative: deterministic across two generations of a fixed model", async () => {
  const model = await loadFlagshipModel();
  assert.deepEqual(generateAssessmentNarrative(model), generateAssessmentNarrative(model));
});

test("assess narrative: generated prose is overclaim-grep clean outside the claim boundary", async () => {
  for (const model of [await loadFlagshipModel(), buildCleanModel()]) {
    const narrative = generateAssessmentNarrative(model);
    for (const fragment of generatedProse(narrative, model.claim_boundary)) {
      assert.doesNotMatch(
        fragment,
        OVERCLAIM,
        `overclaim phrase leaked into generated prose: ${JSON.stringify(fragment)}`
      );
    }
  }
});

/** Every generated string except the (negated) claim boundary, which is allowed boundary wording. */
function generatedProse(narrative: AssessmentNarrative, claimBoundary: string): string[] {
  const out: string[] = [
    ...narrative.executive_summary.filter((paragraph) => paragraph !== claimBoundary),
    narrative.headline_claim,
    narrative.main_finding,
    narrative.main_limit,
    narrative.recommendation.statement
  ];
  for (const finding of narrative.findings) {
    out.push(
      finding.title,
      finding.observed,
      finding.why_it_matters,
      finding.recommended,
      ...finding.artifacts,
      ...finding.hashes
    );
  }
  for (const nonFinding of narrative.non_findings) {
    out.push(nonFinding.flow, nonFinding.evidence, nonFinding.statement, nonFinding.limit);
  }
  return out;
}

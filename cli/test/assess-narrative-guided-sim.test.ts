import test from "node:test";
import assert from "node:assert/strict";

import { generateAssessmentNarrative } from "../src/assess/narrative.js";
import { GUIDED_SIM_ADAPTER, type AssessmentNarrative } from "../src/assess/model.js";
import {
  buildSweptStressModel,
  loadFlagshipModel,
  REAL_CAMPAIGN_ADAPTER,
  type SweptStressShape
} from "./assess-fixture.js";

/**
 * Guided-sim narrative reframe: the swept axis on a guided-sim model is an
 * applied exogenous stress (e.g. a collateral price crash), so the narrative
 * must characterize an observed resilience boundary — never advise "keeping"
 * the axis somewhere as if it were a protocol setting. The reframe is gated on
 * the guided-sim adapter; real-campaign models built over identical surfaces
 * must keep their statements byte-for-byte.
 */

// The knob phrasing the guided-sim statements must never contain.
const KNOB = /Keep |keeping parameters|tune the campaign/;

const SHAPES: SweptStressShape[] = ["bounded", "entire-region", "none"];

/** Every human string the narrative emits, except the (negated) claim boundary. */
function generatedProse(narrative: AssessmentNarrative, claimBoundary: string): string[] {
  const out: string[] = [
    ...narrative.executive_summary.filter((paragraph) => paragraph !== claimBoundary),
    narrative.main_finding,
    narrative.recommendation.statement
  ];
  for (const finding of narrative.findings) {
    out.push(finding.title, finding.observed, finding.recommended);
  }
  return out;
}

test("assess narrative (guided-sim): bounded recommendation reads as an observed resilience boundary, not a knob", () => {
  const model = buildSweptStressModel({ shape: "bounded" });
  assert.equal(model.campaign.adapter, GUIDED_SIM_ADAPTER);
  const narrative = generateAssessmentNarrative(model);

  assert.equal(narrative.recommendation.kind, "bounded");
  assert.match(
    narrative.recommendation.statement,
    /`lender_bad_debt` held while `collateral_price_drop_bps` stayed at or below 2000 and began to fire beyond that bound/
  );
  assert.match(narrative.recommendation.statement, /bounds the protocol's observed resilience to `collateral_price_drop_bps`/);
  assert.match(narrative.recommendation.statement, /an observed boundary, not a parameter to set/);
  assert.match(narrative.recommendation.statement, /5% failure-rate threshold/);
  for (const fragment of generatedProse(narrative, model.claim_boundary)) {
    assert.doesNotMatch(fragment, KNOB, `knob phrasing leaked into guided-sim prose: ${JSON.stringify(fragment)}`);
  }
});

test("assess narrative (guided-sim): finding title names the fired invariant, not the axis as actionable", () => {
  const bounded = generateAssessmentNarrative(buildSweptStressModel({ shape: "bounded" }));
  assert.equal(bounded.findings.length, 1);
  assert.equal(bounded.findings[0]!.title, "`lender_bad_debt` fires as `collateral_price_drop_bps` deepens");
  assert.equal(bounded.main_finding, bounded.findings[0]!.title);

  // A flat gradient (every cell fails) still names the invariant, without a trend claim.
  const none = generateAssessmentNarrative(buildSweptStressModel({ shape: "none" }));
  assert.equal(none.findings.length, 1);
  assert.equal(none.findings[0]!.title, "`lender_bad_debt` fires across the swept `collateral_price_drop_bps` range");
});

test("assess narrative (guided-sim): entire-region and none branches carry boundary phrasing, no knob advice", () => {
  const entire = generateAssessmentNarrative(buildSweptStressModel({ shape: "entire-region" }));
  assert.equal(entire.recommendation.kind, "entire-region");
  assert.match(entire.recommendation.statement, /stayed within the protocol's observed resilience/);
  assert.match(entire.recommendation.statement, /Stresses beyond the swept region were not tested\./);
  assert.doesNotMatch(entire.recommendation.statement, KNOB);

  const none = generateAssessmentNarrative(buildSweptStressModel({ shape: "none" }));
  assert.equal(none.recommendation.kind, "none");
  assert.match(none.recommendation.statement, /`lender_bad_debt` fired beyond the threshold/);
  assert.match(none.recommendation.statement, /no observed safe region bounds the protocol's resilience to `collateral_price_drop_bps`/);
  assert.doesNotMatch(none.recommendation.statement, KNOB);
});

test("assess narrative (guided-sim): authored failure-mode prose still yields the invariant; ambiguity falls back to the generic title", () => {
  // The skill-authored convention leads with the invariant name before a colon.
  const authored = generateAssessmentNarrative(
    buildSweptStressModel({
      shape: "bounded",
      inputs: {
        riskPlan: {
          expected_failure_modes: [
            "lender_bad_debt: a collateral crash outruns the lender-only liquidation and the lender absorbs the shortfall"
          ]
        }
      }
    })
  );
  assert.match(authored.findings[0]!.title, /^`lender_bad_debt` fires /);
  assert.match(authored.recommendation.statement, /`lender_bad_debt` held while/);

  // Two distinct names are not attributable to one invariant: keep the generic
  // title and the invariant-free boundary phrasing rather than guessing.
  const ambiguous = generateAssessmentNarrative(
    buildSweptStressModel({
      shape: "bounded",
      inputs: {
        riskPlan: {
          expected_failure_modes: ["invariant `lender_bad_debt` firing", "invariant `oracle_drift` firing"]
        }
      }
    })
  );
  assert.equal(ambiguous.findings[0]!.title, "Invariant failures rise with `collateral_price_drop_bps`");
  assert.match(ambiguous.recommendation.statement, /The declared invariant held while/);
  assert.doesNotMatch(ambiguous.recommendation.statement, KNOB);
});

test("assess narrative (guided-sim): only the human statement changes — recommendation data fields match the real-campaign twin", () => {
  for (const shape of SHAPES) {
    const guided = generateAssessmentNarrative(buildSweptStressModel({ shape }));
    const real = generateAssessmentNarrative(buildSweptStressModel({ shape, adapter: REAL_CAMPAIGN_ADAPTER }));
    const fields = ({ kind, primary_axis, threshold, bounds }: typeof guided.recommendation) => ({
      kind,
      primary_axis,
      threshold,
      bounds
    });
    assert.deepEqual(fields(guided.recommendation), fields(real.recommendation), `data fields drifted (${shape})`);
    assert.notEqual(guided.recommendation.statement, real.recommendation.statement);
  }
});

test("assess narrative (real campaign): statements and titles keep the existing strings verbatim", async () => {
  const bounded = generateAssessmentNarrative(
    buildSweptStressModel({ shape: "bounded", adapter: REAL_CAMPAIGN_ADAPTER })
  );
  assert.equal(
    bounded.recommendation.statement,
    "Keep `collateral_price_drop_bps` in {0, 1000, 2000} to hold the invariant-failure rate at or under the 5% " +
      "threshold across the declared, fixed-seed parameter region."
  );
  assert.equal(bounded.findings[0]!.title, "Invariant failures rise with `collateral_price_drop_bps`");

  const entire = generateAssessmentNarrative(
    buildSweptStressModel({ shape: "entire-region", adapter: REAL_CAMPAIGN_ADAPTER })
  );
  assert.equal(
    entire.recommendation.statement,
    "Every populated cell held the invariant-failure rate at or under the 5% threshold; keeping parameters within " +
      "the declared, fixed-seed region stayed at or under it."
  );

  const none = generateAssessmentNarrative(
    buildSweptStressModel({ shape: "none", adapter: REAL_CAMPAIGN_ADAPTER })
  );
  assert.equal(
    none.recommendation.statement,
    "No parameter sub-region held the invariant-failure rate at or under the 5% threshold within the declared, " +
      "fixed-seed parameter region; tune the campaign toward a safer region before relying on these inputs."
  );

  // The flagship lending model (real campaign) keeps its exact recommendation.
  const flagship = generateAssessmentNarrative(await loadFlagshipModel());
  assert.match(flagship.recommendation.statement, /^Keep `whale_share_bps` within \[500, 1750\]/);
  assert.equal(flagship.findings[0]!.title, "Invariant failures rise with `whale_share_bps`");
});

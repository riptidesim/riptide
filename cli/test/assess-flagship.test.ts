import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalJson, sha256Hex, type JsonValue } from "../src/state-pack/json.js";
import {
  ASSESSMENT_HASH_PREFIX,
  assessmentShape,
  serializeAssessment,
  type AssessmentModel,
  type CartographyAssessmentModel
} from "../src/assess/model.js";
import { generateAssessmentNarrative } from "../src/assess/narrative.js";
import { renderAssessmentMarkdown } from "../src/assess/render-markdown.js";
import {
  buildCleanCorrectnessModel,
  buildFindingCorrectnessModel,
  loadFlagshipModel
} from "./assess-fixture.js";

/**
 * Flagship lending-cartography assessment gate (Sprint 40 T06 / R6).
 *
 * The load-bearing R6.4 determinism gate is run by hand against the real engine,
 * mirroring the surface gate in `campaign-cartography-flagship.test.ts`:
 *
 *   riptide campaign run \
 *     fixtures/campaigns/lending/whale-shock-cartography/campaign.toml --out <a>
 *   riptide assess <a>/campaign_40a5f239691a --out <g1>   # twice, to <g1>/<g2>
 *   sha256sum <g1>/assessment.json <g2>/assessment.json   # must match
 *   sha256sum <g1>/assessment.md   <g2>/assessment.md     # must match
 *
 * Both runs produced byte-identical artifacts; the recorded hand-run hashes are
 * captured in the Sprint 40 close note. That path runs 80 real simulations and
 * is too slow for the unit suite, so this test instead locks the assessment the
 * generator derives from the checked-in flagship surface (`loadFlagshipModel`,
 * the same real Sprint 39 surface the T02/T03 suites consume) and asserts the
 * T06 cold-read acceptance criteria so a generator change that flattens the
 * heatmap, drops the whale-share ranking, or loosens the claim boundary fails
 * CI. The synthetic campaign-summary keeps the model path-clean, so its bytes
 * regenerate identically anywhere; the hashes below are that regenerable pin.
 */

// Recorded by re-rendering the flagship model. Path-independent (the synthetic
// summary carries no retained-case absolute paths), so these regenerate
// byte-identically in CI. A producer change that moves them must be intentional.
// Sprint 42 format retune (presentation-only): the executive-summary identity
// lines are now omitted when null instead of printed as "not specified" (T02),
// and the assessment date is populated deterministically from the declared
// fixed seed policy when no explicit input date is present. Superseded pins:
//   Sprint 40 MD   3af5ef586ca27329705d7a32d9016e0e224c115e302c437e5ae9a34f371e95de
//   Sprint 40 JSON 69744b3ee695ea18feee7d9c00971ff5d3dbf0737e2bd75a2b30824f5983252c
//   Sprint 42 Phase-1 placeholder-cleanup MD
//                  091b44c2e67d401ecc3baade760921814b10e32b02939dbc1cf97ecd60d08632
const FLAGSHIP_MD_SHA256 =
  "d751233ac22161399a85d9e6f4477b9f1fe8057140a6438f4569a0e985487114";
const FLAGSHIP_JSON_SHA256 =
  "c3fd34d486a282b27c32bf8723c4095f62bfdf5669d70fa6b0f5dedc24a95ec9";

const OVERCLAIM =
  /guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety/i;
// The close-gate (R9.4) allows these terms only as boundary/scope wording. Every
// line the overclaim grep matches in the flagship report must be one of these
// known boundary declarations (report header, claim boundary, out-of-scope
// listing, reviewer checklist). A new positive overclaim line is not in the set
// and fails the test.
const BOUNDARY_LINES = new Set<string>([
  "This report records simulation evidence. It is not audit signoff, complete protocol safety, formal verification, mainnet monitoring, or certification.",
  "This assessment records simulation evidence observed within the campaign's declared, fixed-seed parameter region and run budget. It is evidence over that region only — not audit signoff, formal verification, complete protocol safety, or a prediction of mainnet behavior.",
  "- Audit signoff, formal verification, and complete protocol safety.",
  "- [ ] The report says this is simulation evidence, not audit signoff or complete protocol safety."
]);

async function renderFlagship(): Promise<{ model: CartographyAssessmentModel; markdown: string; json: string }> {
  const model = await loadFlagshipModel();
  const narrative = generateAssessmentNarrative(model);
  const markdown = renderAssessmentMarkdown(model, narrative);
  const json = serializeAssessment(model);
  return { model, markdown, json };
}

test("flagship assessment: assessment.md + assessment.json bytes match the recorded gate hashes", async () => {
  const { markdown, json } = await renderFlagship();
  assert.equal(
    createHash("sha256").update(markdown, "utf8").digest("hex"),
    FLAGSHIP_MD_SHA256,
    "flagship assessment.md bytes drifted from the recorded gate hash"
  );
  assert.equal(
    createHash("sha256").update(json, "utf8").digest("hex"),
    FLAGSHIP_JSON_SHA256,
    "flagship assessment.json bytes drifted from the recorded gate hash"
  );
});

test("flagship assessment: re-rendering is byte-identical (the R6.4 determinism property)", async () => {
  const first = await renderFlagship();
  const second = await renderFlagship();
  assert.equal(first.markdown, second.markdown, "assessment.md is not byte-deterministic");
  assert.equal(first.json, second.json, "assessment.json is not byte-deterministic");
});

test("flagship assessment: assessment.json is canonical with a verifiable self-digest", async () => {
  const { model, json } = await renderFlagship();

  // Re-canonicalizing the serialized model reproduces the on-disk bytes — the
  // property that makes `sha256sum assessment.json` a stable determinism hash.
  assert.equal(canonicalJson(model as unknown as JsonValue), json, "assessment.json is not in canonical-JSON form");

  // The embedded assessment_digest is the domain-prefixed self-hash over the
  // model minus that field; recompute and verify it.
  const { assessment_digest, ...rest } = model as CartographyAssessmentModel & Record<string, unknown>;
  const expected = sha256Hex(`${ASSESSMENT_HASH_PREFIX}\n${canonicalJson(rest as unknown as JsonValue)}`);
  assert.equal(assessment_digest, expected, "embedded assessment_digest does not verify");
});

test("flagship assessment: ranks whale_share_bps #1 and reads the bounded safe-region recommendation", async () => {
  const { model, markdown } = await renderFlagship();

  // The headline sensitivity finding: whale concentration moves the failure
  // rate most across the swept region.
  assert.equal(model.surface_highlights.most_sensitive_axis, "whale_share_bps");
  assert.match(
    markdown,
    /\|\s*1\s*\|\s*whale_share_bps\s*\|.*\bincreasing\b/,
    "sensitivity table must rank whale_share_bps #1 with an increasing trend"
  );

  // The Gauntlet-tier payoff: a bounded parameter range, not a checkmark.
  assert.match(
    markdown,
    /\*\*whale_share_bps:\*\* keep within `\[500, 1750\]`/,
    "safe region must recommend a bounded whale_share_bps range"
  );
  assert.match(
    markdown,
    /Keep `whale_share_bps` within \[500, 1750\] to hold the invariant-failure rate at or under the 5% threshold/,
    "the recommendation must cite the failure-rate threshold and the bounded region"
  );
});

test("flagship assessment: renders the failure-rate heatmap with the recorded whale × shock gradient", async () => {
  const { markdown } = await renderFlagship();

  // The heatmap legend + glyph grid must be present (R6.2).
  assert.match(markdown, /### Failure-rate heatmap/);
  assert.match(markdown, /Legend: `░` 0–25%/);

  // Cold-read the gradient under the biting price-shock column: low whale share
  // stays at 0%, high whale share saturates at 100% — the "higher whale
  // concentration → higher failure rate" finding rendered visually.
  assert.match(markdown, /\| \[500, 1125\) \| ░ 0\.0% \| ░ 0\.0% \|/);
  assert.match(markdown, /\| \[1750, 2375\) \| █ 100\.0% \| ░ 0\.0% \|/);
  assert.match(markdown, /\| \[2375, 3000\] \| █ 100\.0% \| ░ 0\.0% \|/);
});

test("flagship assessment: separates findings from non-findings with bounded claim language", async () => {
  const { markdown } = await renderFlagship();

  // Both sections present and distinct (R3.2): the populated failure region is a
  // finding; the recommended bounded region reads as a non-finding, never
  // "proven safe".
  assert.match(markdown, /## Findings\n/);
  assert.match(markdown, /## Non-Findings\n/);
  assert.match(markdown, /Finding 1: Invariant failures rise with `whale_share_bps`/);
  assert.match(
    markdown,
    /No declared invariant fired under the inputs that fell inside the recommended bounds\./,
    "non-finding must use bounded, simulation-evidence language"
  );
  assert.match(markdown, /A non-finding is not proof that the protocol is safe\./);
});

test("flagship assessment: overclaim grep is clean (boundary/negation wording only)", async () => {
  const { markdown } = await renderFlagship();
  for (const line of markdown.split("\n")) {
    if (!OVERCLAIM.test(line)) continue;
    assert.ok(
      BOUNDARY_LINES.has(line),
      `overclaim term used outside a known boundary declaration: ${JSON.stringify(line)}`
    );
  }
});

/**
 * Correctness-shape (surface-less) assessment golden (Sprint 41 T06 / R6.3).
 *
 * The dual of the cartography golden above: it locks the assessment the
 * generator derives from a Defunds-shaped, surface-less guided-sim evidence set
 * (`buildCleanCorrectnessModel` / `buildFindingCorrectnessModel`, the same
 * fixtures the T02/T03 correctness suites consume). The real Defunds document is
 * regenerated by hand against the workspace and its determinism hash recorded in
 * the close note (path-dependent on the assessed root); these fixtures carry no
 * absolute paths, so their bytes regenerate identically anywhere — the
 * regenerable correctness pin that fails CI if a generator change drops the
 * honest no-heatmap note, the coverage-by-guided-sim rows, the bounded
 * non-finding, or the finding→blocked verdict mapping.
 *
 * Recorded by re-rendering the fixtures; path-independent. A producer change
 * that moves them must be intentional.
 */
// Sprint 42 format retune (presentation-only): the derived guided-sim command no
// longer embeds the evidence path (it lives in the Artifacts / Retained-evidence
// column instead, T03), and null identity lines are omitted (T02). Both move the
// correctness markdown + JSON bytes. Superseded pins —
//   clean MD   f43b61f863ba0fc83713101cf1dc020fa34669c9a71c2d0b55383161c54c484e
//   clean JSON 132b087e12984a6899a12ca57a3e42ad432052b8b729d4b23e9fd38501b97c22
//   finding MD e9fb58bf6b6e3ebd1d38a16cd7dde018719273301f514b329900668f8cb12e3d
//   find. JSON a4ba3048d822119e77a2ef8c1ff029d61c85ec1ae1d799fd9d1e4e3b2598e4d6
const CLEAN_CORRECTNESS_MD_SHA256 =
  "7c539515ac23542c4e7c25bc852bbbe12606b106ea865112a3e62eb45650e989";
const CLEAN_CORRECTNESS_JSON_SHA256 =
  "49efbef13d86aba22e1da8b05d43d480d09b99577095b7ab0463a00bc4f9887b";
const FINDING_CORRECTNESS_MD_SHA256 =
  "ea88b5d7344a8d713f8b99c38d2493ad976ff185108ecfc9b6e17949e7eb9ba1";
const FINDING_CORRECTNESS_JSON_SHA256 =
  "700759d106b61fa9648abafc6710abed16ea981c977589c7ef9f8742b44a9212";

function renderCorrectness(model: AssessmentModel): { markdown: string; json: string } {
  const narrative = generateAssessmentNarrative(model);
  const markdown = renderAssessmentMarkdown(model, narrative);
  const json = serializeAssessment(model);
  return { markdown, json };
}

test("correctness assessment: clean model bytes match the recorded gate hashes", () => {
  const model = buildCleanCorrectnessModel();
  const { markdown, json } = renderCorrectness(model);
  assert.equal(
    createHash("sha256").update(markdown, "utf8").digest("hex"),
    CLEAN_CORRECTNESS_MD_SHA256,
    "clean correctness assessment.md bytes drifted from the recorded gate hash"
  );
  assert.equal(
    createHash("sha256").update(json, "utf8").digest("hex"),
    CLEAN_CORRECTNESS_JSON_SHA256,
    "clean correctness assessment.json bytes drifted from the recorded gate hash"
  );
});

test("correctness assessment: finding model bytes match the recorded gate hashes", () => {
  const model = buildFindingCorrectnessModel();
  const { markdown, json } = renderCorrectness(model);
  assert.equal(
    createHash("sha256").update(markdown, "utf8").digest("hex"),
    FINDING_CORRECTNESS_MD_SHA256,
    "finding correctness assessment.md bytes drifted from the recorded gate hash"
  );
  assert.equal(
    createHash("sha256").update(json, "utf8").digest("hex"),
    FINDING_CORRECTNESS_JSON_SHA256,
    "finding correctness assessment.json bytes drifted from the recorded gate hash"
  );
});

test("correctness assessment: re-rendering is byte-identical (the determinism property)", () => {
  const first = renderCorrectness(buildCleanCorrectnessModel());
  const second = renderCorrectness(buildCleanCorrectnessModel());
  assert.equal(first.markdown, second.markdown, "correctness assessment.md is not byte-deterministic");
  assert.equal(first.json, second.json, "correctness assessment.json is not byte-deterministic");
});

test("correctness assessment: json is canonical with a verifiable self-digest", () => {
  const model = buildCleanCorrectnessModel();
  const { json } = renderCorrectness(model);

  assert.equal(
    canonicalJson(model as unknown as JsonValue),
    json,
    "correctness assessment.json is not in canonical-JSON form"
  );

  const { assessment_digest, ...rest } = model as AssessmentModel & Record<string, unknown>;
  const expected = sha256Hex(`${ASSESSMENT_HASH_PREFIX}\n${canonicalJson(rest as unknown as JsonValue)}`);
  assert.equal(assessment_digest, expected, "embedded assessment_digest does not verify");
});

test("correctness assessment: clean model is the surface-less correctness shape with a bounded verdict", () => {
  const model = buildCleanCorrectnessModel();
  assert.equal(assessmentShape(model), "correctness");
  assert.equal(model.shape, "correctness");
  assert.equal(model.surface, null);
  assert.equal(model.verdict.value, "ready_to_send");
});

test("correctness assessment: degrades the risk-surface section to the honest no-heatmap note", () => {
  const { markdown } = renderCorrectness(buildCleanCorrectnessModel());

  // The Risk Surface heading is still present, but it carries the bounded
  // correctness note instead of a heatmap (R3.1).
  assert.match(markdown, /## Risk Surface\n/);
  assert.match(
    markdown,
    /This is a correctness-dominated assessment, so there is no risk-surface heatmap\./
  );
  assert.match(
    markdown,
    /binary accounting and authority properties — accounting drift, double-payment, wrong-recipient settlement, and unauthorized control — not a parameter-failure gradient/
  );
  // No cartography artifacts leak into the correctness report.
  assert.doesNotMatch(markdown, /### Failure-rate heatmap/);
  assert.doesNotMatch(markdown, /Legend: `░` 0–25%/);
});

test("correctness assessment: coverage matrix carries the report via guided-sim rows", () => {
  const { markdown } = renderCorrectness(buildCleanCorrectnessModel());

  assert.match(markdown, /## Coverage Matrix\n/);
  // Happy-path family → covered by guided sim; negative-control family → rejection evidence (R4.1).
  assert.match(
    markdown,
    /\| P0 \| guided-sim flow `payout_session_happy_path` \| covered by guided sim \| guided sim \|/
  );
  assert.match(
    markdown,
    /\| P0 \| guided-sim flow `payout_session_negative_controls` \| covered by guided sim \| guided sim \(negative control\) \|.*rejected as expected/
  );
});

test("correctness assessment: clean model reads as a bounded non-finding, never proven safe", () => {
  const { markdown } = renderCorrectness(buildCleanCorrectnessModel());

  assert.match(markdown, /## Findings\n/);
  assert.match(markdown, /## Non-Findings\n/);
  assert.match(markdown, /No finding under the declared inputs\./);
  assert.match(
    markdown,
    /No accounting drift, double-payment, wrong-recipient settlement, or unauthorized-control success was observed under the declared inputs; all negative-control actions were rejected as expected\./
  );
  assert.match(markdown, /A non-finding is not proof that the protocol is safe\./);
});

test("correctness assessment: an unexpected error or panic flips to a finding and a blocked verdict", () => {
  const model = buildFindingCorrectnessModel();
  assert.equal(model.verdict.value, "blocked");
  const { markdown } = renderCorrectness(model);
  // The dirty case must read as a finding, not "No finding under the declared inputs."
  assert.doesNotMatch(markdown, /No finding under the declared inputs\./);
});

test("correctness assessment: overclaim grep is clean (boundary/negation wording only)", () => {
  const { markdown } = renderCorrectness(buildCleanCorrectnessModel());
  for (const line of markdown.split("\n")) {
    if (!OVERCLAIM.test(line)) continue;
    const allowed = /\bnot\b/i.test(line) || line.startsWith("- Audit signoff,");
    assert.ok(allowed, `overclaim phrase outside boundary wording: ${JSON.stringify(line)}`);
  }
});

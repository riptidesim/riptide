import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalJson, sha256Hex, type JsonValue } from "../src/state-pack/json.js";
import {
  ASSESSMENT_HASH_PREFIX,
  serializeAssessment,
  type AssessmentModel
} from "../src/assess/model.js";
import { generateAssessmentNarrative } from "../src/assess/narrative.js";
import { renderAssessmentMarkdown } from "../src/assess/render-markdown.js";
import { loadFlagshipModel } from "./assess-fixture.js";

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
const FLAGSHIP_MD_SHA256 =
  "aeffc8a27e34b897a074b01b69617c51a2a3b6d18025551ddb0bb5d006073ac0";
const FLAGSHIP_JSON_SHA256 =
  "25a6e74abbc6a7be48af9598062a3ed38a183516feefa8ce39785e297cb78660";

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

async function renderFlagship(): Promise<{ model: AssessmentModel; markdown: string; json: string }> {
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
  const { assessment_digest, ...rest } = model as AssessmentModel & Record<string, unknown>;
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

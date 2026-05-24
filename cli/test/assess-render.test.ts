import test from "node:test";
import assert from "node:assert/strict";

import { renderAssessmentMarkdown } from "../src/assess/render-markdown.js";
import { generateAssessmentNarrative } from "../src/assess/narrative.js";
import {
  buildCleanModel,
  buildThresholdNonZeroSafeRegionModel,
  loadFlagshipModel
} from "./assess-fixture.js";

const OVERCLAIM = /guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety/i;

test("assess render: flagship renders every template section in order", async () => {
  const model = await loadFlagshipModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));

  const sections = [
    "# Protocol assessment — ",
    "## Executive summary",
    "## Scope",
    "### In scope",
    "### Out of scope",
    "### Claim boundary",
    "## Risk Plan",
    "## Coverage Matrix",
    "## Risk Surface",
    "## Simulations run",
    "## Findings",
    "## Non-Findings",
    "## Blocked and out-of-scope surfaces",
    "## Reproduction Commands",
    "## Recommended next work",
    "## Toolchain",
    "## Reviewer checklist"
  ];
  let cursor = 0;
  for (const heading of sections) {
    const at = md.indexOf(heading, cursor);
    assert.ok(at >= 0, `missing or out-of-order section: ${heading}`);
    cursor = at + heading.length;
  }

  // Executive-summary header fields and the rendered verdict are present.
  assert.match(md, /- \*\*Verdict:\*\* needs_campaign_tuning/);
  assert.match(md, /- \*\*Protocol:\*\* whale-shock-cartography/);
});

test("assess render: embeds the risk-surface heatmap, sensitivity ranking, and bounded safe region", async () => {
  const model = await loadFlagshipModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));

  assert.match(md, /### Parameter sensitivity/);
  assert.match(md, /### Failure-rate heatmap/);
  // whale_share_bps is rank 1 -> rows; shock_profile rank 2 -> columns.
  assert.match(md, /whale_share_bps ↓ \\ shock_profile →/);
  assert.match(md, /### Safe region \(failure rate ≤ 5\.0%\)/);
  // Heatmap shading legend rides along from surface-narrative.
  assert.match(md, /`░` 0–25%/);

  // The narrative's bounded recommendation surfaces in the report body.
  assert.match(md, /Keep `whale_share_bps` within \[500, 1750\]/);
});

test("assess render: a finding is rendered and kept separate from non-findings", async () => {
  const model = await loadFlagshipModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));

  assert.match(md, /### Finding 1: Invariant failures/);
  assert.match(md, /- \*\*Severity or priority:\*\* P0/);
  assert.match(md, /41\.25%/);
  // Non-findings section exists and uses bounded language.
  assert.match(md, /No declared invariant fired/);
});

test("assess render: clean model renders 'No finding under the declared inputs'", () => {
  const model = buildCleanModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));

  assert.match(md, /## Findings\n\n[^#]*No finding under the declared inputs\./);
  assert.match(md, /No declared invariant fired under these inputs\./);
  assert.doesNotMatch(md, /### Finding 1:/);
});

test("assess render: threshold-safe regions with failures do not render a false non-finding", () => {
  const model = buildThresholdNonZeroSafeRegionModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));

  assert.match(md, /### Finding 1: Invariant failures/);
  assert.match(md, /No non-findings were recorded for this assessment\./);
  assert.match(md, /50% threshold/);
  assert.doesNotMatch(
    md,
    /No declared invariant fired under the inputs that fell inside the recommended bounds/
  );
});

test("assess render: reproduction block carries commands, artifact paths, and canonical hashes", async () => {
  const model = await loadFlagshipModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));

  assert.match(md, /riptide assess tmp\/flagship-run\/campaign_40a5f239691a/);
  assert.match(md, /tmp\/flagship-run\/campaign_40a5f239691a\/risk-surface\.json/);
  assert.doesNotMatch(md, /<campaign\.toml>|<dir>/);
  assert.match(md, new RegExp(`\\*\\*Campaign digest:\\*\\* \`${model.reproduction.hashes.campaign_digest}\``));
  assert.match(md, new RegExp(`risk-surface\\.json\` sha256:\\*\\* \`${model.reproduction.hashes.surface_sha256}\``));
});

test("assess render: byte-deterministic across two renders and two builds of the flagship", async () => {
  const modelA = await loadFlagshipModel();
  const modelB = await loadFlagshipModel();
  const first = renderAssessmentMarkdown(modelA, generateAssessmentNarrative(modelA));
  const second = renderAssessmentMarkdown(modelB, generateAssessmentNarrative(modelB));
  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
});

test("assess render: rendered markdown is overclaim-grep clean outside the claim boundary", async () => {
  const model = await loadFlagshipModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));
  // Overclaim phrases may appear only as a negation ("not audit signoff …") or as
  // the explicit out-of-scope exclusion bullet — never as a positive claim.
  for (const line of md.split("\n")) {
    if (!OVERCLAIM.test(line)) continue;
    const allowed = /\bnot\b/i.test(line) || line.startsWith("- Audit signoff,");
    assert.ok(allowed, `overclaim phrase outside boundary wording: ${JSON.stringify(line)}`);
  }
});

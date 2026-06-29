import test from "node:test";
import assert from "node:assert/strict";

import { renderAssessmentMarkdown } from "../src/assess/render-markdown.js";
import { generateAssessmentNarrative } from "../src/assess/narrative.js";
import { renderAssessmentHtml } from "../src/assess/render-html.js";
import {
  buildCorrectnessModelWithBlockedCoverage,
  buildCleanCorrectnessModel,
  buildCleanModel,
  buildFindingCorrectnessModel,
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
    "## Coverage & Limits",
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
  assert.match(md, /- \*\*Main limit:\*\* Flows, parameters, and seeds outside this campaign's declared region are not assessed\./);
});

test("assess render: Coverage & Limits consolidates probed, hot, no-signal, and blocked facts", async () => {
  const model = await loadFlagshipModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));
  const section = extractSection(md, "## Coverage & Limits", "## Coverage Matrix");

  assert.match(section, /### Probed surface/);
  assert.match(section, /Riptide probed the `liquidation-safety` surface with 80 completed run\(s\)/);
  assert.match(section, /\| whale_share_bps \| \[500, 3000\]; edges 500, 1125, 1750, 2375, 3000 bps/);
  assert.match(section, /### Hot regions/);
  assert.match(section, /shock_profile=price-shock, whale_share_bps=\[2375, 3000\].*100\.0% failure rate/);
  assert.match(section, /### Flat and no-signal regions/);
  assert.match(section, /no signal in this campaign, not safety/);
  assert.match(section, /zero-failure cell shock_profile=bank-run, whale_share_bps=\[2375, 3000\]/);
  assert.match(section, /### Blocked or out of scope/);
  assert.match(section, /Primary limit: Flows, parameters, and seeds outside this campaign's declared region are not assessed\./);
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

test("assess render: correctness shape degrades to a bounded note, not a heatmap (R3.1/R3.2)", () => {
  const model = buildCleanCorrectnessModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));

  // The Risk Surface section is present but renders the honest no-heatmap note.
  assert.match(md, /## Risk Surface/);
  assert.match(md, /correctness-dominated assessment, so there is no risk-surface heatmap/);
  // No heatmap glyph table / sensitivity / safe-region machinery.
  assert.doesNotMatch(md, /### Failure-rate heatmap/);
  assert.doesNotMatch(md, /### Parameter sensitivity/);
  // Coverage + a bounded non-finding carry the report.
  assert.match(md, /covered by guided sim/);
  assert.match(md, /No accounting drift, double-payment/);
  // Reproduction anchors on the guided-sim hash, not surface/campaign digests.
  assert.match(md, /\*\*`guided-sim-run\.json` sha256:\*\* `a{64}`/);
  assert.doesNotMatch(md, /Surface digest:|Campaign digest:/);
});

test("assess render: correctness shape preserves blocked and not-assessed coverage rows", () => {
  const model = buildCorrectnessModelWithBlockedCoverage();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));

  assert.match(
    md,
    /\| P0 \| Positive NAV, whitelist-admin, and fee-authority flows \| blocked \| blocked \|/
  );
  assert.match(md, /\| P1 \| Legacy pay_fund_investors path \| not assessed \| none \|/);
  assert.match(md, /## Blocked and out-of-scope surfaces/);
  assert.match(
    md,
    /\| Positive NAV, whitelist-admin, and fee-authority flows \| blocked \| Requires hard-coded vault NAV authority/
  );
  assert.match(
    md,
    /\| Legacy pay_fund_investors path \| not assessed \| New payout-session flow was prioritized/
  );
  assert.match(
    md,
    /Primary limit: Positive NAV, whitelist-admin, and fee-authority flows are blocked: Requires hard-coded vault NAV authority/
  );
  assert.match(
    md,
    /- \*\*Main limit:\*\* Positive NAV, whitelist-admin, and fee-authority flows are blocked: Requires hard-coded vault NAV authority/
  );
  assert.doesNotMatch(md, /No blocked, out-of-scope, or not-assessed flows are recorded/);
});

test("assess render: correctness shape with a finding renders it and no non-finding", () => {
  const model = buildFindingCorrectnessModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));

  assert.match(md, /### Finding 1: Unexpected error or panic/);
  assert.match(md, /No non-findings were recorded for this assessment\./);
});

test("assess render: correctness markdown is byte-deterministic across two renders", () => {
  const modelA = buildCleanCorrectnessModel();
  const modelB = buildCleanCorrectnessModel();
  const first = renderAssessmentMarkdown(modelA, generateAssessmentNarrative(modelA));
  const second = renderAssessmentMarkdown(modelB, generateAssessmentNarrative(modelB));
  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
});

test("assess render: correctness HTML mirrors the degrade — no heatmap widget, note present (R3.3)", () => {
  const model = buildCleanCorrectnessModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));
  const html = renderAssessmentHtml(md, model);

  // The note renders; no heatmap <figure> is built (the surface-less shape has none).
  assert.match(html, /correctness-dominated assessment/);
  assert.match(html, /<h2 class="rt-h2">Coverage &amp; Limits<\/h2>/);
  assert.match(html, /no signal in this campaign; not safety/);
  assert.doesNotMatch(html, /<figure class="rt-heatmap">/);
  assert.doesNotMatch(html, /Failure-rate heatmap<\/h3>/);
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

function extractSection(markdown: string, startHeading: string, endHeading: string): string {
  const start = markdown.indexOf(startHeading);
  assert.ok(start >= 0, `missing section ${startHeading}`);
  const end = markdown.indexOf(endHeading, start + startHeading.length);
  assert.ok(end > start, `missing end section ${endHeading}`);
  return markdown.slice(start, end);
}

import test from "node:test";
import assert from "node:assert/strict";

import { renderAssessmentHtml, markdownToHtml } from "../src/assess/render-html.js";
import { renderAssessmentMarkdown } from "../src/assess/render-markdown.js";
import { generateAssessmentNarrative } from "../src/assess/narrative.js";
import { buildCleanModel, loadFlagshipModel } from "./assess-fixture.js";

const OVERCLAIM = /guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety/i;

async function flagshipHtml(): Promise<string> {
  const model = await loadFlagshipModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));
  return renderAssessmentHtml(md, model);
}

test("assess html: emits a self-contained design-system document", async () => {
  const html = await flagshipHtml();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<style>/);
  // Riptide design tokens are embedded (no remote stylesheet).
  assert.match(html, /--rt-signal-cyan:#22F0E6/);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  // Markdown structure became styled HTML.
  assert.match(html, /<h1 class="rt-h1">Protocol assessment — whale-shock-cartography<\/h1>/);
  assert.match(html, /<h2 class="rt-h2">Executive summary<\/h2>/);
  assert.match(html, /<table class="rt-table">/);
  assert.match(html, /<pre class="rt-code">/);
});

test("assess html: renders the failure-rate heatmap visually from the model", async () => {
  const html = await flagshipHtml();
  assert.match(html, /<figure class="rt-heatmap">/);
  assert.match(html, /<table class="rt-hm-grid">/);
  // Axis labels: whale_share_bps rows (rank 1), shock_profile columns (rank 2).
  assert.match(html, /Rows: whale_share_bps \(rank 1\) · Columns: shock_profile \(rank 2\)/);
  // The flagship's worst cell is 100% → the most severe bucket must appear.
  assert.match(html, /rt-hm-b3/);
  // The visual grid replaces the markdown glyph heatmap rather than duplicating it.
  assert.doesNotMatch(html, /░|▒|▓|█/);
  assert.doesNotMatch(html, /Legend: <code class="rt-ic">░<\/code>/);
  // Per-cell failure-rate and run-count are shown.
  assert.match(html, /<span class="rt-hm-rate">/);
  assert.match(html, /<span class="rt-hm-n">n=/);
  // A legend rides along.
  assert.match(html, /rt-hm-legend/);
});

test("assess html: deterministic for a fixed model + markdown", async () => {
  const model = await loadFlagshipModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));
  assert.equal(renderAssessmentHtml(md, model), renderAssessmentHtml(md, model));
});

test("assess html: reviewer checklist becomes checkbox list items", async () => {
  const html = await flagshipHtml();
  assert.match(html, /<li class="rt-check"><span class="rt-box">☐<\/span>/);
});

test("assess html: clean model surface still renders a visual heatmap", () => {
  const model = buildCleanModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));
  const html = renderAssessmentHtml(md, model);
  assert.match(html, /<figure class="rt-heatmap">/);
  // All-passing runs → the safe bucket.
  assert.match(html, /rt-hm-b0/);
});

test("assess html: escapes angle brackets and is overclaim-grep clean outside the boundary", async () => {
  const html = await flagshipHtml();
  // The markdown's literal `<campaign.toml>` placeholders must be escaped, never raw tags.
  assert.match(html, /&lt;campaign\.toml&gt;/);
  for (const line of html.split("\n")) {
    if (!OVERCLAIM.test(line)) continue;
    const allowed = /\bnot\b/i.test(line) || /Audit signoff,/.test(line);
    assert.ok(allowed, `overclaim phrase outside boundary wording: ${JSON.stringify(line)}`);
  }
});

test("assess html: markdownToHtml converts a small table and bold/inline-code", () => {
  const md = [
    "## Heading",
    "",
    "A **bold** word and `code`.",
    "",
    "| A | B |",
    "| --- | --- |",
    "| one | two |",
    ""
  ].join("\n");
  const html = markdownToHtml(md);
  assert.match(html, /<h2 class="rt-h2">Heading<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code class="rt-ic">code<\/code>/);
  assert.match(html, /<table class="rt-table">/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<td>one<\/td>/);
});

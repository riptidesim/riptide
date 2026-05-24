import test from "node:test";
import assert from "node:assert/strict";

import { renderAssessmentHtml, markdownToHtml } from "../src/assess/render-html.js";
import { renderAssessmentMarkdown } from "../src/assess/render-markdown.js";
import { generateAssessmentNarrative } from "../src/assess/narrative.js";
import { buildCleanCorrectnessModel, buildCleanModel, loadFlagshipModel } from "./assess-fixture.js";

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

test("assess html: opens with a dedicated cover page carrying the brand, title, and metadata (R2)", async () => {
  const html = await flagshipHtml();
  // A dedicated cover section leads the document, built on the design-system tokens.
  assert.match(html, /<section class="rt-cover">/);
  assert.match(html, /<span class="rt-wordmark">RIPTIDE<\/span>/);
  // The report title (the lifted rt-h1) sits inside the cover…
  assert.match(
    html,
    /<section class="rt-cover">[\s\S]*<h1 class="rt-h1">Protocol assessment — whale-shock-cartography<\/h1>[\s\S]*<\/section>/
  );
  // …and is not duplicated in the body below the cover.
  assert.equal(html.match(/<h1 class="rt-h1">/g)?.length, 1);
  // The metadata strip carries the protocol, verdict, deterministic date, commit, and the boundary.
  assert.match(html, /<dl class="rt-cover-meta">/);
  assert.match(html, /<dt>Protocol<\/dt><dd>whale-shock-cartography<\/dd>/);
  assert.match(html, /<dt>Verdict<\/dt><dd>needs_campaign_tuning<\/dd>/);
  assert.match(html, /<dt>Date<\/dt><dd>2026-05-23<\/dd>/);
  assert.match(html, /<dt>Commit<\/dt><dd>not declared<\/dd>/);
  assert.match(html, /class="rt-cover-boundary"/);
  // The cover breaks to the body on the next page (R2.3).
  assert.match(html, /\.rt-cover\{[^}]*break-after:page/);
  // No remote asset / CDN dependency was introduced by the cover (R2.2).
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|cdn\./);
});

test("assess html: renders self-contained, deterministic on-brand cover art (R2.2)", async () => {
  const html = await flagshipHtml();
  // The cover art is an inline SVG motif (contours + node dots), no remote asset.
  assert.match(html, /<div class="rt-cover-art" aria-hidden="true"><svg class="rt-cover-svg"/);
  assert.match(html, /<polyline points="/);
  assert.match(html, /<radialGradient id="rtFlow"/);
  // On-palette only: teal + signal-cyan (the design-system tokens), no off-palette ink.
  assert.match(html, /stop-color="#22F0E6"/);
  assert.match(html, /stop-color="#14B8B6"/);
  // The Riptide mark rides the wordmark as inline SVG (echoing the logo).
  assert.match(html, /<svg class="rt-mark-svg"/);
  // Deterministic: the art carries no wall-clock / RNG seed, and re-rendering is identical.
  assert.doesNotMatch(html, /Date\.now|Math\.random/);
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

test("assess html: correctness 'no heatmap' note renders as a clean callout (R3.3)", () => {
  const model = buildCleanCorrectnessModel();
  const md = renderAssessmentMarkdown(model, generateAssessmentNarrative(model));
  const html = renderAssessmentHtml(md, model);
  // The Risk Surface heading stays, and its explanation is lifted into a callout.
  assert.match(html, /<h2 class="rt-h2">Risk Surface<\/h2>\n<aside class="rt-callout">/);
  assert.match(html, /<p class="rt-callout-title">No risk-surface heatmap<\/p>/);
  // The note text is preserved verbatim inside the callout body, not duplicated.
  assert.match(html, /<div class="rt-callout-body">\s*<p class="rt-body">This is a correctness-dominated assessment/);
  assert.equal(html.match(/correctness-dominated assessment/g)?.length, 1);
});

test("assess html: cartography heatmap is not wrapped in the no-heatmap callout (R3.3)", async () => {
  const html = await flagshipHtml();
  // The surface-bearing shape keeps its real heatmap figure and grows no callout
  // element (the callout CSS class is defined in <style> regardless).
  assert.doesNotMatch(html, /<aside class="rt-callout">/);
  assert.match(html, /<figure class="rt-heatmap">/);
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

test("assess html: avoids reproduction placeholders and is overclaim-grep clean outside the boundary", async () => {
  const html = await flagshipHtml();
  assert.doesNotMatch(html, /&lt;campaign\.toml&gt;|&lt;dir&gt;/);
  assert.match(html, /riptide assess tmp\/flagship-run\/campaign_40a5f239691a/);
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

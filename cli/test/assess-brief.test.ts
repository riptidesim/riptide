import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateAssessmentNarrative } from "../src/assess/narrative.js";
import { renderAssessmentBrief } from "../src/assess/render-brief.js";
import { runAssess } from "../src/commands/assess.js";
import {
  buildCleanCorrectnessModel,
  buildSweptStressModel,
  loadFlagshipModel,
  writeFlagshipRoot
} from "./assess-fixture.js";

const SECTION_HEADINGS = ["What we did", "What we found", "What to do", "Scope &amp; limits", "Reproduce"];
const KNOB_PHRASES = [/Keep `/, /keeping parameters/, /tune the campaign/];
const OVERCLAIM = /guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety/i;

function briefFor(model: Parameters<typeof renderAssessmentBrief>[0]): string {
  return renderAssessmentBrief(model, generateAssessmentNarrative(model));
}

test("assess brief: renders the five sections in order from the model", () => {
  const html = briefFor(buildSweptStressModel({ shape: "bounded" }));
  assert.match(html, /^<!DOCTYPE html>/);
  let cursor = -1;
  for (const heading of SECTION_HEADINGS) {
    const index = html.indexOf(`</span>${heading}</h2>`);
    assert.ok(index > cursor, `section "${heading}" missing or out of order`);
    cursor = index;
  }
  // Self-contained: no remote stylesheet, font, or image.
  assert.doesNotMatch(html, /<link[^>]+stylesheet|fonts\.googleapis\.com|src="https?:/);
});

test("assess brief: leads with what held before the finding", () => {
  const model = buildSweptStressModel({ shape: "bounded" });
  const html = briefFor(model);
  const held = html.indexOf('class="ic ok"');
  const finding = html.indexOf('class="ic warn"');
  assert.ok(held >= 0, "expected a held (non-finding) bullet");
  assert.ok(finding >= 0, "expected a finding bullet");
  assert.ok(held < finding, "the held bullet must precede the finding bullet");
  assert.match(html, /<b>Held — /);
  // The report-ordered "finding above" wording must be repositioned for the
  // held-first brief layout.
  assert.doesNotMatch(html, /the finding above/);
  assert.match(html, /the finding below/);
});

test("assess brief: a fixed-seed policy renders as prose, not the raw seed blob", () => {
  const model = buildSweptStressModel({ shape: "bounded" });
  const html = briefFor(model);
  assert.ok(model.campaign?.seed_policy.startsWith("fixed:"));
  assert.doesNotMatch(html, new RegExp(model.campaign!.seed_policy));
  assert.match(html, /under a fixed-seed policy\./);
  assert.match(html, /Deterministic execution under a fixed-seed policy/);
});

test("assess brief: non-fixed seed policies are not described as fixed-seed", () => {
  const model = buildSweptStressModel({ shape: "bounded" });
  model.campaign.seed_policy = "range:1000..1002";
  const html = briefFor(model);
  assert.match(html, /under the range:1000\.\.1002 seed policy\./);
  assert.match(html, /Deterministic execution under the range:1000\.\.1002 seed policy/);
  assert.doesNotMatch(html, /fixed-seed execution|under a fixed-seed policy/);
});

test("assess brief: guided-sim brief carries the resilience boundary, never knob phrasing", () => {
  for (const shape of ["bounded", "entire-region", "none"] as const) {
    const model = buildSweptStressModel({ shape });
    const narrative = generateAssessmentNarrative(model);
    const html = renderAssessmentBrief(model, narrative);
    for (const knob of KNOB_PHRASES) {
      assert.doesNotMatch(html, knob, `${shape}: knob phrasing leaked into the brief`);
    }
    // The What-to-do section quotes the model's recommendation statement verbatim
    // (modulo backtick → <code> rendering).
    const expected = narrative.recommendation.statement
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    assert.ok(html.includes(expected), `${shape}: recommendation statement missing`);
  }
});

test("assess brief: sources verdict, claim boundary, and reproduction from the model only", () => {
  const model = buildSweptStressModel({ shape: "bounded" });
  const html = briefFor(model);
  assert.match(html, new RegExp(`Verdict: <b>${model.verdict.value}</b> \\(${model.verdict.source}\\)`));
  assert.ok(html.includes("not audit signoff, formal verification, complete"), "claim boundary missing");
  for (const command of model.reproduction.commands) {
    assert.ok(html.includes(command.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")));
  }
  assert.ok(
    model.reproduction.hashes.surface_sha256 &&
      html.includes(model.reproduction.hashes.surface_sha256),
    "surface sha256 missing from the Reproduce section"
  );
});

test("assess brief: an --input editorial layer enriches Scope & limits automatically", () => {
  const boundary =
    "The price feed is driven deterministically; the oracle's own staleness guards are out of scope.";
  const model = buildSweptStressModel({
    shape: "bounded",
    inputs: { riskPlan: { guided_sim_boundaries: [boundary] } }
  });
  const html = briefFor(model);
  assert.ok(html.includes(boundary), "guided_sim_boundaries row missing from Scope & limits");
});

test("assess brief: byte-deterministic for a fixed model", async () => {
  const models = [
    buildSweptStressModel({ shape: "bounded" }),
    await loadFlagshipModel(),
    buildCleanCorrectnessModel()
  ];
  for (const model of models) {
    assert.equal(briefFor(model), briefFor(model));
  }
});

test("assess brief: correctness (surface-less) shape renders all five sections", () => {
  const html = briefFor(buildCleanCorrectnessModel());
  for (const heading of SECTION_HEADINGS) {
    assert.ok(html.includes(`</span>${heading}</h2>`), `section "${heading}" missing`);
  }
  assert.match(html, /guided-simulation evidence/);
});

test("assess brief: overclaim-grep clean outside the boundary wording", async () => {
  const html = briefFor(await loadFlagshipModel());
  for (const line of html.split("\n")) {
    if (!OVERCLAIM.test(line)) continue;
    assert.ok(/\bnot\b/i.test(line), `overclaim phrase outside boundary wording: ${JSON.stringify(line)}`);
  }
});

test("assess brief: runAssess --brief writes brief.html into the output dir, byte-identical across runs", async () => {
  const { root } = await writeFlagshipRoot();
  const sink = (): ((chunk: string) => void) => () => {};
  const outA = await mkdtemp(path.join(os.tmpdir(), "riptide-brief-a-"));
  const outB = await mkdtemp(path.join(os.tmpdir(), "riptide-brief-b-"));
  // brief.pdf is environment-dependent (it needs a local headless browser) and
  // excluded from the byte gate, so only brief.html — the deterministic
  // artifact — is asserted; the run must exit 0 either way.
  const deps = { stdoutWrite: sink(), stderrWrite: sink(), cwd: root };
  assert.equal(await runAssess(root, { brief: true, out: outA }, deps), 0);
  assert.equal(await runAssess(root, { brief: true, out: outB }, deps), 0);
  const briefA = await readFile(path.join(outA, "brief.html"), "utf8");
  const briefB = await readFile(path.join(outB, "brief.html"), "utf8");
  assert.ok(briefA.length > 0);
  assert.equal(briefA, briefB, "two --brief runs must produce a byte-identical brief.html");
});

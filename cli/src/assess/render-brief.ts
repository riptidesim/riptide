import type { AssessmentModel, AssessmentNarrative } from "./model.js";

type BriefSurfaceAxis = NonNullable<AssessmentModel["surface"]>["axes"][number];

/**
 * render-brief.ts — the one-page executive brief (sibling to `render-html.ts`).
 *
 * ## What this is
 *
 * A deterministic renderer that projects the canonical assessment model + its
 * narrative into the compact five-section one-pager a protocol team actually
 * reads: *What we did / What we found / What to do / Scope & limits /
 * Reproduce*. It is the digestible companion to the full `assessment.md`
 * report, not a replacement for it.
 *
 * ## No new facts
 *
 * Every content line is sourced from the model (verdict, findings,
 * non-findings, recommendation, claim boundary, reproduction commands, risk
 * plan) or the narrative derived from it. The renderer adds layout and fixed
 * template prose only — it never invents protocol facts, figures, or advice
 * the model does not carry, so a richer `--input` enriches the brief
 * automatically.
 *
 * ## Lead with what held
 *
 * "What we found" renders non-findings (what held, with their bounds) before
 * findings, so the brief opens on the evidence-backed positive result instead
 * of burying it under the finding.
 *
 * ## NOT under the byte-hash gate, but byte-deterministic
 *
 * Like `assessment.html`, `brief.html` is a presentation export outside the
 * canonical `assessment.json`/`assessment.md` byte gate. The render is
 * nonetheless pure and stable for a fixed `(model, narrative)` pair — no
 * wall-clock, randomness, or insertion-order dependence — so two runs over the
 * same campaign root produce byte-identical `brief.html`. The PDF rendered
 * from it is excluded from byte checks (PDF engines are not byte-stable).
 */
export function renderAssessmentBrief(model: AssessmentModel, narrative: AssessmentNarrative): string {
  const title = `Protocol assessment — ${model.protocol.name}`;
  const sections = [
    section(1, "What we did", whatWeDid(model)),
    section(2, "What we found", whatWeFound(narrative)),
    section(3, "What to do", whatToDo(narrative)),
    section(4, "Scope & limits", scopeAndLimits(model, narrative)),
    section(5, "Reproduce", reproduce(model))
  ];

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(`Riptide — Brief: ${model.protocol.name}`)}</title>`,
    `<style>${STYLES}</style>`,
    "</head>",
    "<body>",
    '<div class="wrap">',
    '<div class="brand"><span class="dot"></span><b>Riptide</b></div>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="sub">${subline(model)}</p>`,
    ...sections,
    `<div class="foot">Riptide · economic stress testing for Solana protocols · simulation evidence over the declared region, not an audit.</div>`,
    "</div>",
    "</body>",
    "</html>",
    ""
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function subline(model: AssessmentModel): string {
  const parts = ["Executive brief · simulation evidence over the declared region"];
  if (model.protocol.assessment_date) parts.push(escapeHtml(model.protocol.assessment_date));
  parts.push(`Verdict: <b>${escapeHtml(model.verdict.value)}</b> (${escapeHtml(model.verdict.source)})`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// 1 — What we did
// ---------------------------------------------------------------------------

function whatWeDid(model: AssessmentModel): string[] {
  if (!model.campaign || !model.totals) return correctnessWhatWeDid(model);

  const campaign = model.campaign;
  const totals = model.totals;
  const guidedSim = campaign.adapter === "guided-sim";
  const ran = guidedSim
    ? `We ran <b>Riptide</b> — an economic stress-testing tool for Solana programs — as a guided-simulation ` +
      `sweep against <b>${escapeHtml(model.protocol.name)}</b>: <code>${escapeHtml(campaign.name)}</code> ` +
      `(${escapeHtml(campaign.class)}) completed ${totals.completed_runs} of ${totals.requested_runs} swept ` +
      `iteration(s) under ${seedPolicyPhrase(campaign.seed_policy)}.`
    : `We ran <b>Riptide</b> — an economic stress-testing tool for Solana programs — against ` +
      `<b>${escapeHtml(model.protocol.name)}</b> over the <code>${escapeHtml(campaign.name)}</code> ` +
      `(${escapeHtml(campaign.class)}) campaign: ${totals.completed_runs} of ${totals.requested_runs} ` +
      `requested run(s) completed under ${seedPolicyPhrase(campaign.seed_policy)}.`;

  const bullets = [
    `Risk objective: ${inlineBrief(campaign.risk_objective)}`,
    ...(model.surface?.axes ?? []).map(sweepAxisBullet),
    ...guidedSimExplanationBullets(model),
    reproducibilityPhrase(campaign.seed_policy)
  ];
  return [paragraph(ran), bulletList(bullets.map((text) => bullet("mut", "›", text)))];
}

function sweepAxisBullet(axis: BriefSurfaceAxis): string {
  const first = axis.bins[0]?.label ?? "";
  const last = axis.bins[axis.bins.length - 1]?.label ?? "";
  const unit = axis.unit ? ` ${escapeHtml(axis.unit)}` : "";
  const meaning = describeAxisMeaning(axis);
  return `Swept <code>${escapeHtml(axis.name)}</code>${meaning} across ${escapeHtml(first)}–${escapeHtml(last)}${unit}.`;
}

function guidedSimExplanationBullets(model: AssessmentModel): string[] {
  if (model.campaign?.adapter !== "guided-sim") return [];
  const axisCount = model.surface?.axes.length ?? 0;
  const cellCount = model.surface?.axes.reduce((count, axis) => count + axis.bins.length, 0) ?? 0;
  const runsPerCell = uniformRunCountPerStressCell(model);
  const flows = model.risk_plan.p0_flows.slice(0, 5);
  return [
    ...(axisCount > 0 && model.totals
      ? [
          `This was a custom guided-simulation stress sweep, not a catalog scenario: Riptide varied ` +
            `the named axis as an applied stress across ${cellCount} stress cell(s)` +
            `${runsPerCell === null ? "" : ` (${runsPerCell} iteration(s) per cell)`}, then reported invariant failure rates from ` +
            `${model.totals.completed_runs} completed iteration(s).`
        ]
      : []),
    ...(flows.length > 0
      ? [`Lifecycle under test: ${flows.map((flow) => `<code>${escapeHtml(flow)}</code>`).join(", ")}.`]
      : []),
    `A fired invariant is the declared risk signal for that stress cell; it is not audit signoff or a claim about untested flows.`
  ];
}

function describeAxisMeaning(axis: BriefSurfaceAxis): string {
  const notes = [
    humanizeAxisName(axis.name, axis.unit),
    ...(isBasisPointAxis(axis) ? ["100 bps = 1.00%"] : []),
    shockAxisNote(axis.name)
  ].filter(Boolean);
  return notes.length > 0 ? ` (${escapeHtml(notes.join("; "))})` : "";
}

function humanizeAxisName(name: string, unit?: string): string {
  const parts = name
    .split(/[_\-\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return unit ? unit.toLowerCase() : "";
  const endsWithBps = parts[parts.length - 1] === "bps";
  const words = endsWithBps ? parts.slice(0, -1) : parts;
  const phrase = words.join(" ");
  if (endsWithBps || unit?.toLowerCase() === "bps") return phrase ? `${phrase} in basis points` : "basis points";
  return phrase;
}

function isBasisPointAxis(axis: BriefSurfaceAxis): boolean {
  return axis.unit?.toLowerCase() === "bps" || /(^|[_\-\s])bps($|[_\-\s])/.test(axis.name.toLowerCase());
}

function shockAxisNote(name: string): string {
  const normalized = name.toLowerCase();
  if (!/(^|[_\-\s])shock($|[_\-\s])/.test(normalized)) return "";
  return /(^|[_\-\s])rate($|[_\-\s])/.test(normalized)
    ? "shock means a sudden applied move in the modeled rate/index"
    : "shock means a sudden applied change to the modeled input";
}

function uniformRunCountPerStressCell(model: AssessmentModel): number | null {
  const populatedCells = model.surface?.cells.filter((cell) => cell.run_count > 0) ?? [];
  if (populatedCells.length === 0) return null;
  const counts = new Set(populatedCells.map((cell) => cell.run_count));
  return counts.size === 1 ? populatedCells[0]!.run_count : null;
}

/**
 * The seed policy as one-page prose. A `fixed:<seed>` policy can carry a
 * 64-char seed that would swamp the lead sentence; the exact seed stays in the
 * campaign artifacts the Reproduce section points back to.
 */
function seedPolicyPhrase(seedPolicy: string): string {
  return seedPolicy.startsWith("fixed:")
    ? "a fixed-seed policy"
    : `the ${escapeHtml(seedPolicy)} seed policy`;
}

function reproducibilityPhrase(seedPolicy?: string): string {
  if (!seedPolicy) return "Deterministic execution — reproduce byte-for-byte with the commands in section 5.";
  return seedPolicy.startsWith("fixed:")
    ? "Deterministic execution under a fixed-seed policy — reproduce byte-for-byte with the commands in section 5."
    : `Deterministic execution under the ${escapeHtml(seedPolicy)} seed policy — reproduce byte-for-byte with the commands in section 5.`;
}

function correctnessWhatWeDid(model: AssessmentModel): string[] {
  const gs = model.correctness?.guided_sim ?? null;
  const ran = gs
    ? `We ran <b>Riptide</b> — an economic stress-testing tool for Solana programs — against ` +
      `<b>${escapeHtml(model.protocol.name)}</b> with guided-simulation evidence: ${gs.flows} flow(s) across ` +
      `${gs.iterations} iteration(s) — ${gs.tx_success} transaction success(es), ${gs.expected_errors} ` +
      `expected rejection(s).`
    : `<b>${escapeHtml(model.protocol.name)}</b> was assessed for correctness, but no guided-sim evidence was ingested.`;
  const bullets = [
    ...(gs ? [`Evidence: <code>${escapeHtml(gs.path)}</code> (status ${escapeHtml(gs.status)}).`] : []),
    reproducibilityPhrase()
  ];
  return [paragraph(ran), bulletList(bullets.map((text) => bullet("mut", "›", text)))];
}

// ---------------------------------------------------------------------------
// 2 — What we found (non-findings lead: what held comes first)
// ---------------------------------------------------------------------------

function whatWeFound(narrative: AssessmentNarrative): string[] {
  const held = narrative.non_findings.map((entry) => {
    // The narrative's limit strings position the finding "above" (report
    // ordering); the brief leads with what held, so the finding sits below.
    const limit =
      narrative.findings.length > 0 ? entry.limit.replace(/the finding above/g, "the finding below") : entry.limit;
    return bullet(
      "ok",
      "✓",
      `<b>Held — ${inlineBrief(entry.flow)}.</b> ${inlineBrief(entry.statement)} ` +
        `<span class="mut">${inlineBrief(limit)}</span>`
    );
  });
  const fired = narrative.findings.map((entry) =>
    bullet("warn", "▲", `<b>${inlineBrief(entry.title)}.</b> ${inlineBrief(entry.observed)}`)
  );
  return [bulletList([...held, ...fired])];
}

// ---------------------------------------------------------------------------
// 3 — What to do
// ---------------------------------------------------------------------------

function whatToDo(narrative: AssessmentNarrative): string[] {
  const items = [narrative.recommendation.statement];
  for (const finding of narrative.findings) {
    if (finding.recommended && !items.includes(finding.recommended)) items.push(finding.recommended);
  }
  return [bulletList(items.map((text, index) => bullet("key", String(index + 1), inlineBrief(text))))];
}

// ---------------------------------------------------------------------------
// 4 — Scope & limits
// ---------------------------------------------------------------------------

function scopeAndLimits(model: AssessmentModel, narrative: AssessmentNarrative): string[] {
  const bullets = [
    ...model.risk_plan.guided_sim_boundaries.map((boundary) => inlineBrief(boundary)),
    inlineBrief(narrative.main_limit)
  ];
  return [
    `<p class="mut">${inlineBrief(model.claim_boundary)}</p>`,
    bulletList(bullets.map((text) => bullet("mut", "›", text)))
  ];
}

// ---------------------------------------------------------------------------
// 5 — Reproduce
// ---------------------------------------------------------------------------

function reproduce(model: AssessmentModel): string[] {
  const hashes = [
    ...(model.reproduction.hashes.surface_sha256
      ? [`risk-surface.json sha256 ${model.reproduction.hashes.surface_sha256}`]
      : []),
    ...(model.reproduction.hashes.campaign_digest
      ? [`campaign digest ${model.reproduction.hashes.campaign_digest}`]
      : [])
  ];
  const trailer = [
    ...(model.protocol.repository ? [`Protocol repository: <b>${escapeHtml(model.protocol.repository)}</b>.`] : []),
    "The full technical report (<code>assessment.md</code>, <code>assessment.json</code>) accompanies this brief."
  ];
  return [
    `<div class="repro">${model.reproduction.commands.map(escapeHtml).join("\n")}</div>`,
    ...(hashes.length > 0 ? [`<p class="mut hashes">${hashes.map(escapeHtml).join(" · ")}</p>`] : []),
    `<p class="mut">${trailer.join(" ")}</p>`
  ];
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function section(index: number, heading: string, body: string[]): string {
  return [`<h2><span class="n">${index}</span>${escapeHtml(heading)}</h2>`, ...body].join("\n");
}

function paragraph(html: string): string {
  return `<p>${html}</p>`;
}

function bulletList(items: string[]): string {
  return ["<ul>", ...items, "</ul>"].join("\n");
}

function bullet(iconClass: string, icon: string, html: string): string {
  return `<li><span class="ic ${iconClass}">${escapeHtml(icon)}</span>${html}</li>`;
}

/** Escape, then render model-string backtick spans as inline code. */
function inlineBrief(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Styles — compact one-page layout, Riptide teal accent, self-contained
// ---------------------------------------------------------------------------

const STYLES = `
@page { size: A4; margin: 12mm 13mm; }
*{box-sizing:border-box}
body{margin:0;color:#1a1a2e;background:#fff;font:13px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:26px 28px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:2px}
.dot{width:11px;height:11px;border-radius:50%;background:#14B8B6}
.brand b{font-size:12px;letter-spacing:.5px;color:#0E7490;text-transform:uppercase}
h1{font-size:22px;margin:5px 0 2px}
.sub{color:#6b7280;margin:0 0 16px;font-size:12.5px}
.sub b{color:#0E7490}
h2{font-size:15px;margin:16px 0 6px;color:#111}
h2 .n{color:#14B8B6;font-weight:800;margin-right:8px}
p{margin:5px 0}
ul{margin:4px 0 4px 2px;padding:0;list-style:none}
li{margin:6px 0;padding-left:24px;position:relative}
li .ic{position:absolute;left:0;top:0;font-weight:700}
.ok{color:#15803d}.warn{color:#b45309}.key{color:#0E7490}
.mut{color:#6b7280}
code{background:#ecfbfa;color:#0E7490;padding:1px 5px;border-radius:5px;font-size:11.5px}
.repro{background:#0f1117;color:#e6edf3;border-radius:10px;padding:10px 14px;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;overflow-x:auto}
.hashes{font:10.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.foot{margin-top:16px;border-top:1px solid #eee;padding-top:9px;color:#6b7280;font-size:11.5px}
b{color:#111}
@media print{.wrap{padding:0;max-width:none}body{font-size:12.4px;line-height:1.42}h2{margin:11px 0 5px}li{margin:4px 0}.sub{margin-bottom:12px}.foot{margin-top:10px}}
`.trim();

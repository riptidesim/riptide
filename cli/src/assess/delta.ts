// The Delta: what changed between two Assessments of the same declared region
// in one Workspace. The Engine computes it from the Engine Output and the
// Assessment Context of both, so it is deterministic and never agent-written;
// the Skill copies it into the new Assessment Context verbatim, and the gate
// recomputes it on a rerun.

import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  ASSESSMENT_CONTEXT_FILE,
  COMPOSED_REPORT_FILE,
  checkContext,
  checkEngineOutput,
  readOptional,
  reportHeadings,
  sectionBody,
  type AssessmentContext
} from "./context.js";
import type { AssessmentModel } from "./model.js";
import { canonicalJson, type JsonValue } from "../state-pack/json.js";
import type { CommandError } from "../contract/index.js";

export type MetricValue = string | number | boolean | null;

export interface MetricMove {
  metric: string;
  previous: MetricValue;
  current: MetricValue;
}

export type Delta = NonNullable<AssessmentContext["delta"]>;

/** An Assessment directory whose Engine Output is intact and whose Assessment Context is valid. */
export interface LoadedAssessment {
  /** The directory's own name, which the Delta records as `previous`. */
  name: string;
  label: string;
  model: AssessmentModel;
  context: AssessmentContext;
}

export async function loadAssessment(
  dir: string,
  label: string,
  rerun: string
): Promise<{ ok: true; assessment: LoadedAssessment } | { ok: false; problems: CommandError[] }> {
  const problems: CommandError[] = [];
  const at = { dir, label, rerun };
  const model = await checkEngineOutput(at, problems);
  const context = await checkContext(at, problems);
  if (problems.length > 0 || model === null || context === null) return { ok: false, problems };
  return { ok: true, assessment: { name: path.basename(dir), label, model, context } };
}

/**
 * The declared region an Assessment ran: its Depth and what the Engine Output
 * says was swept (axes, bins, seed policy and run budget), or, for a
 * correctness Assessment, how many guided-sim iterations ran.
 */
export function regionOf({ model, context }: LoadedAssessment): JsonValue {
  const probed = model.coverage_statement.probed;
  if (probed.kind === "swept-gradient") {
    return {
      depth: context.depth,
      shape: "cartography",
      seed_policy: probed.seed_policy,
      run_budget: probed.run_budget,
      axes: probed.axes.map((axis) => ({
        axis: axis.axis,
        range: axis.range as unknown as JsonValue,
        granularity: axis.granularity as unknown as JsonValue
      }))
    };
  }
  return { depth: context.depth, shape: "correctness", iterations: probed.guided_sim?.iterations ?? null };
}

export function sameRegion(a: LoadedAssessment, b: LoadedAssessment): boolean {
  return canonicalJson(regionOf(a)) === canonicalJson(regionOf(b));
}

/** Compare two Assessments of the same region. Every list is sorted, so equal inputs give equal bytes. */
export function computeDelta(previous: LoadedAssessment, current: LoadedAssessment): Delta {
  const before = metricsOf(previous);
  const after = metricsOf(current);
  const metric_moves = [...new Set([...before.keys(), ...after.keys()])]
    .sort(byCodePoint)
    .map((metric) => ({ metric, previous: before.get(metric) ?? null, current: after.get(metric) ?? null }))
    .filter((move) => move.previous !== move.current);

  const gapsBefore = new Set(previous.context.gaps.map((gap) => gap.subject));
  const gapsAfter = new Set(current.context.gaps.map((gap) => gap.subject));
  const known = new Set(instructionsOf(previous.context));
  const exercised = new Set(current.context.coverage.instructions.exercised);

  return {
    previous: previous.name,
    metric_moves,
    gaps_opened: [...gapsAfter].filter((subject) => !gapsBefore.has(subject)).sort(byCodePoint),
    gaps_closed: [...gapsBefore].filter((subject) => !gapsAfter.has(subject)).sort(byCodePoint),
    new_instructions: instructionsOf(current.context)
      .filter((instruction) => !known.has(instruction))
      .sort(byCodePoint)
      .map((instruction) => ({ instruction, exercised: exercised.has(instruction) }))
  };
}

/** The figures a Delta compares, keyed by a stable metric name. */
function metricsOf({ model, context }: LoadedAssessment): Map<string, MetricValue> {
  const metrics = new Map<string, MetricValue>();
  metrics.set("verdict", model.verdict.value);
  for (const [field, value] of Object.entries(model.totals ?? {})) metrics.set(`totals.${field}`, value);

  if (model.surface && model.surface_highlights) {
    metrics.set("surface.worst_cell_failure_rate", model.surface_highlights.worst_cell_failure_rate);
    metrics.set("surface.safe_region_status", model.surface_highlights.safe_region_status);
    const labels = new Map(model.surface.axes.map((axis) => [axis.name, axis.bins.map((bin) => bin.label)]));
    for (const cell of model.surface.cells) {
      const coords = cell.coords.map((coord) => `${coord.axis}=${labels.get(coord.axis)?.[coord.bin_index]}`);
      const key = `cell[${coords.join(",")}]`;
      metrics.set(`${key}.invariant_failure_rate`, cell.invariant_failure_rate);
      for (const [metric, stats] of Object.entries(cell.metrics)) {
        metrics.set(`${key}.${metric}.p10`, stats.p10);
        metrics.set(`${key}.${metric}.p50`, stats.p50);
        metrics.set(`${key}.${metric}.p90`, stats.p90);
      }
    }
  }

  const guidedSim = model.correctness?.guided_sim;
  if (guidedSim) {
    for (const field of ["iterations", "flows", "tx_success", "expected_errors", "unexpected_errors", "errors", "panics"] as const) {
      metrics.set(`guided_sim.${field}`, guidedSim[field]);
    }
    for (const { flow, count } of guidedSim.flow_counts) metrics.set(`flow[${flow}].count`, count);
  }

  for (const inv of context.invariants) metrics.set(`invariant[${inv.id}].outcome`, inv.outcome);
  return metrics;
}

function instructionsOf(context: AssessmentContext): string[] {
  return [...context.coverage.instructions.exercised, ...context.coverage.instructions.not_exercised];
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The rerun half of the gate. Assessments in one Workspace sit side by side
 * under names that sort in the order they were written; when an earlier one
 * ran the same region, this one must carry the Engine's Delta against the
 * latest such Assessment, verbatim, and its report a `## Delta` section.
 */
export async function checkRerunDelta(dir: string, label: string, problems: CommandError[]): Promise<void> {
  const rerun = `then rerun \`riptide validate ${label} --json\``;
  const loaded = await loadAssessment(dir, label, rerun);
  // An invalid Assessment is already reported by the rest of the gate.
  if (!loaded.ok) return;
  const current = loaded.assessment;
  const previous = await previousOverSameRegion(dir, label, current);
  const recorded = current.context.delta;

  if (recorded === undefined) {
    if (previous !== null) {
      problems.push({
        code: "validate_delta_missing",
        message: `${label} reruns the region of Assessment ${previous.name} but its Assessment Context has no Delta`,
        next:
          `run \`riptide delta ${previous.label} ${label} --json\`, copy data.delta into the Assessment Context ` +
          `as "delta" and add a \`## Delta\` section, ${rerun}`
      });
    }
    return;
  }

  if (previous === null || recorded.previous !== previous.name) {
    problems.push({
      code: "validate_delta_previous_mismatch",
      message:
        previous === null
          ? `${label} records a Delta against ${recorded.previous}, but no earlier Assessment beside it ran the same region`
          : `${label} records a Delta against ${recorded.previous}, but the latest earlier Assessment over the same region is ${previous.name}`,
      next:
        previous === null
          ? `remove "delta" from the Assessment Context and the \`## Delta\` section, ${rerun}`
          : `run \`riptide delta ${previous.label} ${label} --json\` and copy data.delta into the Assessment Context, ${rerun}`
    });
  } else if (canonicalJson(recorded as unknown as JsonValue) !== canonicalJson(computeDelta(previous, current) as unknown as JsonValue)) {
    problems.push({
      code: "validate_delta_mismatch",
      message: `${label} records a Delta that differs from the Engine's comparison with Assessment ${previous.name}`,
      next: `never edit the Delta: run \`riptide delta ${previous.label} ${label} --json\` and copy data.delta verbatim, ${rerun}`
    });
  }

  const report = await readOptional(path.join(dir, COMPOSED_REPORT_FILE));
  if (report !== null) checkDeltaSection(report, recorded.previous, rerun, problems);
}

/** The latest Assessment beside `dir`, named before it, that ran the same region; null when there is none. */
async function previousOverSameRegion(
  dir: string,
  label: string,
  current: LoadedAssessment
): Promise<LoadedAssessment | null> {
  const parent = path.dirname(dir);
  const earlier = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name < current.name)
    .map((entry) => entry.name)
    .sort(byCodePoint)
    .reverse();
  for (const name of earlier) {
    if ((await readOptional(path.join(parent, name, ASSESSMENT_CONTEXT_FILE))) === null) continue;
    const loaded = await loadAssessment(path.join(parent, name), path.join(path.dirname(label), name), "");
    if (loaded.ok && sameRegion(loaded.assessment, current)) return loaded.assessment;
  }
  return null;
}

/** With a Delta, `## Delta` sits after `## Invariants` (and `## Breaches`), before `## Engine Output`, naming the previous Assessment. */
function checkDeltaSection(markdown: string, previous: string, rerun: string, problems: CommandError[]): void {
  const headings = reportHeadings(markdown);
  const at = headings.indexOf("Delta");
  if (at === -1) {
    problems.push({
      code: "validate_report_section_missing",
      message: `${COMPOSED_REPORT_FILE} has no \`## Delta\` section, but the Assessment Context records a Delta`,
      next: `add \`## Delta\` after \`## Invariants\` and any \`## Breaches\`, before \`## Engine Output\`, ${rerun}`
    });
    return;
  }
  const after = Math.max(headings.indexOf("Invariants"), headings.indexOf("Breaches"));
  if (!(at > after && at < headings.indexOf("Engine Output"))) {
    problems.push({
      code: "validate_report_section_order",
      message: `${COMPOSED_REPORT_FILE} \`## Delta\` must sit after \`## Invariants\` and any \`## Breaches\`, before \`## Engine Output\``,
      next: `move \`## Delta\` directly before \`## Engine Output\`, ${rerun}`
    });
  }
  if (!sectionBody(markdown, "Delta").includes(previous)) {
    problems.push({
      code: "validate_report_delta_unlinked",
      message: `${COMPOSED_REPORT_FILE} \`## Delta\` does not name the previous Assessment ${previous}`,
      next: `name Assessment ${previous} under \`## Delta\` with the metric moves, Gaps opened and closed, and new instructions, ${rerun}`
    });
  }
}

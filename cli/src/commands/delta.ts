// `riptide delta <previous-dir> <current-dir>` — the deterministic comparison
// of two Assessments of the same declared region. The Skill copies `data.delta`
// into the rerun's Assessment Context; `riptide validate` recomputes it.

import path from "node:path";

import { Command } from "commander";

import { computeDelta, loadAssessment, regionOf, sameRegion, type Delta } from "../assess/delta.js";
import {
  errorEnvelope,
  oneLineMessage,
  renderEnvelope,
  resolveCommandIO,
  successEnvelope,
  type CommandError,
  type CommandIO
} from "../contract/index.js";

export interface DeltaOptions {
  json?: boolean;
}

export function createDeltaCommand(deps: CommandIO = {}): Command {
  return new Command("delta")
    .description("Compare an Assessment with the previous Assessment of the same region in the Workspace")
    .argument("<previous-dir>", "Directory of the previous Assessment")
    .argument("<current-dir>", "Directory of the Assessment that reruns its region")
    .option("--json", "Emit the result as a command envelope", false)
    .action(async (previous: string, current: string, options: DeltaOptions) => {
      const exitCode = await runDelta(previous, current, options, deps);
      process.exit(exitCode);
    });
}

export async function runDelta(
  previousDir: string,
  currentDir: string,
  options: DeltaOptions,
  deps: CommandIO = {}
): Promise<number> {
  const { stdout, stderr, cwd } = resolveCommandIO(deps);
  const labelOf = (dir: string) => path.relative(cwd, path.resolve(cwd, dir)) || ".";
  const previousLabel = labelOf(previousDir);
  const currentLabel = labelOf(currentDir);
  const rerun = `then rerun \`riptide delta ${previousLabel} ${currentLabel} --json\``;

  const fail = (error: CommandError, data?: Record<string, unknown>): number => {
    if (options.json) stdout(renderEnvelope(errorEnvelope("delta", error, data)));
    else stderr(`riptide delta: ${error.message}\n  next: ${error.next}\n`);
    return 1;
  };

  try {
    if (path.resolve(cwd, previousDir) === path.resolve(cwd, currentDir)) {
      return fail({
        code: "delta_same_assessment",
        message: `${previousLabel} is compared with itself`,
        next: "pass the previous Assessment's directory first and the rerun's directory second"
      });
    }

    const [previous, current] = await Promise.all([
      loadAssessment(path.resolve(cwd, previousDir), previousLabel, rerun),
      loadAssessment(path.resolve(cwd, currentDir), currentLabel, rerun)
    ]);
    if (!previous.ok || !current.ok) {
      const invalid = previous.ok ? currentLabel : previousLabel;
      const problems = [...(previous.ok ? [] : previous.problems), ...(current.ok ? [] : current.problems)];
      return fail(
        {
          code: "delta_assessment_invalid",
          message: `${invalid} is not a complete Assessment: ${problems[0]!.message}`,
          next: problems[0]!.next
        },
        { problems }
      );
    }

    const before = previous.assessment;
    const after = current.assessment;
    if (!sameRegion(before, after)) {
      return fail(
        {
          code: "delta_region_mismatch",
          message: `${currentLabel} ran a different region from ${previousLabel}; a Delta compares one region only`,
          next:
            `rerun the region the previous Assessment declared (its Depth, sweep axes, values and seeds), ` +
            `or deliver ${currentLabel} as the first Assessment of a new region, with no Delta`
        },
        { previous_region: regionOf(before), current_region: regionOf(after) }
      );
    }

    const delta = computeDelta(before, after);
    if (options.json) {
      stdout(
        renderEnvelope(
          successEnvelope("delta", {
            schema_version: "delta-cli.v1",
            previous: { assessment_dir: previousLabel, assessment_digest: before.model.assessment_digest },
            current: { assessment_dir: currentLabel, assessment_digest: after.model.assessment_digest },
            region: regionOf(after),
            delta
          })
        )
      );
    } else {
      stdout(renderHuman(previousLabel, currentLabel, delta));
    }
    return 0;
  } catch (error) {
    const failure: CommandError = {
      code: "delta_failed",
      message: oneLineMessage(error instanceof Error ? error.message : String(error)),
      next: `check that both Assessment directories and their files are readable, ${rerun}`
    };
    if (options.json) stdout(renderEnvelope(errorEnvelope("delta", failure)));
    else stderr(`riptide delta: ${failure.message}\n  next: ${failure.next}\n`);
    return 2;
  }
}

function renderHuman(previous: string, current: string, delta: Delta): string {
  const list = (items: string[]) => (items.length > 0 ? items.join(", ") : "none");
  return [
    `riptide delta: ${previous} → ${current}`,
    ...delta.metric_moves.map(
      (move) => `  ${move.metric}: ${JSON.stringify(move.previous)} → ${JSON.stringify(move.current)}`
    ),
    `  gaps opened: ${list(delta.gaps_opened)}`,
    `  gaps closed: ${list(delta.gaps_closed)}`,
    `  new instructions: ${list(
      delta.new_instructions.map((entry) => `${entry.instruction} (${entry.exercised ? "exercised" : "not exercised"})`)
    )}`,
    ""
  ].join("\n");
}
